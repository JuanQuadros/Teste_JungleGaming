import { Money } from './money.js';
import {
  WagerRejectionCode,
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionType,
} from './wager-transaction.js';

export const WalletLedgerDirection = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
} as const;

export type WalletLedgerDirection =
  (typeof WalletLedgerDirection)[keyof typeof WalletLedgerDirection];

export interface WalletLedgerEntryInput {
  id: string;
  walletId: string;
  transactionId: string;
  direction: WalletLedgerDirection;
  amount: Money;
  currency: string;
  balanceBefore: Money;
  balanceAfter: Money;
  reversalOfTransactionId?: string | null;
}

export interface CreateWalletLedgerEntryInput {
  id: string;
  transaction: WagerTransaction;
  balanceBefore: Money;
}

export interface ReverseWalletLedgerEntryInput {
  id: string;
  transaction: WagerTransaction;
  originalTransaction: WagerTransaction;
  originalEntry: WalletLedgerEntry;
  balanceBefore: Money;
  existingReversal: WalletLedgerEntry | null;
}

export class InvalidWalletLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletLedgerEntryError';
  }
}

export class DuplicateLedgerReversalError extends Error {
  constructor(transactionId: string) {
    super(`A transação ${transactionId} já possui uma reversão.`);
    this.name = 'DuplicateLedgerReversalError';
  }
}

export class RollbackWouldCauseNegativeBalanceError extends Error {
  readonly code = WagerRejectionCode.ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE;

  constructor() {
    super('A reversão deixaria o saldo da wallet negativo.');
    this.name = 'RollbackWouldCauseNegativeBalanceError';
  }
}

const VALID_DIRECTIONS = new Set<string>(Object.values(WalletLedgerDirection));

