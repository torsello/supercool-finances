import type { StoredResponse } from '../domain/outcome.js';

/** What the key step writes for a first request: who, which key, the fingerprint and the TTL. */
export interface KeyClaim {
  userId: string;
  key: string;
  fingerprint: string;
  /** `IDEMPOTENCY_KEY_TTL_SECONDS`, counted from the row's creation (IDM-R20). */
  ttlSeconds: number;
}

/** A committed key row as step 3c reads it, without a lock. */
export interface KeyRow {
  fingerprint: string;
  response: StoredResponse;
  /** `expires_at <= clock_timestamp()` when the row was read (IDM-R21). */
  expired: boolean;
}

/** The statements of the key step on one database transaction (plan 005 section 3). */
export interface KeyStore {
  /** Step 3: inserts the key row; true when it claimed the key, false when a row exists. */
  claim(claim: KeyClaim): Promise<boolean>;
  /** Step 3b: replaces an expired row; true when it claimed the key. */
  claimExpired(claim: KeyClaim): Promise<boolean>;
  /** Step 3c: the row of (user, key), if one is committed. */
  read(userId: string, key: string): Promise<KeyRow | undefined>;
  /** Step 9: stores the response in the claimed row. */
  complete(userId: string, key: string, response: StoredResponse): Promise<void>;
}

/**
 * One attempt of a keyed request's database transaction (plan 000 section 6.2): the key store,
 * the lock-timeout call, the savepoint of step 4, and the operation's own ports on the same
 * connection.
 */
export interface KeyedTransaction<Operation> {
  keys: KeyStore;
  /**
   * Runs the key-wait steps (3, 3b, 3c and their re-passes): a lock timeout raised there ends the
   * request as `IdempotencyWaitTimeout`, one raised outside as `AccountLockTimeout` (IDM-R12,
   * IDM-R13).
   */
  keyWait<T>(statements: () => Promise<T>): Promise<T>;
  /** `app.set_lock_timeout(ms)`, never a `SET` (SEC-R31). */
  setLockTimeout(ms: number): Promise<void>;
  /** Step 4, `SAVEPOINT work` (IDM-R14). */
  savepoint(): Promise<void>;
  rollbackToSavepoint(): Promise<void>;
  operation: Operation;
}

/**
 * Runs a keyed request in one database transaction, with the retry policy of its operation:
 * movements retry 40P01 and 40001 from `BEGIN`, key insert included (SYS-R18, IDM-R17); account
 * creation never retries (plan 000 section 6.1).
 */
export interface KeyedTransactions<Operation> {
  run<T>(work: (tx: KeyedTransaction<Operation>) => Promise<T>): Promise<T>;
}

/** A problem response, with its type for the table of section 1.3 of spec 005. */
export interface ProblemResponse extends StoredResponse {
  type: string;
}

/**
 * Turns an operation's result or error into the response to send, the body as the exact bytes,
 * `requestId` included (plan 000 section 5). The runner stores what it returns before the commit.
 */
export interface Presenter<Result> {
  /** The 201 of a result, with its `Location`. */
  created(result: Result): StoredResponse;
  /** The problem response of an error raised by the operation (steps 5 to 8). */
  problem(error: unknown): ProblemResponse;
}

/** `IDEMPOTENCY_WAIT_TIMEOUT_MS` and `IDEMPOTENCY_KEY_TTL_SECONDS` (section 1.4 of spec 005). */
export interface IdempotencySettings {
  waitTimeoutMs: number;
  keyTtlSeconds: number;
}
