import { describe, expect, it } from 'vitest';
import { Money } from './money.js';
import {
  DuplicateLedgerReversalError,
  InvalidWalletLedgerEntryError,
  RollbackWouldCauseNegativeBalanceError,
  WalletLedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionType,
} from './wager-transaction.js';

const money = (amount: string, currency = 'BRL') =>
  Money.from({ amount, currency });

const createTransaction = (
  overrides: Partial<{
    id: string;
    kind: (typeof WagerTransactionType)[keyof typeof WagerTransactionType];
    amount: Money;
    currency: string;
    walletId: string;
    playerId: string;
    providerId: string;
    roundId: string;
    externalTransactionId: string;
    referenceTransactionId: string | null;
    referenceExternalTransactionId: string | null;
  }> = {},
): WagerTransaction => {
  const transaction = WagerTransaction.create({
    id: overrides.id ?? 'transaction-1',
    providerId: overrides.providerId ?? 'provider-1',
    externalTransactionId:
      overrides.externalTransactionId ?? 'external-1',
    idempotencyKey: `key-${overrides.id ?? 'transaction-1'}`,
    payloadHash: 'a'.repeat(64),
    walletId: overrides.walletId ?? 'wallet-1',
    playerId: overrides.playerId ?? 'player-1',
    roundId: overrides.roundId ?? 'round-1',
    gameId: 'game-1',
    kind:
      overrides.kind && overrides.kind !== WagerTransactionType.OPENING
        ? overrides.kind
        : WagerTransactionType.BET,
    amount: overrides.amount ?? money('10.00'),
    currency: overrides.currency ?? 'BRL',
    referenceTransactionId: overrides.referenceTransactionId ?? null,
    referenceExternalTransactionId:
      overrides.referenceExternalTransactionId ?? null,
  });
  if (overrides.kind === WagerTransactionType.OPENING) {
    const opening = WagerTransaction.createInternalOpening({
      id: overrides.id ?? 'transaction-1',
      providerId: overrides.providerId ?? 'provider-1',
      externalTransactionId:
        overrides.externalTransactionId ?? 'external-1',
      idempotencyKey: `key-${overrides.id ?? 'transaction-1'}`,
      payloadHash: 'a'.repeat(64),
      walletId: overrides.walletId ?? 'wallet-1',
      playerId: overrides.playerId ?? 'player-1',
      roundId: overrides.roundId ?? 'round-1',
      gameId: 'game-1',
      amount: overrides.amount ?? money('10.00'),
      currency: overrides.currency ?? 'BRL',
    });
    opening.markProcessed();
    return opening;
  }
  transaction.markProcessed();
  return transaction;
};

const createOriginalEntry = (
  transaction: WagerTransaction,
  balanceBefore = money('20.00'),
) =>
  WalletLedgerEntry.createForTransaction({
    id: `entry-${transaction.id}`,
    transaction,
    balanceBefore,
  });

const createReversal = (
  originalTransaction: WagerTransaction,
  originalEntry: WalletLedgerEntry,
  overrides: Partial<{
    kind: (typeof WagerTransactionType)[keyof typeof WagerTransactionType];
    amount: Money;
    balanceBefore: Money;
    referenceTransactionId: string | null;
    referenceExternalTransactionId: string | null;
    providerId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    currency: string;
  }> = {},
  existingReversal: WalletLedgerEntry | null = null,
) => {
  const transaction = createTransaction({
    id: 'reversal-1',
    kind:
      overrides.kind === WagerTransactionType.ROLLBACK
        ? WagerTransactionType.ROLLBACK
        : WagerTransactionType.REFUND,
    amount: overrides.amount ?? originalEntry.amount,
    currency: overrides.currency ?? originalTransaction.currency,
    walletId: overrides.walletId ?? originalTransaction.walletId,
    playerId: overrides.playerId ?? originalTransaction.playerId,
    providerId: overrides.providerId ?? originalTransaction.providerId,
    roundId: overrides.roundId ?? originalTransaction.roundId,
    referenceTransactionId:
      overrides.referenceTransactionId === undefined
        ? originalTransaction.id
        : overrides.referenceTransactionId,

// Não duplica a referência com o identificador externo.
referenceExternalTransactionId: null,
  });
  return WalletLedgerEntry.reverse({
    id: 'reversal-entry-1',
    transaction,
    originalTransaction,
    originalEntry,
    balanceBefore: overrides.balanceBefore ?? money('10.00'),
    existingReversal,
  });
};

