import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import {
  WALLET_LEDGER_ENTRY_REPOSITORY,
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
    { provide: WALLET_REPOSITORY, useExisting: MikroOrmWalletRepository },
    {
      provide: WAGER_TRANSACTION_REPOSITORY,
      useExisting: MikroOrmWagerTransactionRepository,
    },
    {
      provide: WALLET_LEDGER_ENTRY_REPOSITORY,
      useExisting: MikroOrmWalletLedgerEntryRepository,
    },
  ],
  exports: [
    WALLET_REPOSITORY,
    WAGER_TRANSACTION_REPOSITORY,
    WALLET_LEDGER_ENTRY_REPOSITORY,
  ],
})
export class PersistenceModule {}
