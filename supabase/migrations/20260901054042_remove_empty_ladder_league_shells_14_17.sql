-- Tiers 14, 15, 16, 17 have zero memberships and zero fixtures — leftover
-- shell rows flagged in CONTINUE-FROM-HERE.md as clutter from a
-- pre-20260919 overflow-cascade bug that was corrected by hand. Confirmed
-- clean before deleting.
delete from ladder_leagues where id in (
  'bfdec9f6-8cae-4f7c-b225-73f743e0dfa9',
  'b4762df0-a35c-49c7-8ff5-6e9baf5a9172',
  '05f9608c-d4e9-4bb7-88d8-66f7c5dd22a8',
  'd27aade6-01ed-4860-874b-3d13679b4250'
);