describe('WalletLedgerEntry', () => {
  it('valida a aritmética de crédito e débito sem alterar o saldo de entrada', () => {
    const bet = createTransaction({ kind: WagerTransactionType.BET });
    const betEntry = WalletLedgerEntry.createForTransaction({
      id: 'entry-bet',
      transaction: bet,
      balanceBefore: money('20.00'),
    });
    const win = createTransaction({
      id: 'transaction-win',
      kind: WagerTransactionType.WIN,
      amount: money('5.25'),
    });
    const winEntry = WalletLedgerEntry.createForTransaction({
      id: 'entry-win',
      transaction: win,
      balanceBefore: money('10.00'),
    });

    expect(betEntry.direction).toBe(WalletLedgerDirection.DEBIT);
    expect(betEntry.balanceAfter.toJSON().amount).toBe('10.00');
    expect(winEntry.direction).toBe(WalletLedgerDirection.CREDIT);
    expect(winEntry.balanceAfter.toJSON().amount).toBe('15.25');
    expect(betEntry.balanceBefore.toJSON().amount).toBe('20.00');
  });

  it('não gera lançamentos para LOSS ou transação não processada', () => {
    const loss = createTransaction({ kind: WagerTransactionType.LOSS });
    const rejected = WagerTransaction.create({
      id: 'rejected-transaction',
      providerId: 'provider-1',
      externalTransactionId: 'external-rejected',
      idempotencyKey: 'key-rejected',
      payloadHash: 'a'.repeat(64),
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionType.BET,
      amount: money('10.00'),
      currency: 'BRL',
    });
    rejected.reject('INSUFFICIENT_BALANCE');
    const pending = WagerTransaction.create({
      id: 'pending-transaction',
      providerId: 'provider-1',
      externalTransactionId: 'external-pending',
      idempotencyKey: 'key-pending',
      payloadHash: 'a'.repeat(64),
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionType.BET,
      amount: money('10.00'),
      currency: 'BRL',
    });

    expect(() =>
      WalletLedgerEntry.createForTransaction({
        id: 'entry-loss',
        transaction: loss,
        balanceBefore: money('20.00'),
      }),
    ).toThrow(InvalidWalletLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.createForTransaction({
        id: 'entry-rejected',
        transaction: rejected,
        balanceBefore: money('20.00'),
      }),
    ).toThrow(InvalidWalletLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.createForTransaction({
        id: 'entry-pending',
        transaction: pending,
        balanceBefore: money('20.00'),
      }),
    ).toThrow(InvalidWalletLedgerEntryError);
    expect(loss.status).toBe(WagerTransactionStatus.PROCESSED);
  });

  it('rejeita aritmética incompatível, moeda divergente e saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-invalid-math',
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: WalletLedgerDirection.CREDIT,
        amount: money('10.00'),
        currency: 'BRL',
        balanceBefore: money('5.00'),
        balanceAfter: money('14.99'),
      }),
    ).toThrow(InvalidWalletLedgerEntryError);

    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-invalid-currency',
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: WalletLedgerDirection.CREDIT,
        amount: money('10.00', 'USD'),
        currency: 'BRL',
        balanceBefore: money('5.00'),
        balanceAfter: money('15.00'),
      }),
    ).toThrow(InvalidWalletLedgerEntryError);

    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-negative',
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: WalletLedgerDirection.DEBIT,
        amount: money('10.00'),
        currency: 'BRL',
        balanceBefore: money('5.00'),
        balanceAfter: money('0.00'),
      }),
    ).toThrow(InvalidWalletLedgerEntryError);
  });

  it('congela o lançamento e não expõe operações de alteração ou remoção', () => {
    const entry = createOriginalEntry(
      createTransaction({ kind: WagerTransactionType.BET }),
    );

    expect(Object.isFrozen(entry)).toBe(true);
    expect('update' in entry).toBe(false);
    expect('delete' in entry).toBe(false);
  });

  it('REFUND credita integralmente uma aposta processada', () => {
    const original = createTransaction({ kind: WagerTransactionType.BET });
    const originalEntry = createOriginalEntry(original);

    const reversal = createReversal(original, originalEntry);

    expect(reversal.direction).toBe(WalletLedgerDirection.CREDIT);
    expect(reversal.amount.toJSON().amount).toBe('10.00');
    expect(reversal.balanceAfter.toJSON().amount).toBe('20.00');
    expect(reversal.reversalOfTransactionId).toBe(original.id);
    expect(originalEntry.balanceAfter.toJSON().amount).toBe('10.00');
  });

  it('ROLLBACK gera lançamento oposto para BET e WIN e rejeita OPENING', () => {
    const bet = createTransaction({ kind: WagerTransactionType.BET });
    const betEntry = createOriginalEntry(bet);
    const win = createTransaction({
      id: 'transaction-win',
      kind: WagerTransactionType.WIN,
    });
    const winEntry = createOriginalEntry(win);
    const opening = createTransaction({
      id: 'transaction-opening',
      kind: WagerTransactionType.OPENING,
    });
    const openingEntry = createOriginalEntry(opening);

    expect(
      createReversal(bet, betEntry, {
        kind: WagerTransactionType.ROLLBACK,
      }).direction,
    ).toBe(WalletLedgerDirection.CREDIT);
    expect(
      createReversal(win, winEntry, {
        kind: WagerTransactionType.ROLLBACK,
      }).direction,
    ).toBe(WalletLedgerDirection.DEBIT);
    expect(() =>
      createReversal(opening, openingEntry, {
        kind: WagerTransactionType.ROLLBACK,
      }),
    ).toThrow(InvalidWalletLedgerEntryError);
  });

  it('permite ROLLBACK de REFUND e registra um débito vinculado ao crédito', () => {
    const bet = createTransaction({
      id: 'rollback-refund-bet',
      kind: WagerTransactionType.BET,
      externalTransactionId: 'rollback-refund-bet-external',
    });
    const betEntry = createOriginalEntry(bet, money('20.00'));
    const refund = createTransaction({
      id: 'rollback-refund',
      kind: WagerTransactionType.REFUND,
      externalTransactionId: 'rollback-refund-external',
      referenceTransactionId: bet.id,
    });
    const refundEntry = WalletLedgerEntry.reverse({
      id: 'rollback-refund-entry',
      transaction: refund,
      originalTransaction: bet,
      originalEntry: betEntry,
      balanceBefore: money('10.00'),
      existingReversal: null,
    });
    const rollback = createTransaction({
      id: 'rollback-of-refund',
      kind: WagerTransactionType.ROLLBACK,
      externalTransactionId: 'rollback-of-refund-external',
      referenceTransactionId: refund.id,
    });
    const rollbackEntry = WalletLedgerEntry.reverse({
      id: 'rollback-of-refund-entry',
      transaction: rollback,
      originalTransaction: refund,
      originalEntry: refundEntry,
      balanceBefore: money('20.00'),
      existingReversal: null,
    });

    expect(refundEntry.direction).toBe(WalletLedgerDirection.CREDIT);
    expect(refundEntry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(rollbackEntry.direction).toBe(WalletLedgerDirection.DEBIT);
    expect(rollbackEntry.balanceAfter.toJSON().amount).toBe('10.00');
    expect(rollbackEntry.reversalOfTransactionId).toBe(refund.id);
  });

  it('rehydrates and validates immutable ledger entries and their creation time', () => {
    const entry = createOriginalEntry(createTransaction(), money('20.00'));
    const snapshot = {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.amount,
      currency: entry.currency,
      balanceBefore: entry.balanceBefore,
      balanceAfter: entry.balanceAfter,
      reversalOfTransactionId: entry.reversalOfTransactionId,
      createdAt: entry.createdAt,
    };

    const restored = WalletLedgerEntry.rehydrate(snapshot);
    expect(restored).toEqual(entry);
    expect(restored.isBalanced()).toBe(true);
    expect(() =>
      WalletLedgerEntry.rehydrate({ ...snapshot, createdAt: new Date('bad') }),
    ).toThrow(InvalidWalletLedgerEntryError);
  });

  it('rejeita referência incompatível, tipo não elegível ou valor parcial', () => {
    const bet = createTransaction({ kind: WagerTransactionType.BET });
    const betEntry = createOriginalEntry(bet);
    const win = createTransaction({
      id: 'transaction-win',
      kind: WagerTransactionType.WIN,
    });
    const winEntry = createOriginalEntry(win);
    const refund = createTransaction({
      id: 'transaction-refund',
      kind: WagerTransactionType.REFUND,
      referenceTransactionId: bet.id,
    });
    const refundEntry = WalletLedgerEntry.create({
      id: 'entry-refund',
      walletId: refund.walletId,
      transactionId: refund.id,
      direction: WalletLedgerDirection.CREDIT,
      amount: money('10.00'),
      currency: 'BRL',
      balanceBefore: money('10.00'),
      balanceAfter: money('20.00'),
      reversalOfTransactionId: bet.id,
    });

    expect(() =>
      createReversal(bet, betEntry, {
        kind: WagerTransactionType.ROLLBACK,
        amount: money('9.00'),
      }),
    ).toThrow(InvalidWalletLedgerEntryError);
    expect(() =>
      createReversal(win, winEntry, {
        providerId: 'other-provider',
        kind: WagerTransactionType.ROLLBACK,
      }),
    ).toThrow(InvalidWalletLedgerEntryError);
    expect(() =>
      createReversal(bet, betEntry, {
        playerId: 'other-player',
        kind: WagerTransactionType.ROLLBACK,
      }),
    ).toThrow(InvalidWalletLedgerEntryError);
    expect(() =>
      createReversal(bet, betEntry, {
        walletId: 'other-wallet',
        kind: WagerTransactionType.ROLLBACK,
      }),
    ).toThrow(InvalidWalletLedgerEntryError);
    expect(() =>
      createReversal(bet, betEntry, {
        roundId: 'other-round',
        kind: WagerTransactionType.ROLLBACK,
      }),
    ).toThrow(InvalidWalletLedgerEntryError);
    expect(() =>
      createReversal(bet, betEntry, {
        amount: money('10.00', 'USD'),
        currency: 'USD',
        kind: WagerTransactionType.ROLLBACK,
      }),
    ).toThrow(InvalidWalletLedgerEntryError);
    expect(() => createReversal(refund, refundEntry)).toThrow(
      InvalidWalletLedgerEntryError,
    );
    expect(() =>
      createReversal(bet, betEntry, {
        kind: WagerTransactionType.ROLLBACK,
        referenceTransactionId: 'different-transaction',
      }),
    ).toThrow(InvalidWalletLedgerEntryError);
  });

  it('impede segunda reversão independente do tipo usado', () => {
    const original = createTransaction({ kind: WagerTransactionType.BET });
    const originalEntry = createOriginalEntry(original);
    const existingReversal = WalletLedgerEntry.create({
      id: 'entry-existing-reversal',
      walletId: original.walletId,
      transactionId: 'transaction-refund',
      direction: WalletLedgerDirection.CREDIT,
      amount: money('10.00'),
      currency: 'BRL',
      balanceBefore: money('10.00'),
      balanceAfter: money('20.00'),
      reversalOfTransactionId: original.id,
    });

    expect(() =>
      createReversal(
        original,
        originalEntry,
        { kind: WagerTransactionType.ROLLBACK },
        existingReversal,
      ),
    ).toThrow(DuplicateLedgerReversalError);
  });

  it('usa o código estável quando um ROLLBACK de crédito deixaria saldo negativo', () => {
    const original = createTransaction({ kind: WagerTransactionType.WIN });
    const originalEntry = createOriginalEntry(original);
    const rollback = () =>
      createReversal(
        original,
        originalEntry,
        {
          kind: WagerTransactionType.ROLLBACK,
          balanceBefore: money('5.00'),
        },
      );

    expect(rollback).toThrow(RollbackWouldCauseNegativeBalanceError);
    let error: unknown;
    try {
      rollback();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE',
    });
  });
});
