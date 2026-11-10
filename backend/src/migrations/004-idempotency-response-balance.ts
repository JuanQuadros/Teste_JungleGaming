export const name = '004-idempotency-response-balance';

export const up = [
  // Preserva o saldo observado na resposta original mesmo após operações posteriores.
  'alter table wager_transactions add column response_balance numeric(20, 2) check (response_balance is null or response_balance >= 0)',
];

export const down = [
  'alter table wager_transactions drop column response_balance',
];
