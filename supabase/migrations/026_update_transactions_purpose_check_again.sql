alter table public.transactions
  drop constraint if exists transactions_purpose_check;

alter table public.transactions
  add constraint transactions_purpose_check
  check (
    purpose in (
      'Start',
      'End',
      'Buy Back',
      'Renew',
      'Sold Item',
      'Sale',
      'Pawn',
      'Cash Transfer',
      'Fund Transfer',
      'Redeem',
      'Expense'
    )
  );
