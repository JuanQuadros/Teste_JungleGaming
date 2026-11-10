import {
  down as initialDown,
  name as initialName,
  up as initialUp,
} from './001-initial-structure.js';
import {
  down as ledgerReversalsDown,
  name as ledgerReversalsName,
  up as ledgerReversalsUp,
} from './002-ledger-reversals.js';
import {
  down as walletVersionZeroDown,
  name as walletVersionZeroName,
  up as walletVersionZeroUp,
} from './003-wallet-version-zero.js';
import {
  down as idempotencyResponseBalanceDown,
  name as idempotencyResponseBalanceName,
  up as idempotencyResponseBalanceUp,
} from './004-idempotency-response-balance.js';
import {
  down as pendingReferenceRetriesDown,
  name as pendingReferenceRetriesName,
  up as pendingReferenceRetriesUp,
} from './005-pending-reference-retries.js';
import {
  down as walletVersionOneDown,
  name as walletVersionOneName,
  up as walletVersionOneUp,
} from './006-wallet-version-one.js';
import {
  down as walletLedgerBalanceDown,
  name as walletLedgerBalanceName,
  up as walletLedgerBalanceUp,
} from './007-wallet-ledger-balance-consistency.js';
import {
  down as ledgerTruncateProtectionDown,
  name as ledgerTruncateProtectionName,
  up as ledgerTruncateProtectionUp,
} from './008-ledger-truncate-protection.js';

export const migrations = [
  { name: initialName, up: initialUp, down: initialDown },
  {
    name: ledgerReversalsName,
    up: ledgerReversalsUp,
    down: ledgerReversalsDown,
  },
  {
    name: walletVersionZeroName,
    up: walletVersionZeroUp,
    down: walletVersionZeroDown,
  },
  {
    name: idempotencyResponseBalanceName,
    up: idempotencyResponseBalanceUp,
    down: idempotencyResponseBalanceDown,
  },
  {
    name: pendingReferenceRetriesName,
    up: pendingReferenceRetriesUp,
    down: pendingReferenceRetriesDown,
  },
  {
    name: walletVersionOneName,
    up: walletVersionOneUp,
    down: walletVersionOneDown,
  },
  {
    name: walletLedgerBalanceName,
    up: walletLedgerBalanceUp,
    down: walletLedgerBalanceDown,
  },
  {
    name: ledgerTruncateProtectionName,
    up: ledgerTruncateProtectionUp,
    down: ledgerTruncateProtectionDown,
  },
];
