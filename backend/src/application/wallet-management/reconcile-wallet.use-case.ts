import { Inject, Injectable } from '@nestjs/common';
import {
  WALLET_LEDGER_ENTRY_REPOSITORY,
  type WalletLedgerEntryRepositoryPort,
} from '../ports/persistence.repositories.js';
import { Money } from '../../domain/money.js';

export interface WalletReconciliationResult {
  walletId: string;
  currency: string;
  walletBalance: Money;
  ledgerBalance: Money;
  difference: Money;
  isConsistent: boolean;
  entriesVerified: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(WALLET_LEDGER_ENTRY_REPOSITORY)
    private readonly ledger: WalletLedgerEntryRepositoryPort,
  ) {}

  async execute(walletId: string): Promise<WalletReconciliationResult | null> {
    const snapshot = await this.ledger.reconcileWallet(walletId);
    if (!snapshot) return null;
    if (snapshot.currencyMismatchCount !== 0) {
      throw new Error(
        'O ledger contém lançamentos com moeda diferente da wallet.',
      );
    }

    const difference = snapshot.walletBalance.subtract(snapshot.ledgerBalance);
    return {
      walletId,
      currency: snapshot.currency,
      walletBalance: snapshot.walletBalance,
      ledgerBalance: snapshot.ledgerBalance,
      difference,
      isConsistent: difference.isZero(),
      entriesVerified: snapshot.entryCount,
    };
  }
}
