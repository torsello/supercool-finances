/**
 * The key matches an unexpired key row of the same user with another fingerprint (IDM-R09):
 * 422 `/problems/idempotency-key-reused`, never stored.
 */
export class IdempotencyKeyReused extends Error {
  override readonly name = 'IdempotencyKeyReused';

  constructor() {
    super('idempotency key already used with another request');
  }
}
