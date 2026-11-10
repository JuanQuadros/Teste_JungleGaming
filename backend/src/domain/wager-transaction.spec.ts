import { describe, expect, it } from 'vitest';
import { Money } from './money.js';
import {
  InvalidWagerTransactionError,
  InvalidWagerTransitionError,
  WagerFailureCode,
  WagerRejectionCode,
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionType,
  type WagerTransactionInput,
  type WagerTransactionSnapshot,
} from './wager-transaction.js';

const createInput = (
  overrides: Partial<WagerTransactionInput> = {},
): WagerTransactionInput => ({
  id: 'transaction-1',
  providerId: 'provider-1',
  externalTransactionId: 'external-1',
  idempotencyKey: 'idempotency-1',
  payloadHash: 'a'.repeat(64),
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionType.BET,
  amount: Money.from({ amount: '10.00', currency: 'BRL' }),
  currency: 'BRL',
  referenceExternalTransactionId: null,
  referenceTransactionId: null,
  ...overrides,
});

describe('WagerTransaction', () => {
  // Uma operação externa começa pendente e não possui código de falha.
  it('cria os tipos externos no estado PENDING', () => {
    for (const kind of [
      WagerTransactionType.BET,
      WagerTransactionType.WIN,
      WagerTransactionType.LOSS,
      WagerTransactionType.REFUND,
      WagerTransactionType.ROLLBACK,
    ]) {
      const transaction = WagerTransaction.create(
        createInput({
          kind,
          ...(kind === WagerTransactionType.REFUND ||
          kind === WagerTransactionType.ROLLBACK
            ? { referenceExternalTransactionId: 'original-transaction' }
            : {}),
        }),
      );

      expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
      expect(transaction.failureCode).toBeNull();
    }
  });

  // OPENING pode ser criado pelo código interno, mas não pela factory externa.
  it('mantém OPENING como tipo interno e bloqueia sua criação externa', () => {
    const internalOpening = WagerTransaction.createInternalOpening({
      ...createInput(),
    });
    const externalOpening = createInput({
      kind: WagerTransactionType.OPENING as WagerTransactionInput['kind'],
    });

    expect(internalOpening.kind).toBe(WagerTransactionType.OPENING);
    expect(() => WagerTransaction.create(externalOpening)).toThrow(
      InvalidWagerTransactionError,
    );
  });

  // Uma referência ausente pode ser registrada e depois retornar ao processamento.
  it('permite a transição PENDING -> PENDING_REFERENCE -> PENDING', () => {
    const transaction = WagerTransaction.create(createInput());

    const firstRetry = new Date('2026-01-01T00:00:01.000Z');
    transaction.markPendingReference(firstRetry);
    expect(transaction.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(transaction.referenceNextAttemptAt).toEqual(firstRetry);

    transaction.recordReferenceRetry(new Date('2026-01-01T00:00:03.000Z'));
    expect(transaction.referenceAttempts).toBe(1);

    transaction.resumeAfterReference();
    expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
    expect(transaction.referenceNextAttemptAt).toBeNull();
  });

  // O processamento pode concluir uma transação pendente ou cuja referência chegou.
  it.each([
    WagerTransactionStatus.PENDING,
    WagerTransactionStatus.PENDING_REFERENCE,
  ])('permite concluir como processada a partir de %s', (startingStatus) => {
    const transaction = WagerTransaction.create(createInput());
    if (startingStatus === WagerTransactionStatus.PENDING_REFERENCE) {
      transaction.markPendingReference();
    }

    transaction.markProcessed();

    expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(transaction.failureCode).toBeNull();
    expect(transaction.isTerminal()).toBe(true);
  });

  // Cada rejeição persiste um código legível por máquina e encerra a máquina de estados.
  it.each([
    WagerRejectionCode.INSUFFICIENT_BALANCE,
    WagerRejectionCode.INVALID_REFERENCE,
    WagerRejectionCode.REFERENCE_NOT_FOUND,
    WagerRejectionCode.ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE,
  ])('rejeita com o código estável %s', (failureCode) => {
    const transaction = WagerTransaction.create(createInput());

    transaction.reject(failureCode);

    expect(transaction.status).toBe(WagerTransactionStatus.REJECTED);
    expect(transaction.failureCode).toBe(failureCode);
    expect(transaction.isTerminal()).toBe(true);
  });

  // Falhas técnicas usam estado e código próprios, distintos de rejeições de negócio.
  it('registra falha técnica com código estável', () => {
    const transaction = WagerTransaction.create(createInput());

    transaction.fail(WagerFailureCode.PROCESSING_FAILED);

    expect(transaction.status).toBe(WagerTransactionStatus.FAILED);
    expect(transaction.failureCode).toBe(WagerFailureCode.PROCESSING_FAILED);
  });

  // Estados terminais não aceitam transições nem alteração posterior do código de falha.
  it.each([
    WagerTransactionStatus.PROCESSED,
    WagerTransactionStatus.REJECTED,
    WagerTransactionStatus.FAILED,
  ])('mantém o estado terminal %s imutável', (terminalStatus) => {
    const transaction = WagerTransaction.create(createInput());
    if (terminalStatus === WagerTransactionStatus.PROCESSED) {
      transaction.markProcessed();
    } else if (terminalStatus === WagerTransactionStatus.REJECTED) {
      transaction.reject(WagerRejectionCode.INVALID_REFERENCE);
    } else {
      transaction.fail(WagerFailureCode.PROCESSING_FAILED);
    }
    const originalFailureCode = transaction.failureCode;

    expect(() => transaction.markPendingReference()).toThrow(
      InvalidWagerTransitionError,
    );
    expect(() => transaction.markProcessed()).toThrow(
      InvalidWagerTransitionError,
    );
    expect(transaction.status).toBe(terminalStatus);
    expect(transaction.failureCode).toBe(originalFailureCode);
  });

  // Uma transição não autorizada não altera o estado atual.
  it('rejeita transições inválidas sem alterar o estado', () => {
    const transaction = WagerTransaction.create(createInput());

    expect(() => transaction.resumeAfterReference()).toThrow(
      InvalidWagerTransitionError,
    );
    expect(() => transaction.markPendingReference()).not.toThrow();
    expect(() => transaction.markPendingReference()).toThrow(
      InvalidWagerTransitionError,
    );
    expect(transaction.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
  });

  // A reidratação recupera o estado final diretamente, sem repetir transições.
  it('rehydrate restaura um snapshot processado sem reproduzir as transições', () => {
    const snapshot: WagerTransactionSnapshot = {
      ...createInput(),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      processedAt: new Date('2026-01-01T00:00:01.000Z'),
      status: WagerTransactionStatus.PROCESSED,
      failureCode: null,
      referenceAttempts: 0,
      referenceNextAttemptAt: null,
    };

    const restored = WagerTransaction.rehydrate(snapshot);

    expect(restored.toSnapshot()).toEqual(snapshot);
  });

  // Dados persistidos só podem combinar rejeição ou falha com códigos apropriados.
  it('rejeita snapshots com combinação inválida de estado e código', () => {
    const snapshot: WagerTransactionSnapshot = {
      ...createInput(),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      processedAt: null,
      status: WagerTransactionStatus.REJECTED,
      failureCode: WagerFailureCode.PROCESSING_FAILED,
    };

    expect(() => WagerTransaction.rehydrate(snapshot)).toThrow(
      InvalidWagerTransactionError,
    );
  });

  // Os dados básicos da operação também são validados pela factory de criação.
  it('rejeita valor não positivo, moeda incompatível e hash inválido', () => {
    expect(() =>
      WagerTransaction.create(createInput({ amount: Money.zero('BRL') })),
    ).toThrow(InvalidWagerTransactionError);
    expect(() =>
      WagerTransaction.create(
        createInput({
          amount: Money.from({ amount: '10.00', currency: 'USD' }),
        }),
      ),
    ).toThrow(InvalidWagerTransactionError);
    expect(() =>
      WagerTransaction.create(createInput({ payloadHash: 'inválido' })),
    ).toThrow(InvalidWagerTransactionError);
  });

  it('exige exatamente uma referência para REFUND e ROLLBACK e rejeita referências em BET', () => {
    for (const kind of [
      WagerTransactionType.REFUND,
      WagerTransactionType.ROLLBACK,
    ]) {
      expect(() => WagerTransaction.create(createInput({ kind }))).toThrow(
        InvalidWagerTransactionError,
      );
      expect(() =>
        WagerTransaction.create(
          createInput({
            kind,
            referenceExternalTransactionId: 'original-external',
            referenceTransactionId: 'original-internal',
          }),
        ),
      ).toThrow(InvalidWagerTransactionError);
    }

    expect(() =>
      WagerTransaction.create(
        createInput({
          kind: WagerTransactionType.BET,
          referenceExternalTransactionId: 'unexpected-reference',
        }),
      ),
    ).toThrow(InvalidWagerTransactionError);
  });

  it('persists creation and terminal timestamps consistently with transaction status', () => {
    const transaction = WagerTransaction.create(createInput());
    expect(transaction.processedAt).toBeNull();
    const completedAt = new Date(Date.now() + 1_000);
    transaction.markProcessed(completedAt);
    expect(transaction.processedAt).toEqual(completedAt);
    expect(transaction.toSnapshot().createdAt).toBeInstanceOf(Date);
    expect(
      WagerTransaction.rehydrate(transaction.toSnapshot()).processedAt,
    ).toEqual(completedAt);
  });
});
