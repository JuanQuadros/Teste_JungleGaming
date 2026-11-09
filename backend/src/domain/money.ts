/** Dados decimais usados nas fronteiras HTTP e na serialização. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Erro de domínio para valores ou moedas que não podem ser representados. */
export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

/** Erro de domínio lançado ao operar valores de moedas diferentes. */
export class CurrencyMismatchError extends Error {
  constructor(leftCurrency: string, rightCurrency: string) {
    super(`Não é possível operar moedas diferentes: ${leftCurrency} e ${rightCurrency}.`);
    this.name = 'CurrencyMismatchError';
  }
}

// O schema inicial usa NUMERIC(20, 2), portanto o domínio respeita a mesma precisão.
const MAX_CENTS = 10n ** 20n - 1n;

// Usa a lista de moedas reconhecida pelo runtime e exclui o código que significa "sem moeda".
const ISO_CURRENCY_CODES = new Set(
  Intl.supportedValuesOf('currency').filter((currency) => currency !== 'XXX'),
);

/**
 * Value object imutável para dinheiro, armazenado internamente como centavos BigInt.
 * Assim, nenhuma operação monetária depende de ponto flutuante.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    // Impede valores que não caberiam na precisão definida para a coluna do banco.
    if (cents > MAX_CENTS || cents < -MAX_CENTS) {
      throw new InvalidMoneyError('O valor excede a precisão monetária suportada.');
    }

    // Congela a instância também em tempo de execução, não apenas no sistema de tipos.
    Object.freeze(this);
  }

  /** Cria um Money a partir de uma string decimal não negativa e de um código de moeda. */
  static from(props: MoneyProps): Money {
    if (!props || typeof props !== 'object') {
      throw new InvalidMoneyError('Informe valor e moeda.');
    }

    if (typeof props.currency !== 'string' || !ISO_CURRENCY_CODES.has(props.currency)) {
      throw new InvalidMoneyError('Informe um código de moeda ISO 4217 válido.');
    }

    if (typeof props.amount !== 'string') {
      throw new InvalidMoneyError('O valor monetário deve ser uma string decimal.');
    }

    // Aceita até duas casas decimais e rejeita sinais, expoentes, espaços e valores especiais.
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(props.amount);
    if (!match) {
      throw new InvalidMoneyError(
        'Use um valor decimal não negativo com no máximo duas casas decimais.',
      );
    }

    const integerPart = match[1].replace(/^0+(?=\d)/, '');
    if (integerPart.length > 18) {
      throw new InvalidMoneyError('O valor excede a precisão monetária suportada.');
    }

    // Converte a parte decimal diretamente para BigInt, sem passar por Number.
    const wholeCents = BigInt(integerPart) * 100n;
    const fractionalCents = BigInt((match[2] ?? '').padEnd(2, '0'));

    return new Money(wholeCents + fractionalCents, props.currency);
  }

  /** Cria zero na moeda informada, validando-a pelas mesmas regras de from(). */
  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  /** Soma dois valores da mesma moeda e retorna uma nova instância. */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  /** Subtrai dois valores da mesma moeda e permite resultado negativo no domínio. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  /** Inverte o sinal do valor sem alterar a instância original. */
  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  /** Indica se o valor é exatamente zero. */
  isZero(): boolean {
    return this.cents === 0n;
  }

  /** Indica se o valor é maior que zero. */
  isPositive(): boolean {
    return this.cents > 0n;
  }

  /** Indica se o valor é menor que zero. */
  isNegative(): boolean {
    return this.cents < 0n;
  }

  /** Compara a ordem de dois valores da mesma moeda. */
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  /** Compara valores e moeda; comparar moedas diferentes é um erro de domínio. */
  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  /** Serializa o valor sempre com duas casas decimais. */
  toJSON(): MoneyProps {
    const sign = this.cents < 0n ? '-' : '';
    const absoluteCents = this.cents < 0n ? -this.cents : this.cents;
    const wholeUnits = absoluteCents / 100n;
    const fractionalCents = (absoluteCents % 100n).toString().padStart(2, '0');

    return {
      amount: `${sign}${wholeUnits}.${fractionalCents}`,
      currency: this.currency,
    };
  }

  /** Formata o valor e a moeda para leitura em logs ou depuração. */
  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  /** Impede operações aritméticas ou comparações entre moedas diferentes. */
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
