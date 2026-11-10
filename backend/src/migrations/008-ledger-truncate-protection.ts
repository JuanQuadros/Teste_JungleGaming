export const name = '008-ledger-truncate-protection';

export const up = [
  `create trigger wallet_ledger_entries_no_truncate
    before truncate on wallet_ledger_entries
    for each statement
    execute function prevent_ledger_mutation()`,
];

export const down = [
  'drop trigger wallet_ledger_entries_no_truncate on wallet_ledger_entries',
];
