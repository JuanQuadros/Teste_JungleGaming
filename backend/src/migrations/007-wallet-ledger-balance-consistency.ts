export const name = '007-wallet-ledger-balance-consistency';

export const up = [
  `create function enforce_wallet_ledger_balance_consistency()
    returns trigger language plpgsql as $$
    declare
      target_wallet_id uuid;
      wallet_currency varchar(3);
      wallet_balance numeric(20, 2);
      ledger_balance numeric;
      has_currency_mismatch boolean;
    begin
      target_wallet_id := new.id;
      if tg_table_name = 'wallet_ledger_entries' then
        target_wallet_id := new.wallet_id;
      end if;

      execute format(
        'select currency, balance from %I.wallets where id = $1',
        tg_table_schema
      )
        into wallet_currency, wallet_balance
        using target_wallet_id;

      if wallet_currency is null then
        raise exception 'wallet % does not exist', target_wallet_id
          using errcode = '23514';
      end if;

      execute format(
        'select
          coalesce(sum(case when direction = ''CREDIT'' then amount else -amount end), 0),
          coalesce(bool_or(currency <> $2), false)
         from %I.wallet_ledger_entries
         where wallet_id = $1',
        tg_table_schema
      )
        into ledger_balance, has_currency_mismatch
        using target_wallet_id, wallet_currency;

      if has_currency_mismatch or ledger_balance <> wallet_balance then
        raise exception
          'wallet % balance does not match its ledger', target_wallet_id
          using errcode = '23514',
                constraint = 'wallet_ledger_balance_consistency';
      end if;

      return null;
    end;
  $$`,
  `create constraint trigger wallets_ledger_balance_consistency
    after insert or update on wallets
    deferrable initially deferred
    for each row
    execute function enforce_wallet_ledger_balance_consistency()`,
  `create constraint trigger ledger_wallet_balance_consistency
    after insert on wallet_ledger_entries
    deferrable initially deferred
    for each row
    execute function enforce_wallet_ledger_balance_consistency()`,
];

export const down = [
  'drop trigger ledger_wallet_balance_consistency on wallet_ledger_entries',
  'drop trigger wallets_ledger_balance_consistency on wallets',
  'drop function enforce_wallet_ledger_balance_consistency()',
];
