import { Money } from './money.js';

// O banco usa INTEGER para versionamento, cujo limite positivo é menor que o de Number seguro.
const MAX_WALLET_VERSION = 2_147_483_647;

/** Dados necessários para restaurar uma wallet persistida. */
export interface WalletSnapshot {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
}

/** Erro lançado quando uma operação tentaria deixar o saldo negativo. */
export class InsufficientBalanceError extends Error {
  constructor() {
    super('A wallet não possui saldo suficiente para esta operação.');
    this.name = 'InsufficientBalanceError';
  }
}

/** Erro lançado quando os dados de identidade ou versão da wallet são inválidos. */
export class InvalidWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletError';
  }
}

/**
 * Aggregate raiz que protege o saldo e a versão da wallet em memória.
 * A persistência e a concorrência entre processos serão responsabilidade das próximas camadas.
 */
export class Wallet {
  private currentBalance: Money;
  private currentVersion: number;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    balance: Money,
    version: number,
  ) {
    Wallet.assertIdentity(id, playerId);
    Wallet.assertVersion(version);

    if (balance.currency !== currency) {
      throw new InvalidWalletError(
        'A moeda do saldo deve corresponder à moeda da wallet.',
      );
    }
    if (balance.isNegative()) {
      throw new InvalidWalletError(
        'O saldo restaurado da wallet não pode ser negativo.',
      );
    }

    this.currentBalance = balance;
    this.currentVersion = version;
  }

  /** Abre uma wallet nova, com saldo zero e versão inicial zero. */
  static open(id: string, playerId: string, currency: string): Wallet {
    return new Wallet(id, playerId, currency, Money.zero(currency), 0);
  }

  /** Restaura o estado persistido após validar seus invariantes de domínio. */
  static rehydrate(snapshot: WalletSnapshot): Wallet {
    return new Wallet(
      snapshot.id,
      snapshot.playerId,
      snapshot.currency,
      snapshot.balance,
      snapshot.version,
    );
  }

  /** Retorna o saldo atual como value object imutável. */
  get balance(): Money {
    return this.currentBalance;
  }

  /** Retorna a versão usada para rastrear alterações e apoiar o controle concorrente. */
  get version(): number {
    return this.currentVersion;
  }

  /** Credita um valor positivo da mesma moeda e avança a versão uma vez. */
  credit(amount: Money): void {
    this.assertPositiveAmount(amount);
    const updatedBalance = this.currentBalance.add(amount);
    this.advanceVersion();
    this.currentBalance = updatedBalance;
  }

  /** Debita um valor positivo sem permitir saldo negativo e avança a versão uma vez. */
  debit(amount: Money): void {
    this.assertPositiveAmount(amount);

    if (this.currentBalance.isLessThan(amount)) {
      throw new InsufficientBalanceError();
    }

    const updatedBalance = this.currentBalance.subtract(amount);
    this.advanceVersion();
    this.currentBalance = updatedBalance;
  }

  /** Valida valor e moeda antes de qualquer mutação do aggregate. */
  private assertPositiveAmount(amount: Money): void {
    if (!amount.isPositive()) {
      throw new InvalidWalletError(
        'O valor da operação deve ser maior que zero.',
      );
    }
    if (amount.currency !== this.currency) {
      throw new InvalidWalletError(
        'A moeda da operação deve corresponder à moeda da wallet.',
      );
    }
  }

  /** Impede uma mutação quando a versão atingiria um inteiro não seguro. */
  private advanceVersion(): void {
    if (
      !Number.isSafeInteger(this.currentVersion + 1) ||
      this.currentVersion + 1 > MAX_WALLET_VERSION
    ) {
      throw new InvalidWalletError(
        'A versão da wallet excedeu o limite suportado.',
      );
    }
    this.currentVersion += 1;
  }

  /** Garante que a wallet sempre possa ser associada a um jogador. */
  private static assertIdentity(id: string, playerId: string): void {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new InvalidWalletError('A wallet deve possuir um identificador.');
    }
    if (typeof playerId !== 'string' || playerId.trim().length === 0) {
      throw new InvalidWalletError(
        'A wallet deve estar associada a um jogador.',
      );
    }
  }

  /** Aceita apenas versões inteiras não negativas que possam ser representadas com segurança. */
  private static assertVersion(version: number): void {
    if (
      !Number.isSafeInteger(version) ||
      version < 0 ||
      version > MAX_WALLET_VERSION
    ) {
      throw new InvalidWalletError(
        'A versão da wallet deve ser um inteiro não negativo seguro.',
      );
    }
  }
}
