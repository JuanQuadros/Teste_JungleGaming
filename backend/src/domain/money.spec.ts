import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, InvalidMoneyError, Money } from './money.js';

describe('Money', () => {
  // Confere a criação, a normalização e a serialização decimal sem ponto flutuante.
  describe('criação e serialização', () => {
    it('normaliza valores inteiros e decimais para duas casas', () => {
      expect(Money.from({ amount: '25', currency: 'BRL' }).toJSON()).toEqual({
        amount: '25.00',
        currency: 'BRL',
      });
      expect(Money.from({ amount: '25.5', currency: 'BRL' }).toString()).toBe('25.50 BRL');
    });

    it('mantém precisão em valores grandes dentro do limite do banco', () => {
      expect(Money.from({ amount: '999999999999999999.99', currency: 'BRL' }).toJSON()).toEqual({
        amount: '999999999999999999.99',
        currency: 'BRL',
      });
    });

    it('cria zero na moeda informada', () => {
      expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    });

    it('congela a instância para preservar sua imutabilidade', () => {
      expect(Object.isFrozen(Money.from({ amount: '1.00', currency: 'BRL' }))).toBe(true);
    });
  });

  // Rejeita entradas que podem causar perda de precisão ou moeda ambígua.
  describe('validação de entrada', () => {
    it.each(['', ' ', 'NaN', 'Infinity', '1e3', '-1.00', '+1.00', '1.234', '1.', '.50']) (
      'rejeita o valor inválido %s',
      (amount) => {
        expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
      },
    );

    it('rejeita valores fora da precisão numeric(20, 2)', () => {
      expect(() =>
        Money.from({ amount: '1000000000000000000.00', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    });

    it.each(['BR', 'brl', 'ZZZ', 'XXX'])('rejeita o código de moeda %s', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });
  });

  // Verifica as operações matemáticas e confirma que cada uma retorna outro Money.
  describe('operações', () => {
    it('soma e subtrai com precisão exata', () => {
      const original = Money.from({ amount: '0.10', currency: 'BRL' });
      const sum = original.add(Money.from({ amount: '0.20', currency: 'BRL' }));
      const difference = sum.subtract(Money.from({ amount: '0.05', currency: 'BRL' }));

      expect(sum.toJSON().amount).toBe('0.30');
      expect(difference.toJSON().amount).toBe('0.25');
      expect(original.toJSON().amount).toBe('0.10');
    });

    it('permite valores negativos produzidos por operações do domínio', () => {
      const negative = Money.from({ amount: '2.00', currency: 'BRL' }).negate();

      expect(negative.toJSON().amount).toBe('-2.00');
      expect(negative.isNegative()).toBe(true);
      expect(negative.isPositive()).toBe(false);
    });

    it('identifica zero, valores positivos e ordenação', () => {
      const zero = Money.zero('BRL');
      const one = Money.from({ amount: '1.00', currency: 'BRL' });

      expect(zero.isZero()).toBe(true);
      expect(one.isPositive()).toBe(true);
      expect(one.isLessThan(Money.from({ amount: '2.00', currency: 'BRL' }))).toBe(true);
      expect(one.equals(Money.from({ amount: '1.0', currency: 'BRL' }))).toBe(true);
    });

    it('rejeita soma, subtração e comparação entre moedas diferentes', () => {
      const reais = Money.from({ amount: '1.00', currency: 'BRL' });
      const dólares = Money.from({ amount: '1.00', currency: 'USD' });

      expect(() => reais.add(dólares)).toThrow(CurrencyMismatchError);
      expect(() => reais.subtract(dólares)).toThrow(CurrencyMismatchError);
      expect(() => reais.isLessThan(dólares)).toThrow(CurrencyMismatchError);
      expect(() => reais.equals(dólares)).toThrow(CurrencyMismatchError);
    });
  });
});
