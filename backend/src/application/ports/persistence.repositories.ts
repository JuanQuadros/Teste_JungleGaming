import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import type { Wallet } from '../../domain/wallet.js';

/** Token de injeção para o repositório de wallets. */
export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');

/** Token de injeção para o repositório de transações de aposta. */
export const WAGER_TRANSACTION_REPOSITORY = Symbol(
  'WAGER_TRANSACTION_REPOSITORY',
);

/** Token de injeção para o repositório do ledger imutável. */
export const WALLET_LEDGER_ENTRY_REPOSITORY = Symbol(
  'WALLET_LEDGER_ENTRY_REPOSITORY',
);

/** Token para a unidade de trabalho que bloqueia e transaciona uma wallet. */
export const WALLET_TRANSACTION_UNIT_OF_WORK = Symbol(
  'WALLET_TRANSACTION_UNIT_OF_WORK',
);

/** Token para criação transacional de wallet e seu lançamento inicial. */
export const WALLET_CREATION_UNIT_OF_WORK = Symbol(
  'WALLET_CREATION_UNIT_OF_WORK',
);

export interface OutboxEvent {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface OutboxEventRepositoryPort {
  insert(event: OutboxEvent): void;
}

export interface InboxMessage {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface WalletLedgerCursor {
  createdAt: string;
  id: string;
}

export interface WalletLedgerPageItem {
  entry: WalletLedgerEntry;
  createdAt: string;
  cursorAt: string;
}

/** Contrato de persistência usado pela aplicação para localizar e guardar wallets. */
export interface WalletRepositoryPort {
  findById(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null>;
  insert(wallet: Wallet): void;
  update(wallet: Wallet): Promise<void>;
}

/** Contrato de persistência para idempotência e identidade externa da operação. */
export interface WagerTransactionRepositoryPort {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findDuePendingReferences(
    now: Date,
    limit: number,
  ): Promise<Array<{ idempotencyKey: string }>>;
  insert(transaction: WagerTransaction): void;
  update(transaction: WagerTransaction): Promise<void>;
}

/** Contrato somente de leitura e inclusão para preservar a imutabilidade do ledger. */
export interface WalletLedgerEntryRepositoryPort {
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
  findReversalByTransactionId(
    originalTransactionId: string,
  ): Promise<WalletLedgerEntry | null>;
  findPageByWallet(
    walletId: string,
    cursor: WalletLedgerCursor | null,
    limit: number,
  ): Promise<{ items: WalletLedgerPageItem[]; hasMore: boolean }>;
  insert(entry: WalletLedgerEntry): void;
}

/** Persiste wallet e eventual abertura no mesmo commit SQL. */
export interface WalletCreationUnitOfWorkPort {
  create(
    wallet: Wallet,
    openingTransaction: WagerTransaction | null,
    openingEntry: WalletLedgerEntry | null,
  ): Promise<void>;
}

/** Repositórios e wallet carregados dentro da mesma transação SQL. */
export interface WalletTransactionContext {
  wallet: Wallet | null;
  wallets: WalletRepositoryPort;
  transactions: WagerTransactionRepositoryPort;
  ledgerEntries: WalletLedgerEntryRepositoryPort;
  outboxEvents: OutboxEventRepositoryPort;
  existingIdempotentTransaction: WagerTransaction | null;
  duplicateInboxMessage: boolean;
}

/** Serializa a chave de idempotência e, para novas operações, bloqueia a wallet. */
export interface WalletTransactionUnitOfWorkPort {
  withIdempotencyAndWalletLock<T>(
    walletId: string,
    idempotencyKey: string,
    operation: (context: WalletTransactionContext) => Promise<T>,
    inboxMessage?: InboxMessage,
  ): Promise<T>;
  withPendingReferenceLock<T>(
    idempotencyKey: string,
    operation: (context: WalletTransactionContext) => Promise<T>,
  ): Promise<T>;
}
