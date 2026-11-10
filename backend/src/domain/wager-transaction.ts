import { Money } from './money.js';

/** Tipos de operação reconhecidos pelo domínio e pelo schema inicial. */
export const WagerTransactionType = {
  OPENING: 'OPENING',
  BET: 'BET',
  WIN: 'WIN',
  LOSS: 'LOSS',
  REFUND: 'REFUND',
  ROLLBACK: 'ROLLBACK',
} as const;

/** Tipo derivado da lista única de operações para evitar divergência entre valores e tipos. */
export type WagerTransactionType =
  (typeof WagerTransactionType)[keyof typeof WagerTransactionType];

/** Tipos aceitos em operações recebidas de provedores por API ou fila. */
export type ExternalWagerTransactionType = Exclude<
  WagerTransactionType,
  typeof WagerTransactionType.OPENING
>;

/** Estados persistidos da máquina de estados de uma transação de aposta. */
export const WagerTransactionStatus = {
  PENDING: 'PENDING',
  PENDING_REFERENCE: 'PENDING_REFERENCE',
  PROCESSED: 'PROCESSED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
} as const;

/** Tipo derivado dos estados persistidos previstos no schema. */
export type WagerTransactionStatus =
  (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

/** Códigos de rejeição estáveis para motivos de negócio auditáveis. */
export const WagerRejectionCode = {
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  INVALID_REFERENCE: 'INVALID_REFERENCE',
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE:
    'ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE',
} as const;

/** Tipo derivado dos motivos que encerram uma operação como rejeitada. */
export type WagerRejectionCode =
  (typeof WagerRejectionCode)[keyof typeof WagerRejectionCode];

/** Código estável reservado para falhas técnicas definitivas do processamento. */
export const WagerFailureCode = {
  ...WagerRejectionCode,
  PROCESSING_FAILED: 'PROCESSING_FAILED',
} as const;

/** Tipo derivado de todos os códigos de falha serializáveis. */
export type WagerFailureCode =
  (typeof WagerFailureCode)[keyof typeof WagerFailureCode];

/** Campos imutáveis de identidade e negócio compartilhados pelas factories. */
export interface WagerTransactionData {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionType;
  amount: Money;
  currency: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  createdAt?: Date;
}

/** Entrada aceita para criar uma transação recebida externamente. */
export type WagerTransactionInput = Omit<WagerTransactionData, 'kind'> & {
  kind: ExternalWagerTransactionType;
};

/** Estado completo serializável necessário para restaurar a transação persistida. */
export interface WagerTransactionSnapshot extends WagerTransactionData {
  createdAt: Date;
  processedAt: Date | null;
  status: WagerTransactionStatus;
  failureCode: WagerFailureCode | null;
  responseBalance?: Money | null;
  referenceAttempts?: number;
  referenceNextAttemptAt?: Date | null;
}

/** Erro lançado quando os dados de identidade ou negócio não podem criar uma transação. */
export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

/** Erro lançado quando uma transição não é permitida para o estado atual. */
export class InvalidWagerTransitionError extends Error {
  constructor(from: WagerTransactionStatus, to: WagerTransactionStatus) {
    super(`Transição de transação inválida: ${from} -> ${to}.`);
    this.name = 'InvalidWagerTransitionError';
  }
}

const VALID_TRANSACTION_TYPES = new Set<string>(
  Object.values(WagerTransactionType),
);
const VALID_STATUSES = new Set<string>(Object.values(WagerTransactionStatus));
const REJECTION_CODES = new Set<string>(Object.values(WagerRejectionCode));
const FAILURE_CODES = new Set<string>(Object.values(WagerFailureCode));
const TERMINAL_STATUSES = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.PROCESSED,
  WagerTransactionStatus.REJECTED,
  WagerTransactionStatus.FAILED,
]);

/**
 * Transação de aposta do domínio com estados e transições controlados explicitamente.
 * O aggregate não depende de API, fila, NestJS ou MikroORM.
 */
