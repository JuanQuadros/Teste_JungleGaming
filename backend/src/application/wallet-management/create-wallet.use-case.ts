import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Money } from '../../domain/money.js';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionType,
} from '../../domain/wager-transaction.js';
import { Wallet } from '../../domain/wallet.js';
import {
  WALLET_CREATION_UNIT_OF_WORK,
  type WalletCreationUnitOfWorkPort,
} from '../ports/persistence.repositories.js';

export interface CreateWalletInput {
  playerId: string;
  currency: string;
  initialBalance: Money;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(WALLET_CREATION_UNIT_OF_WORK)
    private readonly unitOfWork: WalletCreationUnitOfWorkPort,
  ) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const wallet = Wallet.open(randomUUID(), input.playerId, input.currency);
    let openingTransaction: WagerTransaction | null = null;
    let openingEntry: WalletLedgerEntry | null = null;

    if (input.initialBalance.isPositive()) {
      wallet.credit(input.initialBalance);
      const openingId = randomUUID();
      const internalKey = `internal:opening:${wallet.id}`;
      openingTransaction = WagerTransaction.createInternalOpening({
        id: openingId,
        providerId: 'internal',
        externalTransactionId: internalKey,
        idempotencyKey: internalKey,
        payloadHash: createHash('sha256')
          .update(
            JSON.stringify({
              amount: input.initialBalance.toJSON().amount,
              currency: input.currency,
              kind: WagerTransactionType.OPENING,
              walletId: wallet.id,
            }),
          )
          .digest('hex'),
        walletId: wallet.id,
        playerId: input.playerId,
        roundId: 'internal',
        gameId: 'internal',
        amount: input.initialBalance,
        currency: input.currency,
      });
      openingTransaction.markProcessed();
      openingTransaction.recordResponseBalance(wallet.balance);
      openingEntry = WalletLedgerEntry.createForTransaction({
        id: randomUUID(),
        transaction: openingTransaction,
        balanceBefore: Money.zero(input.currency),
      });
    }

    await this.unitOfWork.create(wallet, openingTransaction, openingEntry);
    return wallet;
  }
}
