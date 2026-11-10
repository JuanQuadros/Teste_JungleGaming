export const name = '010-transaction-terminal-timestamps';

export const up = [
  `update wager_transactions
   set processed_at = created_at
   where status in ('PROCESSED', 'REJECTED', 'FAILED')
     and processed_at is null`,
  `alter table wager_transactions
   add constraint wager_transactions_terminal_timestamp_check
   check (
     (status in ('PROCESSED', 'REJECTED', 'FAILED') and processed_at is not null)
     or
     (status in ('PENDING', 'PENDING_REFERENCE') and processed_at is null)
   )`,
];

export const down = [
  'alter table wager_transactions drop constraint wager_transactions_terminal_timestamp_check',
];
