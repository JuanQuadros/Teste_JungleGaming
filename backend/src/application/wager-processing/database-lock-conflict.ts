const POSTGRES_LOCK_CONFLICT_CODES = new Set(['40P01', '55P03', '40001']);

export function isDatabaseLockConflict(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;

  while (typeof current === 'object' && current !== null) {
    if (visited.has(current)) return false;
    visited.add(current);

    const record = current as Record<string, unknown>;
    if (
      typeof record.code === 'string' &&
      POSTGRES_LOCK_CONFLICT_CODES.has(record.code)
    ) {
      return true;
    }
    current = record.cause;
  }

  return false;
}