export class WagerTransaction {
  private currentStatus: WagerTransactionStatus;
  private currentFailureCode: WagerFailureCode | null;
  private currentResponseBalance: Money | null;
  private currentReferenceAttempts: number;
  private currentReferenceNextAttemptAt: Date | null;
  private currentProcessedAt: Date | null;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionType,
    public readonly amount: Money,
    public readonly currency: string,
    public readonly referenceExternalTransactionId: string | null,
    public readonly referenceTransactionId: string | null,
    public readonly createdAt: Date,
    status: WagerTransactionStatus,
    failureCode: WagerFailureCode | null,
    responseBalance: Money | null,
    referenceAttempts: number,
    referenceNextAttemptAt: Date | null,
    processedAt: Date | null,
  ) {
    this.currentStatus = status;
    this.currentFailureCode = failureCode;
    this.currentResponseBalance = responseBalance;
    this.currentReferenceAttempts = referenceAttempts;
    this.currentReferenceNextAttemptAt = referenceNextAttemptAt;
    this.currentProcessedAt = processedAt;
  }

  /** Cria uma operação recebida de provedor no estado inicial PENDING. */
  static create(input: WagerTransactionInput): WagerTransaction {
    // A checagem em runtime também protege chamadas JavaScript e dados forçados por cast.
    if (String(input.kind) === WagerTransactionType.OPENING) {
      throw new InvalidWagerTransactionError(
        'OPENING é interno e não pode ser criado por uma entrada de provedor.',
      );
    }

    return WagerTransaction.createWithType(input, input.kind);
  }

  /** Cria OPENING somente por uma chamada explícita de código interno. */
  static createInternalOpening(
    input: Omit<WagerTransactionData, 'kind'>,
  ): WagerTransaction {
    return WagerTransaction.createWithType(input, WagerTransactionType.OPENING);
  }

  /** Restaura um snapshot validado sem executar nem simular transições anteriores. */
  static rehydrate(snapshot: WagerTransactionSnapshot): WagerTransaction {
    WagerTransaction.assertData(snapshot);
    WagerTransaction.assertStatusAndFailure(
      snapshot.status,
      snapshot.failureCode,
    );
    WagerTransaction.assertResponseBalance(
      snapshot.responseBalance ?? null,
      snapshot.currency,
    );
    WagerTransaction.assertReferenceRetryState(
      snapshot.referenceAttempts ?? 0,
      snapshot.referenceNextAttemptAt ?? null,
    );
    WagerTransaction.assertTemporalState(
      snapshot.createdAt,
      snapshot.processedAt,
      snapshot.status,
    );

    return new WagerTransaction(
      snapshot.id,
      snapshot.providerId,
      snapshot.externalTransactionId,
      snapshot.idempotencyKey,
      snapshot.payloadHash,
      snapshot.walletId,
      snapshot.playerId,
      snapshot.roundId,
      snapshot.gameId,
      snapshot.kind,
      snapshot.amount,
      snapshot.currency,
      snapshot.referenceExternalTransactionId ?? null,
      snapshot.referenceTransactionId ?? null,
      new Date(snapshot.createdAt),
      snapshot.status,
      snapshot.failureCode,
      snapshot.responseBalance ?? null,
      snapshot.referenceAttempts ?? 0,
      snapshot.referenceNextAttemptAt ?? null,
      snapshot.processedAt ? new Date(snapshot.processedAt) : null,
    );
  }

  /** Informa o estado atual, sem permitir que consumidores o alterem diretamente. */
  get status(): WagerTransactionStatus {
    return this.currentStatus;
  }

  /** Retorna o código estável associado a uma rejeição ou falha técnica. */
  get failureCode(): WagerFailureCode | null {
    return this.currentFailureCode;
  }

  /** Retorna o saldo capturado para compor a resposta original de idempotência. */
  get responseBalance(): Money | null {
    return this.currentResponseBalance;
  }

  get referenceAttempts(): number {
    return this.currentReferenceAttempts;
  }

  get referenceNextAttemptAt(): Date | null {
    return this.currentReferenceNextAttemptAt
      ? new Date(this.currentReferenceNextAttemptAt)
      : null;
  }

  get processedAt(): Date | null {
    return this.currentProcessedAt ? new Date(this.currentProcessedAt) : null;
  }

  /** Registra uma única vez o saldo observado durante o processamento da solicitação. */
  recordResponseBalance(balance: Money): void {
    if (
      this.currentResponseBalance !== null ||
      (this.currentStatus !== WagerTransactionStatus.PROCESSED &&
        this.currentStatus !== WagerTransactionStatus.REJECTED &&
        this.currentStatus !== WagerTransactionStatus.PENDING_REFERENCE)
    ) {
      throw new InvalidWagerTransitionError(
        this.currentStatus,
        this.currentStatus,
      );
    }
    WagerTransaction.assertResponseBalance(balance, this.currency);
    this.currentResponseBalance = balance;
  }

  /** Marca uma operação aguardando a chegada de sua transação de referência. */
  markPendingReference(nextAttemptAt: Date | null = null): void {
    WagerTransaction.assertReferenceRetryState(
      this.currentReferenceAttempts,
      nextAttemptAt,
    );
    this.transitionTo(WagerTransactionStatus.PENDING_REFERENCE, [
      WagerTransactionStatus.PENDING,
    ]);
    this.currentReferenceNextAttemptAt =
      nextAttemptAt === null ? null : new Date(nextAttemptAt);
  }

  recordReferenceRetry(nextAttemptAt: Date | null): void {
    if (this.currentStatus !== WagerTransactionStatus.PENDING_REFERENCE) {
      throw new InvalidWagerTransitionError(
        this.currentStatus,
        WagerTransactionStatus.PENDING_REFERENCE,
      );
    }
    const attempts = this.currentReferenceAttempts + 1;
    WagerTransaction.assertReferenceRetryState(attempts, nextAttemptAt);
    this.currentReferenceAttempts = attempts;
    this.currentReferenceNextAttemptAt =
      nextAttemptAt === null ? null : new Date(nextAttemptAt);
  }

  /** Retorna uma operação pendente de referência ao fluxo de processamento. */
  resumeAfterReference(): void {
    this.transitionTo(WagerTransactionStatus.PENDING, [
      WagerTransactionStatus.PENDING_REFERENCE,
    ]);
    this.currentReferenceNextAttemptAt = null;
  }

  /** Marca como processada uma operação aceita pelo fluxo financeiro. */
  markProcessed(at = new Date()): void {
    WagerTransaction.assertTerminalTimestamp(at);
    this.transitionTo(WagerTransactionStatus.PROCESSED, [
      WagerTransactionStatus.PENDING,
      WagerTransactionStatus.PENDING_REFERENCE,
    ]);
    this.currentProcessedAt = new Date(at);
    this.currentReferenceNextAttemptAt = null;
  }

  /** Encerra a operação com um motivo de negócio estável e legível por máquina. */
  reject(code: WagerRejectionCode, at = new Date()): void {
    WagerTransaction.assertTerminalTimestamp(at);
    if (!REJECTION_CODES.has(code)) {
      throw new InvalidWagerTransactionError(
        `Código de rejeição não reconhecido: ${String(code)}.`,
      );
    }
    this.transitionTo(WagerTransactionStatus.REJECTED, [
      WagerTransactionStatus.PENDING,
      WagerTransactionStatus.PENDING_REFERENCE,
    ]);
    this.currentFailureCode = code;
    this.currentProcessedAt = new Date(at);
    this.currentReferenceNextAttemptAt = null;
  }

  /** Encerra a operação por falha técnica definitiva com código estável. */
  fail(code: typeof WagerFailureCode.PROCESSING_FAILED, at = new Date()): void {
    WagerTransaction.assertTerminalTimestamp(at);
    if (code !== WagerFailureCode.PROCESSING_FAILED) {
      throw new InvalidWagerTransactionError(
        `Código de falha técnica não reconhecido: ${String(code)}.`,
      );
    }
    this.transitionTo(WagerTransactionStatus.FAILED, [
      WagerTransactionStatus.PENDING,
      WagerTransactionStatus.PENDING_REFERENCE,
    ]);
    this.currentFailureCode = code;
    this.currentProcessedAt = new Date(at);
    this.currentReferenceNextAttemptAt = null;
  }

  /** Indica se o estado já encerra definitivamente o ciclo da transação. */
  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.currentStatus);
  }

  /** Serializa o estado atual no formato usado para persistência e reidratação. */
  toSnapshot(): WagerTransactionSnapshot {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      amount: this.amount,
      currency: this.currency,
      createdAt: new Date(this.createdAt),
      processedAt: this.currentProcessedAt
        ? new Date(this.currentProcessedAt)
        : null,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      referenceTransactionId: this.referenceTransactionId,
      status: this.currentStatus,
      failureCode: this.currentFailureCode,
      referenceAttempts: this.currentReferenceAttempts,
      referenceNextAttemptAt: this.currentReferenceNextAttemptAt
        ? new Date(this.currentReferenceNextAttemptAt)
        : null,
      ...(this.currentResponseBalance
        ? { responseBalance: this.currentResponseBalance }
        : {}),
    };
  }

  /** Cria qualquer tipo após aplicar as mesmas validações de dados do domínio. */
  private static createWithType(
    input: Omit<WagerTransactionData, 'kind'>,
    kind: WagerTransactionType,
  ): WagerTransaction {
    WagerTransaction.assertData({ ...input, kind });

    return new WagerTransaction(
      input.id,
      input.providerId,
      input.externalTransactionId,
      input.idempotencyKey,
      input.payloadHash,
      input.walletId,
      input.playerId,
      input.roundId,
      input.gameId,
      kind,
      input.amount,
      input.currency,
      input.referenceExternalTransactionId ?? null,
      input.referenceTransactionId ?? null,
      new Date(input.createdAt ?? new Date()),
      WagerTransactionStatus.PENDING,
      null,
      null,
      0,
      null,
      null,
    );
  }

  /** Valida identidade, hash, tipo, valor e moeda da operação. */
  private static assertData(data: WagerTransactionData): void {
    const requiredText: Array<[string, string]> = [
      ['identificador', data.id],
      ['provedor', data.providerId],
      ['identificador externo', data.externalTransactionId],
      ['chave de idempotência', data.idempotencyKey],
      ['identificador da wallet', data.walletId],
      ['identificador do jogador', data.playerId],
      ['identificador da rodada', data.roundId],
      ['identificador do jogo', data.gameId],
    ];

    for (const [label, value] of requiredText) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new InvalidWagerTransactionError(
          `A transação deve possuir ${label}.`,
        );
      }
    }

    if (!/^[a-f\d]{64}$/i.test(data.payloadHash)) {
      throw new InvalidWagerTransactionError(
        'O hash do payload deve conter 64 caracteres hexadecimais.',
      );
    }
    if (!VALID_TRANSACTION_TYPES.has(data.kind)) {
      throw new InvalidWagerTransactionError(
        'Tipo de operação não reconhecido.',
      );
    }
    if (!(data.amount instanceof Money) || !data.amount.isPositive()) {
      throw new InvalidWagerTransactionError(
        'O valor da transação deve ser um Money positivo.',
      );
    }
    if (data.amount.currency !== data.currency) {
      throw new InvalidWagerTransactionError(
        'A moeda do valor deve corresponder à moeda da transação.',
      );
    }

    const hasExternalReference =
      typeof data.referenceExternalTransactionId === 'string' &&
      data.referenceExternalTransactionId.trim().length > 0;
    const hasInternalReference =
      typeof data.referenceTransactionId === 'string' &&
      data.referenceTransactionId.trim().length > 0;
    if (
      (data.referenceExternalTransactionId != null &&
        !hasExternalReference) ||
      (data.referenceTransactionId != null && !hasInternalReference) ||
      (hasExternalReference && hasInternalReference)
    ) {
      throw new InvalidWagerTransactionError(
        'A transação deve possuir no máximo uma referência válida.',
      );
    }

    const requiresReference =
      data.kind === WagerTransactionType.REFUND ||
      data.kind === WagerTransactionType.ROLLBACK;
    if (requiresReference && !hasExternalReference && !hasInternalReference) {
      throw new InvalidWagerTransactionError(
        'REFUND e ROLLBACK exigem uma transação de referência.',
      );
    }
    if (
      !requiresReference &&
      data.kind !== WagerTransactionType.WIN &&
      (hasExternalReference || hasInternalReference)
    ) {
      throw new InvalidWagerTransactionError(
        'Este tipo de transação não aceita uma referência.',
      );
    }
    if (
      data.createdAt !== undefined &&
      (!(data.createdAt instanceof Date) ||
        Number.isNaN(data.createdAt.getTime()))
    ) {
      throw new InvalidWagerTransactionError(
        'A data de criação da transação deve ser válida.',
      );
    }
  }

  private static assertTemporalState(
    createdAt: Date,
    processedAt: Date | null,
    status: WagerTransactionStatus,
  ): void {
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      throw new InvalidWagerTransactionError(
        'A data de criação da transação deve ser válida.',
      );
    }
    const terminal = TERMINAL_STATUSES.has(status);
    if (
      (processedAt !== null &&
        (!(processedAt instanceof Date) ||
          Number.isNaN(processedAt.getTime()))) ||
      (terminal !== (processedAt !== null)) ||
      (processedAt !== null && processedAt.getTime() < createdAt.getTime())
    ) {
      throw new InvalidWagerTransactionError(
        'As datas da transação não correspondem ao seu estado.',
      );
    }
  }

  private static assertTerminalTimestamp(at: Date): void {
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new InvalidWagerTransactionError(
        'A data de encerramento da transação deve ser válida.',
      );
    }
  }

  /** Valida que status e código de falha persistidos formam uma combinação coerente. */
  private static assertStatusAndFailure(
    status: WagerTransactionStatus,
    failureCode: WagerFailureCode | null,
  ): void {
    if (!VALID_STATUSES.has(status)) {
      throw new InvalidWagerTransactionError(
        'Estado da transação não reconhecido.',
      );
    }
    if (failureCode !== null && !FAILURE_CODES.has(failureCode)) {
      throw new InvalidWagerTransactionError(
        'Código de falha não reconhecido.',
      );
    }

    const validCombination =
      (status === WagerTransactionStatus.REJECTED &&
        failureCode !== null &&
        REJECTION_CODES.has(failureCode)) ||
      (status === WagerTransactionStatus.FAILED &&
        failureCode === WagerFailureCode.PROCESSING_FAILED) ||
      (!TERMINAL_STATUSES.has(status) && failureCode === null) ||
      (status === WagerTransactionStatus.PROCESSED && failureCode === null);

    if (!validCombination) {
      throw new InvalidWagerTransactionError(
        'O estado e o código de falha da transação são incompatíveis.',
      );
    }
  }

  /** Valida o saldo persistido da resposta sem permitir valor negativo ou moeda divergente. */
  private static assertResponseBalance(
    balance: Money | null,
    currency: string,
  ): void {
    if (
      balance !== null &&
      (!(balance instanceof Money) ||
        balance.currency !== currency ||
        balance.isNegative())
    ) {
      throw new InvalidWagerTransactionError(
        'O saldo da resposta deve ser não negativo e usar a moeda da transação.',
      );
    }
  }

  private static assertReferenceRetryState(
    attempts: number,
    nextAttemptAt: Date | null,
  ): void {
    if (
      !Number.isSafeInteger(attempts) ||
      attempts < 0 ||
      (nextAttemptAt !== null &&
        (!(nextAttemptAt instanceof Date) ||
          Number.isNaN(nextAttemptAt.getTime())))
    ) {
      throw new InvalidWagerTransactionError(
        'O estado de tentativas da referência é inválido.',
      );
    }
  }

  /** Aplica uma transição somente quando a origem está explicitamente autorizada. */
  private transitionTo(
    target: WagerTransactionStatus,
    allowedSources: readonly WagerTransactionStatus[],
  ): void {
    if (!allowedSources.includes(this.currentStatus) || this.isTerminal()) {
      throw new InvalidWagerTransitionError(this.currentStatus, target);
    }

    this.currentStatus = target;
    this.currentFailureCode = null;
    if (target !== WagerTransactionStatus.PENDING_REFERENCE) {
      this.currentReferenceNextAttemptAt = null;
    }
  }
}
