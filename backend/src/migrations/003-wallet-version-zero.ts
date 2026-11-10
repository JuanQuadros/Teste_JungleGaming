export const name = '003-wallet-version-zero';

export const up = [
  // Alinha a versão inicial persistida ao valor zero definido pelo aggregate Wallet.
  'alter table wallets alter column version set default 0',
  'alter table wallets drop constraint wallets_version_check',
  `alter table wallets
    add constraint wallets_version_nonnegative_check check (version >= 0)`,
];

export const down = [
  // Não reverte o schema se já houver wallets na versão inicial zero.
  `do $$
    begin
      if exists (select 1 from wallets where version < 1) then
        raise exception 'Não é possível reverter enquanto houver wallets com versão zero';
      end if;
    end;
  $$`,
  'alter table wallets drop constraint wallets_version_nonnegative_check',
  'alter table wallets alter column version set default 1',
  'alter table wallets add constraint wallets_version_check check (version >= 1)',
];
