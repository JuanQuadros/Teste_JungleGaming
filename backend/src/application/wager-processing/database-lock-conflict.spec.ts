import { describe, expect, it } from 'vitest';
import { isDatabaseLockConflict } from './database-lock-conflict.js';

describe('isDatabaseLockConflict', () => {
  it.each(['40P01', '55P03', '40001'])(
    'recognizes PostgreSQL lock conflict code %s',
    (code) => {
      expect(isDatabaseLockConflict({ code })).toBe(true);
    },
  );

  it('recognizes a wrapped lock conflict and avoids cycles', () => {
    const error: { code?: string; cause?: unknown } = {
      cause: { code: '55P03' },
    };
    error.cause = error;

    expect(isDatabaseLockConflict(error)).toBe(false);
    expect(isDatabaseLockConflict({ cause: { code: '40P01' } })).toBe(true);
  });

  it('does not classify unrelated or non-database errors as lock conflicts', () => {
    expect(isDatabaseLockConflict(new Error('unavailable'))).toBe(false);
    expect(isDatabaseLockConflict({ code: '23505' })).toBe(false);
  });
});
