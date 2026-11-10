/** Erro estável para reutilização de chave com dados de negócio diferentes. */
export class IdempotencyConflictError extends Error {
  constructor() {
    super('A chave de idempotência já foi usada com outra solicitação.');
    this.name = 'IdempotencyConflictError';
  }
}
