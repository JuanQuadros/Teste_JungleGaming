export const name = '001-initial-structure';

export const up = [
  // Armazena saldos decimais exatos e garante uma carteira por jogador e moeda.
  `create table wallets (
    id uuid primary key default gen_random_uuid(),
    player_id uuid not null,
    currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
    balance numeric(20, 2) not null default 0 check (balance >= 0),
    version integer not null default 1 check (version >= 1),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (player_id, currency)
  )`,
  // Persiste a identidade e o resultado da requisição para resolver novas tentativas pelo banco.
  `create table wager_transactions (
    id uuid primary key default gen_random_uuid(),
    provider_id text not null,
    external_transaction_id text not null,
    idempotency_key text not null unique,
    payload_hash char(64) not null,
    wallet_id uuid not null references wallets(id),
    player_id uuid not null,
    round_id text not null,
    game_id text not null,
    kind varchar(12) not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
    amount numeric(20, 2) not null check (amount > 0),
    currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
    status varchar(20) not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
    reference_external_transaction_id text,
    reference_transaction_id uuid references wager_transactions(id),
    failure_code varchar(64),
    created_at timestamptz not null default now(),
    processed_at timestamptz,
    unique (provider_id, external_transaction_id)
  )`,
  // Facilita a busca por transações que aguardam referências recebidas fora de ordem.
  `create index wager_transactions_pending_reference_idx
    on wager_transactions (created_at)
    where status = 'PENDING_REFERENCE'`,
  // Mantém o registro auditável dos saldos anterior e posterior e valida a operação no PostgreSQL.
  `create table wallet_ledger_entries (
    id uuid primary key default gen_random_uuid(),
    wallet_id uuid not null references wallets(id),
    transaction_id uuid not null unique references wager_transactions(id),
    direction varchar(6) not null check (direction in ('DEBIT', 'CREDIT')),
    amount numeric(20, 2) not null check (amount > 0),
    currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
    balance_before numeric(20, 2) not null check (balance_before >= 0),
    balance_after numeric(20, 2) not null check (balance_after >= 0),
    created_at timestamptz not null default now(),
    check (
      (direction = 'CREDIT' and balance_after = balance_before + amount) or
      (direction = 'DEBIT' and balance_after = balance_before - amount)
    )
  )`,
  // Impede alterações no ledger mesmo quando uma chamada ignora o código da aplicação.
  `create function prevent_ledger_mutation() returns trigger language plpgsql as $$
    begin
      raise exception 'wallet ledger entries are immutable';
    end;
  $$`,
  `create trigger wallet_ledger_entries_immutable
    before update or delete on wallet_ledger_entries
    for each row execute function prevent_ledger_mutation()`,
  // Registra entregas da fila de forma persistente para deduplicar mensagens reenviadas.
  `create table inbox_messages (
    consumer_name text not null,
    message_id text not null,
    payload_hash char(64) not null,
    received_at timestamptz not null default now(),
    processed_at timestamptz,
    primary key (consumer_name, message_id)
  )`,
  // Persiste eventos de integração para publicação após a confirmação da transação financeira.
  `create table outbox_messages (
    id uuid primary key default gen_random_uuid(),
    aggregate_id uuid not null,
    event_type text not null,
    payload jsonb not null,
    occurred_at timestamptz not null,
    attempts integer not null default 0 check (attempts >= 0),
    next_attempt_at timestamptz,
    published_at timestamptz
  )`,
  `create index outbox_messages_pending_idx
    on outbox_messages (next_attempt_at, occurred_at)
    where published_at is null`,
];

export const down = [
  // Remove os objetos dependentes antes das tabelas relacionadas e da função auxiliar.
  'drop table outbox_messages',
  'drop table inbox_messages',
  'drop trigger wallet_ledger_entries_immutable on wallet_ledger_entries',
  'drop table wallet_ledger_entries',
  'drop function prevent_ledger_mutation()',
  'drop table wager_transactions',
  'drop table wallets',
];
