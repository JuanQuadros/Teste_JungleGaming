// Mantém o contrato de importação HTTP enquanto o erro pertence à camada de aplicação.
export { IdempotencyConflictError } from '../../application/wager-processing/idempotency-conflict.error.js';

export class TransientInfrastructureError extends Error {
  constructor() {
    super('O serviço está temporariamente indisponível.');
    this.name = 'TransientInfrastructureError';
  }
}
