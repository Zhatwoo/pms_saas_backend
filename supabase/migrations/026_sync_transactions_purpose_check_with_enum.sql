-- Sync transactions_purpose_check with TransactionPurpose enum
alter table public.transactions
  drop constraint if exists transactions_purpose_check;

alter table public.transactions
  add constraint transactions_purpose_check
  check (
    purpose in (
      'Pawn',
      'Redeem',
      'Renew',
      'Reappraise',
      'Buy Back',
      'Sold Item',
      'Fund Transfer',
      'Cash Transfer',
      'Start',
      'End'
    )
  );
