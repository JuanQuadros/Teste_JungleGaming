export class IdempotencyConflictError extends Error {
  constructor() {
    super('A chave de idempotência já foi usada com outra solicitação.');
    this.name = 'IdempotencyConflictError';
  }
}

export class TransientInfrastructureError extends Error {
  constructor() {
    super('O serviço está temporariamente indisponível.');
    this.name = 'TransientInfrastructureError';
  }
}
