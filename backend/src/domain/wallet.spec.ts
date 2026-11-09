import { describe, expect, it } from 'vitest';
import { Money } from './money.js';
import {
  InsufficientBalanceError,
  InvalidWalletError,
  Wallet,
} from './wallet.js';

const money = (amount: string, currency = 'BRL') =>
  Money.from({ amount, currency });

describe('Wallet', () => {
  // Confere que uma wallet nova começa sem saldo e com versão zero.
  it('abre com saldo zero na moeda informada e versão inicial zero', () => {
    const wallet = Wallet.open('wallet-1', 'player-1', 'BRL');

    expect(wallet.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(0);
  });

  // Garante que todo crédito aumenta o saldo e avança a versão uma única vez.
  it('credita valores positivos da mesma moeda e incrementa a versão', () => {
    const wallet = Wallet.open('wallet-1', 'player-1', 'BRL');

    wallet.credit(money('25.50'));

    expect(wallet.balance.toJSON()).toEqual({
      amount: '25.50',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
  });

  // Garante que o saldo nunca fica abaixo de zero, inclusive quando o débito é igual ao saldo.
  it('debita até zerar o saldo e incrementa a versão', () => {
    const wallet = Wallet.open('wallet-1', 'player-1', 'BRL');
    wallet.credit(money('25.50'));

    wallet.debit(money('25.50'));

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  // Rejeita débito sem saldo suficiente e mantém o estado anterior intacto.
  it('rejeita débito maior que o saldo sem alterar saldo ou versão', () => {
    const wallet = Wallet.open('wallet-1', 'player-1', 'BRL');
    wallet.credit(money('10.00'));

    expect(() => wallet.debit(money('10.01'))).toThrow(
      InsufficientBalanceError,
    );
    expect(wallet.balance.toJSON().amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  // Rejeita moeda incompatível antes de alterar o estado da wallet.
  it('rejeita operações com moeda diferente sem alterar o estado', () => {
    const wallet = Wallet.open('wallet-1', 'player-1', 'BRL');

    expect(() => wallet.credit(money('1.00', 'USD'))).toThrow(
      InvalidWalletError,
    );
    expect(() => wallet.debit(money('1.00', 'USD'))).toThrow(
      InvalidWalletError,
    );
    expect(wallet.balance.toJSON().amount).toBe('0.00');
    expect(wallet.version).toBe(0);
  });

  // Operações inválidas, como zero ou valor negativo, não podem gerar lançamentos implícitos.
  it('rejeita valores de operação zero ou negativos sem incrementar a versão', () => {
    const wallet = Wallet.open('wallet-1', 'player-1', 'BRL');

    expect(() => wallet.credit(Money.zero('BRL'))).toThrow(InvalidWalletError);
    expect(() => wallet.debit(Money.zero('BRL'))).toThrow(InvalidWalletError);
    expect(() => wallet.credit(money('1.00').negate())).toThrow(
      InvalidWalletError,
    );
    expect(wallet.version).toBe(0);
  });

  // Restaura wallets persistidas e verifica os invariantes de moeda, saldo e versão.
  it('rehydrate valida e restaura uma wallet sem alterar a versão', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: money('12.34'),
      version: 7,
    });

    expect(wallet.balance.toJSON().amount).toBe('12.34');
    expect(wallet.version).toBe(7);
  });

  // Dados persistidos inconsistentes precisam ser rejeitados ao reconstruir o aggregate.
  it('rejeita saldo de moeda diferente ou saldo negativo ao restaurar', () => {
    expect(() =>
      Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: money('1.00', 'USD'),
        version: 1,
      }),
    ).toThrow(InvalidWalletError);

    expect(() =>
      Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: money('1.00').negate(),
        version: 1,
      }),
    ).toThrow(InvalidWalletError);
  });

  // A versão deve ser inteira, não negativa e segura para controle concorrente.
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejeita a versão inválida %s ao restaurar',
    (version) => {
      expect(() =>
        Wallet.rehydrate({
          id: 'wallet-1',
          playerId: 'player-1',
          currency: 'BRL',
          balance: money('0.00'),
          version,
        }),
      ).toThrow(InvalidWalletError);
    },
  );
});
