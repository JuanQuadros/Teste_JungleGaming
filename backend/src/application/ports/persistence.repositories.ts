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
  insert(transaction: WagerTransaction): void;
  update(transaction: WagerTransaction): Promise<void>;
}

/** Contrato somente de leitura e inclusão para preservar a imutabilidade do ledger. */
export interface WalletLedgerEntryRepositoryPort {
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
  findReversalByTransactionId(
    originalTransactionId: string,
  ): Promise<WalletLedgerEntry | null>;
  insert(entry: WalletLedgerEntry): void;
}
