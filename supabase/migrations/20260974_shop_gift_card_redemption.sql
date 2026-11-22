-- Gift cards, step 2 (server side): a gift card code can pay for part or all of
-- an order. The server re-checks the card, takes the amount off its balance in
-- the same transaction as the order, and logs it. Cancelling, rejecting or
-- refunding an order puts the amount back (and re-opening it takes it again),
-- using the same stock_deducted switch the discount codes already use.
--
-- Orders get gift_card_id / gift_card_code / gift_card_amount. What the shopper
-- still owes is: subtotal - discount + delivery - gift card. When a card covers
-- everything, the order is marked paid straight away and no proof is needed.

alter table public.shop_orders
  add column if not exists gift_card_id uuid references public.shop_gift_cards(id) on delete set null,
  add column if not exists gift_card_code text,
  add column if not exists gift_card_amount numeric(10,2) not null default 0;

-- "Apply" button: is this card usable, and how much is on it?
create or replace function public.shop_check_gift_card(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare c public.shop_gift_cards;
begin
  select * into c from public.shop_gift_cards where upper(code) = upper(btrim(coalesce(p_code, '')));
  if not found or not c.active or c.balance <= 0 or (c.expires_at is not null and c.expires_at < now()) then
    perform pg_sleep(0.4);
    return jsonb_build_object('valid', false, 'message', 'That gift card isn''t valid, has expired or has no balance left.');
  end if;
  return jsonb_build_object('valid', true, 'code', c.code, 'balance', c.balance);
end;
$$;
revoke all on function public.shop_check_gift_card(text) from public;
grant execute on function public.shop_check_gift_card(text) to anon, authenticated;

do $patch$
declare
  v text;
  v_old text;
begin
  -- ── place_shop_order: new optional p_gift_code argument ────────────────
  v := pg_get_functiondef('public.place_shop_order(jsonb,text,text,text,text,text,text,jsonb,text)'::regprocedure);

  v_old := 'p_discount_code text DEFAULT NULL::text)';
  if position(v_old in v) = 0 then raise exception 'place_shop_order patch 1 failed'; end if;
  v := replace(v, v_old, 'p_discount_code text DEFAULT NULL::text, p_gift_code text DEFAULT NULL::text)');

  v_old := E'  v_vname text;\nbegin';
  if position(v_old in v) = 0 then raise exception 'place_shop_order patch 2 failed'; end if;
  v := replace(v, v_old, E'  v_vname text;\n  v_gcode text := upper(btrim(coalesce(p_gift_code, '''')));\n  v_card public.shop_gift_cards;\n  v_gift numeric := 0;\n  v_due numeric;\nbegin');

  v_old := E'  if p_method = ''manual_proof'' and coalesce(p_proof_path, '''') = '''' then\n    raise exception ''Attach your proof of payment.'' using errcode = ''22023'';\n  end if;\n';
  if position(v_old in v) = 0 then raise exception 'place_shop_order patch 3 failed'; end if;
  v := replace(v, v_old, '');

  v_old := E'  v_status := case when p_method = ''whatsapp'' then ''whatsapp_sent'' else ''pending_review'' end;';
  if position(v_old in v) = 0 then raise exception 'place_shop_order patch 4 failed'; end if;
  v := replace(v, v_old, E'  if v_gcode <> '''' then\n    select * into v_card from public.shop_gift_cards where upper(code) = v_gcode for update;\n    if not found or not v_card.active or v_card.balance <= 0 or (v_card.expires_at is not null and v_card.expires_at < now()) then\n      raise exception ''That gift card isn''''t valid, has expired or has no balance left.'' using errcode = ''P0001'';\n    end if;\n    v_gift := least(v_card.balance, v_total - v_discount + v_fee);\n  end if;\n  v_due := v_total - v_discount + v_fee - v_gift;\n  if p_method = ''manual_proof'' and v_due > 0 and coalesce(p_proof_path, '''') = '''' then\n    raise exception ''Attach your proof of payment.'' using errcode = ''22023'';\n  end if;\n\n  v_status := case when v_due <= 0 then ''paid'' when p_method = ''whatsapp'' then ''whatsapp_sent'' else ''pending_review'' end;');

  v_old := E'    discount_code, discount_amount\n  ) values (';
  if position(v_old in v) = 0 then raise exception 'place_shop_order patch 5 failed'; end if;
  v := replace(v, v_old, E'    discount_code, discount_amount, gift_card_id, gift_card_code, gift_card_amount\n  ) values (');

  v_old := E'    case when v_discount > 0 then v_disc.code else null end, v_discount\n  ) returning * into v_order;';
  if position(v_old in v) = 0 then raise exception 'place_shop_order patch 6 failed'; end if;
  v := replace(v, v_old, E'    case when v_discount > 0 then v_disc.code else null end, v_discount,\n    case when v_gift > 0 then v_card.id else null end, case when v_gift > 0 then v_card.code else null end, v_gift\n  ) returning * into v_order;');

  v_old := E'  for v_line in select * from jsonb_array_elements(v_lines) loop';
  if position(v_old in v) = 0 then raise exception 'place_shop_order patch 7 failed'; end if;
  v := replace(v, v_old, E'  if v_gift > 0 then\n    update public.shop_gift_cards set balance = balance - v_gift where id = v_card.id;\n    insert into public.shop_gift_card_log (gift_card_id, order_id, delta, reason) values (v_card.id, v_order.id, -v_gift, ''redeemed'');\n  end if;\n\n' || v_old);

  v_old := E'    ''total'', v_order.subtotal - v_order.discount_amount + v_order.delivery_fee,';
  if position(v_old in v) = 0 then raise exception 'place_shop_order patch 8 failed'; end if;
  v := replace(v, v_old, v_old || E'\n    ''gift_card'', v_order.gift_card_amount,\n    ''amount_due'', v_order.subtotal - v_order.discount_amount + v_order.delivery_fee - v_order.gift_card_amount,');

  execute v;
  drop function public.place_shop_order(jsonb, text, text, text, text, text, text, jsonb, text);
  grant execute on function public.place_shop_order(jsonb, text, text, text, text, text, text, jsonb, text, text) to anon, authenticated;

  -- ── admin_set_shop_order_status: give the card its money back / take it again
  v := pg_get_functiondef('public.admin_set_shop_order_status(uuid,text)'::regprocedure);

  v_old := E'      update public.shop_discount_codes set used_count = greatest(0, used_count - 1) where upper(code) = upper(v_order.discount_code);\n    end if;';
  if position(v_old in v) = 0 then raise exception 'admin_set_shop_order_status patch 1 failed'; end if;
  v := replace(v, v_old, v_old || E'\n    if v_order.gift_card_id is not null and v_order.gift_card_amount > 0 then\n      update public.shop_gift_cards set balance = balance + v_order.gift_card_amount where id = v_order.gift_card_id;\n      insert into public.shop_gift_card_log (gift_card_id, order_id, delta, reason) values (v_order.gift_card_id, v_order.id, v_order.gift_card_amount, ''refunded'');\n    end if;');

  v_old := E'      update public.shop_discount_codes set used_count = used_count + 1 where upper(code) = upper(v_order.discount_code);\n    end if;';
  if position(v_old in v) = 0 then raise exception 'admin_set_shop_order_status patch 2 failed'; end if;
  v := replace(v, v_old, v_old || E'\n    if v_order.gift_card_id is not null and v_order.gift_card_amount > 0 then\n      update public.shop_gift_cards set balance = greatest(0, balance - v_order.gift_card_amount) where id = v_order.gift_card_id;\n      insert into public.shop_gift_card_log (gift_card_id, order_id, delta, reason) values (v_order.gift_card_id, v_order.id, -v_order.gift_card_amount, ''redeemed'');\n    end if;');
  execute v;

  -- ── lookup_shop_order: show the gift card amount to the customer ───────
  v := pg_get_functiondef('public.lookup_shop_order(text,text)'::regprocedure);
  v_old := '''discount_amount'', v_order.discount_amount, ''discount_code'', v_order.discount_code,';
  if position(v_old in v) = 0 then raise exception 'lookup_shop_order patch 1 failed'; end if;
  v := replace(v, v_old, v_old || E'\n    ''gift_card_amount'', v_order.gift_card_amount,');
  execute v;
end
$patch$;