/** Lançamento financeiro imutável que registra integralmente o efeito no saldo. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: WalletLedgerDirection,
    public readonly amount: Money,
    public readonly currency: string,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly reversalOfTransactionId: string | null,
  ) {
    Object.freeze(this);
  }

  /** Registra uma operação processada que produz movimento de saldo. */
  static createForTransaction(
    input: CreateWalletLedgerEntryInput,
  ): WalletLedgerEntry {
    const { transaction, balanceBefore } = input;
    WalletLedgerEntry.assertProcessed(transaction);

    let direction: WalletLedgerDirection;
    switch (transaction.kind) {
      case WagerTransactionType.OPENING:
      case WagerTransactionType.WIN:
        direction = WalletLedgerDirection.CREDIT;
        break;
      case WagerTransactionType.BET:
        direction = WalletLedgerDirection.DEBIT;
        break;
      case WagerTransactionType.LOSS:
        throw new InvalidWalletLedgerEntryError(
          'LOSS não produz lançamento no ledger.',
        );
      case WagerTransactionType.REFUND:
      case WagerTransactionType.ROLLBACK:
        throw new InvalidWalletLedgerEntryError(
          'REFUND e ROLLBACK devem ser lançados como reversões.',
        );
    }

    const balanceAfter = WalletLedgerEntry.apply(
      direction,
      transaction.amount,
      balanceBefore,
    );

    return WalletLedgerEntry.create({
      id: input.id,
      walletId: transaction.walletId,
      transactionId: transaction.id,
      direction,
      amount: transaction.amount,
      currency: transaction.currency,
      balanceBefore,
      balanceAfter,
    });
  }

  /** Cria uma compensação integral sem alterar o lançamento original. */
  static reverse(input: ReverseWalletLedgerEntryInput): WalletLedgerEntry {
    const {
      transaction,
      originalTransaction,
      originalEntry,
      balanceBefore,
      existingReversal,
    } = input;
    WalletLedgerEntry.assertProcessed(transaction);

    if (
      transaction.kind !== WagerTransactionType.REFUND &&
      transaction.kind !== WagerTransactionType.ROLLBACK
    ) {
      throw new InvalidWalletLedgerEntryError(
        'Somente REFUND ou ROLLBACK podem reverter um lançamento.',
      );
    }

    WalletLedgerEntry.assertReversalReference(
      transaction,
      originalTransaction,
      originalEntry,
    );

    if (existingReversal) {
      if (existingReversal.reversalOfTransactionId !== originalTransaction.id) {
        throw new InvalidWalletLedgerEntryError(
          'O lançamento existente não reverte a transação informada.',
        );
      }
      throw new DuplicateLedgerReversalError(originalTransaction.id);
    }

    if (transaction.kind === WagerTransactionType.REFUND) {
      if (originalTransaction.kind !== WagerTransactionType.BET) {
        throw new InvalidWalletLedgerEntryError(
          'REFUND deve referenciar uma aposta processada.',
        );
      }
    } else if (
      originalTransaction.kind !== WagerTransactionType.OPENING &&
      originalTransaction.kind !== WagerTransactionType.BET &&
      originalTransaction.kind !== WagerTransactionType.WIN &&
      originalTransaction.kind !== WagerTransactionType.REFUND
    ) {
      throw new InvalidWalletLedgerEntryError(
        'ROLLBACK deve referenciar uma operação processada com efeito financeiro reversível.',
      );
    }

    if (
      !transaction.amount.equals(originalEntry.amount) ||
      !originalTransaction.amount.equals(originalEntry.amount)
    ) {
      throw new InvalidWalletLedgerEntryError(
        'A reversão deve usar o valor integral do lançamento original.',
      );
    }

    const direction =
      originalEntry.direction === WalletLedgerDirection.CREDIT
        ? WalletLedgerDirection.DEBIT
        : WalletLedgerDirection.CREDIT;
    const balanceAfter = WalletLedgerEntry.apply(
      direction,
      originalEntry.amount,
      balanceBefore,
      transaction.kind === WagerTransactionType.ROLLBACK,
    );

    return WalletLedgerEntry.create({
      id: input.id,
      walletId: transaction.walletId,
      transactionId: transaction.id,
      direction,
      amount: originalEntry.amount,
      currency: transaction.currency,
      balanceBefore,
      balanceAfter,
      reversalOfTransactionId: originalTransaction.id,
    });
  }

  /** Valida os dados e a aritmética antes de criar um lançamento imutável. */
  static create(input: WalletLedgerEntryInput): WalletLedgerEntry {
    const requiredText: Array<[string, string]> = [
      ['identificador', input.id],
      ['identificador da wallet', input.walletId],
      ['identificador da transação', input.transactionId],
    ];
    for (const [label, value] of requiredText) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new InvalidWalletLedgerEntryError(
          `O lançamento deve possuir ${label}.`,
        );
      }
    }

    if (!VALID_DIRECTIONS.has(input.direction)) {
      throw new InvalidWalletLedgerEntryError(
        'A direção do lançamento não é válida.',
      );
    }
    if (!(input.amount instanceof Money) || !input.amount.isPositive()) {
      throw new InvalidWalletLedgerEntryError(
        'O valor do lançamento deve ser positivo.',
      );
    }
    if (
      !(input.balanceBefore instanceof Money) ||
      !(input.balanceAfter instanceof Money)
    ) {
      throw new InvalidWalletLedgerEntryError(
        'Os saldos anterior e posterior devem ser valores Money.',
      );
    }
    if (
      input.amount.currency !== input.currency ||
      input.balanceBefore.currency !== input.currency ||
      input.balanceAfter.currency !== input.currency
    ) {
      throw new InvalidWalletLedgerEntryError(
        'O valor e os saldos devem usar a moeda do lançamento.',
      );
    }
    if (input.balanceBefore.isNegative() || input.balanceAfter.isNegative()) {
      throw new InvalidWalletLedgerEntryError(
        'Os saldos do lançamento não podem ser negativos.',
      );
    }
    if (
      input.reversalOfTransactionId != null &&
      (typeof input.reversalOfTransactionId !== 'string' ||
        input.reversalOfTransactionId.trim().length === 0 ||
        input.reversalOfTransactionId === input.transactionId)
    ) {
      throw new InvalidWalletLedgerEntryError(
        'A referência da reversão deve identificar outra transação.',
      );
    }

    const expectedBalance = WalletLedgerEntry.apply(
      input.direction,
      input.amount,
      input.balanceBefore,
    );
    if (!expectedBalance.equals(input.balanceAfter)) {
      throw new InvalidWalletLedgerEntryError(
        'A direção e o valor não transformam o saldo anterior no posterior.',
      );
    }

    return new WalletLedgerEntry(
      input.id,
      input.walletId,
      input.transactionId,
      input.direction,
      input.amount,
      input.currency,
      input.balanceBefore,
      input.balanceAfter,
      input.reversalOfTransactionId ?? null,
    );
  }

  private static assertProcessed(transaction: WagerTransaction): void {
    if (transaction.status !== WagerTransactionStatus.PROCESSED) {
      throw new InvalidWalletLedgerEntryError(
        'Somente transações PROCESSED podem gerar lançamentos no ledger.',
      );
    }
  }

  private static assertReversalReference(
    transaction: WagerTransaction,
    originalTransaction: WagerTransaction,
    originalEntry: WalletLedgerEntry,
  ): void {
    WalletLedgerEntry.assertProcessed(originalTransaction);

    const rollbackOfRefund =
      transaction.kind === WagerTransactionType.ROLLBACK &&
      originalTransaction.kind === WagerTransactionType.REFUND;
    const invalidReversalLink = rollbackOfRefund
      ? originalEntry.reversalOfTransactionId === null
      : originalEntry.reversalOfTransactionId !== null;
    if (
      originalEntry.transactionId !== originalTransaction.id ||
      originalEntry.walletId !== originalTransaction.walletId ||
      invalidReversalLink
    ) {
      throw new InvalidWalletLedgerEntryError(
        'A referência deve ser um lançamento original da transação informada.',
      );
    }

    const expectedDirection =
      originalTransaction.kind === WagerTransactionType.BET
        ? WalletLedgerDirection.DEBIT
        : originalTransaction.kind === WagerTransactionType.WIN ||
            originalTransaction.kind === WagerTransactionType.OPENING ||
            originalTransaction.kind === WagerTransactionType.REFUND
          ? WalletLedgerDirection.CREDIT
          : null;
    if (
      expectedDirection === null ||
      originalEntry.direction !== expectedDirection ||
      !originalEntry.amount.equals(originalTransaction.amount) ||
      originalEntry.currency !== originalTransaction.currency
    ) {
      throw new InvalidWalletLedgerEntryError(
        'A transação de referência não possui um lançamento original elegível.',
      );
    }

    if (
      transaction.providerId !== originalTransaction.providerId ||
      transaction.playerId !== originalTransaction.playerId ||
      transaction.walletId !== originalTransaction.walletId ||
      transaction.currency !== originalTransaction.currency ||
      transaction.roundId !== originalTransaction.roundId
    ) {
      throw new InvalidWalletLedgerEntryError(
        'A referência deve pertencer ao mesmo provedor, jogador, wallet, moeda e rodada.',
      );
    }

    if (
      transaction.referenceTransactionId === null &&
      transaction.referenceExternalTransactionId === null
    ) {
      throw new InvalidWalletLedgerEntryError(
        'A reversão deve informar a transação de referência.',
      );
    }
    if (
      (transaction.referenceTransactionId !== null &&
        transaction.referenceTransactionId !== originalTransaction.id) ||
      (transaction.referenceExternalTransactionId !== null &&
        transaction.referenceExternalTransactionId !==
          originalTransaction.externalTransactionId)
    ) {
      throw new InvalidWalletLedgerEntryError(
        'A transação de referência não corresponde ao lançamento original.',
      );
    }
  }

  private static apply(
    direction: WalletLedgerDirection,
    amount: Money,
    balanceBefore: Money,
    isRollback = false,
  ): Money {
    if (amount.currency !== balanceBefore.currency) {
      throw new InvalidWalletLedgerEntryError(
        'O valor e o saldo anterior devem usar a mesma moeda.',
      );
    }

    const balanceAfter =
      direction === WalletLedgerDirection.CREDIT
        ? balanceBefore.add(amount)
        : balanceBefore.subtract(amount);

    if (balanceAfter.isNegative()) {
      if (isRollback) {
        throw new RollbackWouldCauseNegativeBalanceError();
      }
      throw new InvalidWalletLedgerEntryError(
        'O débito do lançamento deixaria o saldo negativo.',
      );
    }

    return balanceAfter;
  }
}
