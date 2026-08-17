-- Tracks how a member's entry fee was paid: 'card' for iKhokha
-- auto-approved payments, null/unset for the existing manual
-- bank-transfer / Mukuru / proof-upload flow.
alter table members add column if not exists payment_method text;
