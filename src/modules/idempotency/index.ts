// The idempotency module's public API (plan 000 section 2): the key parser, the fingerprint, the
// table of what is stored, the runner of the key step and its ports. The composition root imports
// the adapters directly.
export { IdempotencyKeyReused } from './domain/errors.js';
export { canonicalJson, fingerprint } from './domain/fingerprint.js';
export { parseIdempotencyKey, type ParsedIdempotencyKey } from './domain/idempotency-key.js';
export {
  decide,
  isStored,
  type Decision,
  type Ending,
  type Outcome,
  type OutcomeStep,
  type StoredHeaders,
  type StoredResponse,
} from './domain/outcome.js';
export {
  IdempotentRunner,
  type KeyedAnswer,
  type KeyedRequest,
} from './application/idempotent-runner.js';
export type {
  IdempotencySettings,
  KeyClaim,
  KeyedTransaction,
  KeyedTransactions,
  KeyRow,
  KeyStore,
  Presenter,
  ProblemResponse,
} from './application/ports.js';
