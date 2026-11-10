export const name = '005-pending-reference-retries';

export const up = [
  `alter table wager_transactions
    add column reference_attempts integer not null default 0
      check (reference_attempts >= 0),
    add column reference_next_attempt_at timestamptz`,
  `update wager_transactions
    set reference_next_attempt_at = now()
    where status = 'PENDING_REFERENCE'`,
  `create index wager_transactions_due_reference_retries_idx
    on wager_transactions (reference_next_attempt_at, created_at, id)
    where status = 'PENDING_REFERENCE'`,
];

export const down = [
  'drop index wager_transactions_due_reference_retries_idx',
  `alter table wager_transactions
    drop column reference_next_attempt_at,
    drop column reference_attempts`,
];
