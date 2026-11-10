/** Conflito de chave de negócio ao criar uma segunda wallet do jogador. */
export class WalletAlreadyExistsError extends Error {
  constructor() {
    super('Já existe uma wallet para este jogador e moeda.');
    this.name = 'WalletAlreadyExistsError';
  }
}
