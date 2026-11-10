import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  WALLET_LEDGER_ENTRY_REPOSITORY,
  WALLET_REPOSITORY,
  type WalletLedgerCursor,
  type WalletLedgerEntryRepositoryPort,
  type WalletRepositoryPort,
} from '../../application/ports/persistence.repositories.js';
import { CreateWalletUseCase } from '../../application/wallet-management/create-wallet.use-case.js';
import { Wallet } from '../../domain/wallet.js';
import { InvalidWagerRequestError } from './wager-transaction-request.dto.js';
import { CreateWalletRequestPipe } from './create-wallet-request.pipe.js';
import type { CreateWalletRequestDto } from './create-wallet-request.dto.js';
import { ReconcileWalletUseCase } from '../../application/wallet-management/reconcile-wallet.use-case.js';
import { MetricsService } from '../../observability/metrics.service.js';
import { StructuredLogger } from '../../observability/structured-logger.js';

interface WalletResource {
  walletId: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
}

interface DecodedLedgerCursor {
  createdAt: string;
  id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    @Inject(WALLET_REPOSITORY)
    private readonly wallets: WalletRepositoryPort,
    @Inject(WALLET_LEDGER_ENTRY_REPOSITORY)
    private readonly ledger: WalletLedgerEntryRepositoryPort,
    private readonly reconcileWallet: ReconcileWalletUseCase,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLogger,
  ) {}

  @Post()
  async create(
    @Body(CreateWalletRequestPipe) body: CreateWalletRequestDto,
  ): Promise<WalletResource> {
    return this.toResource(
      await this.createWallet.execute({
        playerId: body.playerId,
        currency: body.currency,
        initialBalance: body.initialBalance,
      }),
    );
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query('cursor') cursorValue?: string,
    @Query('limit') limitValue?: string,
  ) {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new NotFoundException();
    const cursor =
      cursorValue === undefined ? null : this.decodeCursor(cursorValue);
    const limit = this.parseLimit(limitValue);
    const page = await this.ledger.findPageByWallet(walletId, cursor, limit);
    const lastItem = page.items.at(-1);
    return {
      items: page.items.map(({ entry, createdAt }) => ({
        entryId: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.amount.toJSON().amount,
        currency: entry.currency,
        balanceBefore: entry.balanceBefore.toJSON().amount,
        balanceAfter: entry.balanceAfter.toJSON().amount,
        reversalOfTransactionId: entry.reversalOfTransactionId,
        createdAt,
      })),
      nextCursor:
        page.hasMore && lastItem
          ? this.encodeCursor({
              createdAt: lastItem.cursorAt,
              id: lastItem.entry.id,
            })
          : null,
    };
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    const result = await this.reconcileWallet.execute(walletId);
    if (!result) throw new NotFoundException();

    this.metrics.recordWalletReconciliation(result.isConsistent);
    if (!result.isConsistent) {
      this.logger.errorEvent('wallet_reconciliation_inconsistent', {
        walletId: result.walletId,
        currency: result.currency,
        walletBalance: result.walletBalance.toJSON().amount,
        ledgerBalance: result.ledgerBalance.toJSON().amount,
        difference: result.difference.toJSON().amount,
        entriesVerified: result.entriesVerified,
      });
    }

    return {
      walletId: result.walletId,
      currency: result.currency,
      walletBalance: result.walletBalance.toJSON().amount,
      ledgerBalance: result.ledgerBalance.toJSON().amount,
      difference: result.difference.toJSON().amount,
      isConsistent: result.isConsistent,
      entriesVerified: result.entriesVerified,
    };
  }

  @Get(':walletId')
  async get(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
  ): Promise<WalletResource> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new NotFoundException();
    return this.toResource(wallet);
  }

  private toResource(wallet: Wallet): WalletResource {
    return {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
    };
  }

  private parseLimit(value?: string): number {
    if (value === undefined) return 50;
    if (!/^\d+$/.test(value)) {
      throw new InvalidWagerRequestError([
        { field: 'limit', code: 'INVALID_PAGE_SIZE' },
      ]);
    }
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new InvalidWagerRequestError([
        { field: 'limit', code: 'INVALID_PAGE_SIZE' },
      ]);
    }
    return limit;
  }

  private decodeCursor(value: string): DecodedLedgerCursor {
    try {
      if (value.length > 512) throw new Error('Invalid cursor.');
      const decoded = Buffer.from(value, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as {
        createdAt?: unknown;
        id?: unknown;
      };
      if (
        Buffer.from(decoded).toString('base64url') !== value ||
        typeof parsed.createdAt !== 'string' ||
        typeof parsed.id !== 'string' ||
        !UUID_PATTERN.test(parsed.id)
      ) {
        throw new Error('Invalid cursor.');
      }
      const createdAt = new Date(parsed.createdAt);
      if (
        Number.isNaN(createdAt.getTime()) ||
        createdAt.toISOString() !== parsed.createdAt
      ) {
        throw new Error('Invalid cursor.');
      }
      return { createdAt: parsed.createdAt, id: parsed.id };
    } catch {
      throw new InvalidWagerRequestError([
        { field: 'cursor', code: 'INVALID_CURSOR' },
      ]);
    }
  }

  private encodeCursor(cursor: WalletLedgerCursor): string {
    return Buffer.from(
      JSON.stringify({
        createdAt: cursor.createdAt,
        id: cursor.id,
      }),
    ).toString('base64url');
  }
}
