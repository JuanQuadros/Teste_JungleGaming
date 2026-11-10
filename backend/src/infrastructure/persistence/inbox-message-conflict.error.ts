export class InboxMessageConflictError extends Error {
  constructor() {
    super('An SQS message identifier was reused with a different payload.');
    this.name = 'InboxMessageConflictError';
  }
}
