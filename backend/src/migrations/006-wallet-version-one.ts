export const name = '006-wallet-version-one';

export const up = [
  // Correct wallets created under the former zero-based version contract.
  'update wallets set version = 1 where version = 0',
  'alter table wallets alter column version set default 1',
  'alter table wallets drop constraint wallets_version_nonnegative_check',
  'alter table wallets add constraint wallets_version_check check (version >= 1)',
];

export const down = [
  'alter table wallets drop constraint wallets_version_check',
  'alter table wallets alter column version set default 0',
  `alter table wallets
    add constraint wallets_version_nonnegative_check check (version >= 0)`,
];
