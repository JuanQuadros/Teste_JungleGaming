import { InvalidMoneyError, Money } from '../../domain/money.js';
import { WagerTransactionType } from '../../domain/wager-transaction.js';

export interface WagerTransactionRequestDto {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<
    (typeof WagerTransactionType)[keyof typeof WagerTransactionType],
    typeof WagerTransactionType.OPENING
  >;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
}

export interface RequestValidationIssue {
  field: string;
  code: string;
}

const REQUIRED_TEXT_FIELDS = [
  'providerId',
  'externalTransactionId',
  'walletId',
  'playerId',
  'roundId',
  'gameId',
] as const;

const ALLOWED_FIELDS = new Set<string>([
  ...REQUIRED_TEXT_FIELDS,
  'kind',
  'amount',
  'currency',
  'referenceExternalTransactionId',
  'referenceTransactionId',
]);

const EXTERNAL_TRANSACTION_TYPES = new Set<string>([
  WagerTransactionType.BET,
  WagerTransactionType.WIN,
  WagerTransactionType.LOSS,
  WagerTransactionType.REFUND,
  WagerTransactionType.ROLLBACK,
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidWagerRequestError extends Error {
  constructor(readonly issues: readonly RequestValidationIssue[]) {
    super('A solicitação da transação contém campos inválidos.');
    this.name = 'InvalidWagerRequestError';
  }
}

export function parseWagerTransactionRequest(
  value: unknown,
): WagerTransactionRequestDto {
  const issues: RequestValidationIssue[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidWagerRequestError([
      { field: 'body', code: 'OBJECT_REQUIRED' },
    ]);
  }

  const body = value as Record<string, unknown>;
  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) {
      issues.push({ field, code: 'UNKNOWN_FIELD' });
    }
  }

  for (const field of REQUIRED_TEXT_FIELDS) {
    const fieldValue = body[field];
    if (
      typeof fieldValue !== 'string' ||
      fieldValue.trim().length === 0 ||
      fieldValue.length > 256
    ) {
      issues.push({ field, code: 'NON_EMPTY_STRING_REQUIRED' });
    }
  }
  for (const field of ['walletId', 'playerId'] as const) {
    if (typeof body[field] === 'string' && !UUID_PATTERN.test(body[field])) {
      issues.push({ field, code: 'INVALID_UUID' });
    }
  }

  if (
    typeof body.kind !== 'string' ||
    !EXTERNAL_TRANSACTION_TYPES.has(body.kind)
  ) {
    issues.push({ field: 'kind', code: 'UNSUPPORTED_TRANSACTION_TYPE' });
  }

  if (typeof body.amount !== 'string') {
    issues.push({ field: 'amount', code: 'DECIMAL_STRING_REQUIRED' });
  }
  if (typeof body.currency !== 'string') {
    issues.push({ field: 'currency', code: 'ISO_CURRENCY_REQUIRED' });
  }

  let amount: Money | undefined;
  if (typeof body.amount === 'string' && typeof body.currency === 'string') {
    let validCurrency = true;
    try {
      Money.zero(body.currency);
    } catch (error) {
      if (!(error instanceof InvalidMoneyError)) throw error;
      validCurrency = false;
      issues.push({ field: 'currency', code: 'INVALID_ISO_CURRENCY' });
    }

    if (validCurrency) {
      try {
        amount = Money.from({ amount: body.amount, currency: body.currency });
        if (!amount.isPositive()) {
          issues.push({ field: 'amount', code: 'POSITIVE_AMOUNT_REQUIRED' });
        }
      } catch (error) {
        if (!(error instanceof InvalidMoneyError)) throw error;
        issues.push({ field: 'amount', code: 'INVALID_DECIMAL_AMOUNT' });
      }
    }
  }

  for (const field of [
    'referenceExternalTransactionId',
    'referenceTransactionId',
  ] as const) {
    const fieldValue = body[field];
    if (
      fieldValue !== undefined &&
      (typeof fieldValue !== 'string' ||
        fieldValue.trim().length === 0 ||
        fieldValue.length > 256)
    ) {
      issues.push({ field, code: 'NON_EMPTY_STRING_REQUIRED' });
    }
  }

  if (
    (body.kind === WagerTransactionType.REFUND ||
      body.kind === WagerTransactionType.ROLLBACK) &&
    typeof body.referenceExternalTransactionId !== 'string' &&
    typeof body.referenceTransactionId !== 'string'
  ) {
    issues.push({ field: 'reference', code: 'REFERENCE_REQUIRED' });
  }
  if (
    typeof body.referenceExternalTransactionId === 'string' &&
    typeof body.referenceTransactionId === 'string'
  ) {
    issues.push({ field: 'reference', code: 'REFERENCE_MUST_BE_UNAMBIGUOUS' });
  }
  if (
    typeof body.referenceTransactionId === 'string' &&
    !UUID_PATTERN.test(body.referenceTransactionId)
  ) {
    issues.push({ field: 'referenceTransactionId', code: 'INVALID_UUID' });
  }

  if (issues.length > 0 || !amount) {
    throw new InvalidWagerRequestError(issues);
  }

  return {
    providerId: body.providerId as string,
    externalTransactionId: body.externalTransactionId as string,
    walletId: body.walletId as string,
    playerId: body.playerId as string,
    roundId: body.roundId as string,
    gameId: body.gameId as string,
    kind: body.kind as WagerTransactionRequestDto['kind'],
    amount: amount.toJSON().amount,
    currency: amount.currency,
    ...(typeof body.referenceExternalTransactionId === 'string'
      ? { referenceExternalTransactionId: body.referenceExternalTransactionId }
      : {}),
    ...(typeof body.referenceTransactionId === 'string'
      ? { referenceTransactionId: body.referenceTransactionId }
      : {}),
  };
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new InvalidWagerRequestError([
      { field: 'Idempotency-Key', code: 'INVALID_IDEMPOTENCY_KEY' },
    ]);
  }
  return value;
}

export interface QueueWagerTransactionMessage {
  idempotencyKey: string;
  transaction: WagerTransactionRequestDto;
}

export function parseQueueWagerTransactionMessage(
  value: unknown,
): QueueWagerTransactionMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidWagerRequestError([
      { field: 'message', code: 'OBJECT_REQUIRED' },
    ]);
  }
  const message = value as Record<string, unknown>;
  const issues: RequestValidationIssue[] = [];
  for (const field of Object.keys(message)) {
    if (field !== 'idempotencyKey' && field !== 'transaction') {
      issues.push({ field, code: 'UNKNOWN_FIELD' });
    }
  }
  let idempotencyKey: string | null = null;
  try {
    idempotencyKey = parseIdempotencyKey(message.idempotencyKey);
  } catch (error) {
    if (!(error instanceof InvalidWagerRequestError)) throw error;
    issues.push(...error.issues);
  }
  let transaction: WagerTransactionRequestDto | null = null;
  try {
    transaction = parseWagerTransactionRequest(message.transaction);
  } catch (error) {
    if (!(error instanceof InvalidWagerRequestError)) throw error;
    issues.push(...error.issues);
  }
  if (issues.length > 0 || !idempotencyKey || !transaction) {
    throw new InvalidWagerRequestError(issues);
  }
  return { idempotencyKey, transaction };
}
