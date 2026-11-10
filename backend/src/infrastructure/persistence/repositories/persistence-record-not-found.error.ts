/** Erro de persistência para uma tentativa de atualizar um registro ausente. */
export class PersistenceRecordNotFoundError extends Error {
  constructor(entityName: string, id: string) {
    super(`Registro ${entityName} não encontrado: ${id}.`);
    this.name = 'PersistenceRecordNotFoundError';
  }
}
