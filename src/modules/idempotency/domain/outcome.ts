/**
 * The headers stored with a response, those that describe its body: `content-type`, and
 * `location` on a 201. Headers of the current request (`X-Request-Id`, `Idempotent-Replayed`)
 * are never stored; they are set on each answer (section 1.2 of spec 005).
 */
export interface StoredHeaders {
  'content-type': string;
  location?: string;
}

/** A response as stored in the key row and replayed: the exact bytes sent (IDM-R07). */
export interface StoredResponse {
  status: number;
  headers: StoredHeaders;
  body: Uint8Array;
}

/**
 * Where an answer was decided: before the key step (route, authentication, rate limit, role,
 * media type, body size, malformed request), at the key step, by the operation after the
 * savepoint (validation, lookup, business rules, and any failure there), or once `COMMIT` was
 * sent, by the request timeout (SEC-R33).
 */
export type OutcomeStep = 'before-key-step' | 'key-step' | 'operation' | 'commit-sent';

/** An answer: its status and, for a problem response, its type. */
export interface Outcome {
  step: OutcomeStep;
  status: number;
  type?: string;
}

/** How the database transaction ends for an outcome. */
export type Ending = 'no-transaction' | 'commit' | 'rollback-to-savepoint' | 'rollback';

export interface Decision {
  /** Whether this answer is written to the key row and replayed. */
  stored: boolean;
  ending: Ending;
}

/** The 404 for the resource in the path and the business rejections, with their status. */
const STORED_REJECTIONS: ReadonlyMap<string, number> = new Map([
  ['/problems/not-found', 404],
  ['/problems/already-reversed', 409],
  ['/problems/currency-mismatch', 422],
  ['/problems/account-not-active', 422],
  ['/problems/insufficient-funds', 422],
  ['/problems/destination-unavailable', 422],
  ['/problems/balance-limit-exceeded', 422],
  ['/problems/transaction-not-reversible', 422],
  ['/problems/insufficient-funds-for-reversal', 422],
]);

/**
 * The table of section 1.3 of spec 005 as one function (IDM-R14 to IDM-R17). Everything decided at
 * the lookup or business-rule steps is stored, and nothing else is: a 201 commits with its
 * effects; a 404 at the lookup or a business rejection rolls back to the savepoint and commits only
 * its response; a validation error, a key-step answer, a 500, a 503 or any type this table does
 * not know rolls back entirely. A 503 sent after `COMMIT` is never stored itself: the commit
 * finishes, and if it succeeds the key row holds the response stored before it.
 */
export function decide(outcome: Outcome): Decision {
  switch (outcome.step) {
    case 'before-key-step':
      return { stored: false, ending: 'no-transaction' };
    case 'commit-sent':
      return { stored: false, ending: 'commit' };
    case 'key-step':
      return { stored: false, ending: 'rollback' };
    case 'operation':
      if (outcome.status === 201 && outcome.type === undefined) {
        return { stored: true, ending: 'commit' };
      }
      if (outcome.type !== undefined && STORED_REJECTIONS.get(outcome.type) === outcome.status) {
        return { stored: true, ending: 'rollback-to-savepoint' };
      }
      return { stored: false, ending: 'rollback' };
  }
}

export function isStored(outcome: Outcome): boolean {
  return decide(outcome).stored;
}
