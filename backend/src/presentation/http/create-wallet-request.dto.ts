import { InvalidMoneyError, Money } from '../../domain/money.js';
import {
  InvalidWagerRequestError,
  type RequestValidationIssue,
} from './wager-transaction-request.dto.js';

export interface CreateWalletRequestDto {
  playerId: string;
  currency: string;
  initialBalance: Money;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCreateWalletRequest(
  value: unknown,
): CreateWalletRequestDto {
  const issues: RequestValidationIssue[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidWagerRequestError([
      { field: 'body', code: 'OBJECT_REQUIRED' },
    ]);
  }

  const body = value as Record<string, unknown>;
  for (const field of Object.keys(body)) {
    if (!['playerId', 'currency', 'initialBalance'].includes(field)) {
      issues.push({ field, code: 'UNKNOWN_FIELD' });
    }
  }
  if (typeof body.playerId !== 'string' || !UUID_PATTERN.test(body.playerId)) {
    issues.push({ field: 'playerId', code: 'INVALID_UUID' });
  }
  if (typeof body.currency !== 'string') {
    issues.push({ field: 'currency', code: 'ISO_CURRENCY_REQUIRED' });
  }

  const rawBalance = body.initialBalance ?? '0.00';
  let initialBalance: Money | undefined;
  let validCurrency = false;
  if (typeof body.currency === 'string') {
    try {
      Money.zero(body.currency);
      validCurrency = true;
    } catch (error) {
      if (!(error instanceof InvalidMoneyError)) throw error;
      issues.push({ field: 'currency', code: 'INVALID_ISO_CURRENCY' });
    }
  }
  if (typeof rawBalance !== 'string') {
    issues.push({ field: 'initialBalance', code: 'DECIMAL_STRING_REQUIRED' });
  } else if (typeof body.currency === 'string' && validCurrency) {
    try {
      initialBalance = Money.from({
        amount: rawBalance,
        currency: body.currency,
      });
    } catch (error) {
      if (!(error instanceof InvalidMoneyError)) throw error;
      issues.push({
        field: 'initialBalance',
        code: 'INVALID_DECIMAL_AMOUNT',
      });
    }
  }

  if (issues.length > 0 || !initialBalance) {
    throw new InvalidWagerRequestError(issues);
  }
  return {
    playerId: body.playerId as string,
    currency: initialBalance.currency,
    initialBalance,
  };
}
