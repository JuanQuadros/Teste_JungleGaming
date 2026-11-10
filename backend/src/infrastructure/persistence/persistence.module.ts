import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import {
  WALLET_LEDGER_ENTRY_REPOSITORY,
  WALLET_TRANSACTION_UNIT_OF_WORK,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY,
} from '../../application/ports/persistence.repositories.js';
import {
  InboxMessageEntity,
  OutboxMessageEntity,
  WalletEntity,
  WalletLedgerEntryEntity,
  WagerTransactionEntity,
} from './entities/index.js';
import {
  MikroOrmWalletLedgerEntryRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './repositories/index.js';
import { MikroOrmWalletTransactionUnitOfWork } from './mikro-orm-wallet-transaction.unit-of-work.js';

/** Disponibiliza entidades e adaptadores de persistência para módulos da aplicação. */
@Module({
  imports: [
    MikroOrmModule.forFeature([
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      InboxMessageEntity,
      OutboxMessageEntity,
    ]),
  ],
  providers: [
    MikroOrmWalletRepository,
    MikroOrmWagerTransactionRepository,
    MikroOrmWalletLedgerEntryRepository,
    MikroOrmWalletTransactionUnitOfWork,
    { provide: WALLET_REPOSITORY, useExisting: MikroOrmWalletRepository },
    {
      provide: WAGER_TRANSACTION_REPOSITORY,
      useExisting: MikroOrmWagerTransactionRepository,
    },
    {
      provide: WALLET_LEDGER_ENTRY_REPOSITORY,
      useExisting: MikroOrmWalletLedgerEntryRepository,
    },
    {
      provide: WALLET_TRANSACTION_UNIT_OF_WORK,
      useExisting: MikroOrmWalletTransactionUnitOfWork,
    },
  ],
  exports: [
    WALLET_REPOSITORY,
    WAGER_TRANSACTION_REPOSITORY,
    WALLET_LEDGER_ENTRY_REPOSITORY,
    WALLET_TRANSACTION_UNIT_OF_WORK,
  ],
})
export class PersistenceModule {}
