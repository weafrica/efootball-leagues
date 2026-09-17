# Goats (G) — Cash Ladder Currency

## What it is
A second in-app currency, separate from Nets, used only inside the Cash Ladder. Goats are only obtainable by paying real money — there's no free/earned path (unlike Nets).

## Exchange rate
**R2 = 7.6G** → 1 Rand = 3.8G

```
total_goats = round(amount_paid_rand * 3.8)
```
Rounded to the nearest whole Goat. Example: R50 paid → 190G. R55 → round(209) = 209G.

## Entry fee rule
Whatever a player pays, **half the Goats they receive become that transaction's entry fee**, the other half sits as spendable balance.

```
total_goats     = round(amount_paid_rand * 3.8)
entry_fee_goats = round(total_goats / 2)
balance_goats   = total_goats - entry_fee_goats   -- remainder, so no Goat is lost to rounding
```

- `entry_fee_goats` is applied immediately to join/fund the current cycle's cash league.
- `balance_goats` carries forward as the player's spendable Goats balance — intended to cover next month's entry fee without needing a second payment.

### Example
Player pays R100 → `total_goats = round(380) = 380G` → `entry_fee_goats = 190G` (used now) → `balance_goats = 190G` (carried forward).

## Open questions to confirm before I build this
1. **Does this replace or sit alongside `cash_ladder_pool`/`cash_ladder_fee_events`?** Right now those tables assume the entry fee is a Rand amount pulled straight from a real-money balance. Goats would need their own wallet table (`cash_ladder_goats_wallet` or similar) and a ledger (`cash_ladder_goats_transactions`), separate from the Rand pool that funds payouts.
2. **What are prize payouts denominated in — Goats or Rand?** If a player wins, do they get paid out in Rand (cashable) while Goats stay purely an entry-fee token, or can Goats themselves be cashed out? This materially changes the regulatory picture (see below).
3. **Can Goats be topped up mid-cycle**, or only at the monthly boundary? And can `balance_goats` be spent on anything besides next month's entry (e.g. late-join top-ups, bid amounts)?
4. **Expiry** — does unused `balance_goats` roll forward indefinitely, or expire if the player doesn't rejoin the next cycle?

## Regulatory note — is this regulated?

Short answer: **very likely yes, in South Africa specifically**, and wrapping the money in a second currency doesn't change that.

South Africa's National Gambling Act 7 of 2004 defines a "gambling game" (s.5(1)(a)) as an activity that's (i) played on payment of *any* consideration, with a chance of a pay-out, **and** (ii) the result may be determined by skill, chance, **or both**. That "or both" is the key detail — unlike some other countries, South Africa doesn't exempt games purely because they're skill-based. Paying an entry fee with a chance of winning a prize can meet this definition even for a 100%-skill game like FIFA/eFootball. Converting the payment into a second currency (Goats) first doesn't change the analysis — casinos exchange cash for chips and are still regulated under the same Act; the consideration is still real money in, real money (or something redeemable for it) potentially out.

Relevant bodies/legislation if you pursue this: the National Gambling Board plus your Provincial Gambling Board (each province licenses separately), and — since real money is moving through the platform — likely FICA (anti-money-laundering) and National Payment System Act obligations on whatever payment processor you use, regardless of the gambling question.

This isn't legal advice — I'm not a lawyer, and the "skill game with a prize pool" space in South Africa has genuine grey areas (fantasy sports and some skill-competition platforms operate in it). Given you're about to move from a closed Nets economy to real Rand in and out, this is worth a proper conversation with a lawyer who does South African gambling/gaming law before this cash ladder is live, not after.
