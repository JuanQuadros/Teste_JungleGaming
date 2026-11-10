export const name = '002-ledger-reversals';

export const up = [
  // Vincula cada reversão a um lançamento existente da mesma wallet.
  'alter table wallet_ledger_entries add column reversal_of_transaction_id uuid',
  `alter table wallet_ledger_entries
    add constraint wallet_ledger_entries_transaction_wallet_unique
    unique (transaction_id, wallet_id)`,
  `alter table wallet_ledger_entries
    add constraint wallet_ledger_entries_reversal_source_fk
    foreign key (reversal_of_transaction_id, wallet_id)
    references wallet_ledger_entries (transaction_id, wallet_id)`,
  // Garante que a mesma operação original só seja revertida uma vez.
  `alter table wallet_ledger_entries
    add constraint wallet_ledger_entries_reversal_once_unique
    unique (reversal_of_transaction_id)`,
  `alter table wallet_ledger_entries
    add constraint wallet_ledger_entries_reversal_not_self_check
    check (
      reversal_of_transaction_id is null or
      reversal_of_transaction_id <> transaction_id
    )`,
];

export const down = [
  'alter table wallet_ledger_entries drop constraint wallet_ledger_entries_reversal_not_self_check',
  'alter table wallet_ledger_entries drop constraint wallet_ledger_entries_reversal_once_unique',
  'alter table wallet_ledger_entries drop constraint wallet_ledger_entries_reversal_source_fk',
  'alter table wallet_ledger_entries drop constraint wallet_ledger_entries_transaction_wallet_unique',
  'alter table wallet_ledger_entries drop column reversal_of_transaction_id',
];
