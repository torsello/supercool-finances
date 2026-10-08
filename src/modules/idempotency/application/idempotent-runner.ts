import { IdempotencyWaitTimeout } from '../../../platform/db/errors.js';
import { IdempotencyKeyReused } from '../domain/errors.js';
import { decide, type StoredResponse } from '../domain/outcome.js';
import type {
  IdempotencySettings,
  KeyClaim,
  KeyedTransaction,
  KeyedTransactions,
  Presenter,
} from './ports.js';

/** A request with a key, its fingerprint computed before the transaction (IDM-R05). */
export interface KeyedRequest {
  userId: string;
  key: string;
  fingerprint: string;
}

/** The response to send, and whether it is the replay of a stored one (IDM-R07). */
export interface KeyedAnswer {
  replayed: boolean;
  response: StoredResponse;
}

/**
 * Ends the attempt with `ROLLBACK` once step 3c found the stored response: nothing was written, so
 * the transaction runner rolls back, and `run` returns the replay.
 */
class Replay extends Error {
  override readonly name = 'Replay';

  constructor(readonly response: StoredResponse) {
    super('stored response found');
  }
}

/**
 * Runs one keyed request inside one attempt of the transaction runner (plan 005 section 3): the
 * key step, the savepoint, the operation, and the stored outcome. The operation runs steps 5 to 8;
 * its result or error becomes a response through the presenter, and the table of section 1.3 of
 * spec 005 (`decide`) says whether it is stored. A 40P01 or 40001 re-runs the whole attempt, key
 * step included, with a new key-wait deadline (IDM-R17).
 */
export class IdempotentRunner {
  readonly #settings: IdempotencySettings;
  readonly #now: () => number;

  /** `now` is a monotonic clock in milliseconds, `performance.now` by default. */
  constructor(settings: IdempotencySettings, options: { now?: () => number } = {}) {
    this.#settings = settings;
    this.#now = options.now ?? (() => performance.now());
  }

  async run<Operation, Result>(
    transactions: KeyedTransactions<Operation>,
    request: KeyedRequest,
    operation: (tx: Operation) => Promise<Result>,
    presenter: Presenter<Result>,
  ): Promise<KeyedAnswer> {
    try {
      return await transactions.run(async (tx) => {
        await this.#keyStep(tx, request);
        await tx.savepoint();
        const response = await this.#operate(tx, operation, presenter);
        await tx.keys.complete(request.userId, request.key, response);
        return { replayed: false, response };
      });
    } catch (error) {
      if (error instanceof Replay) return { replayed: true, response: error.response };
      throw error;
    }
  }

  /**
   * Steps 2 to 3c. Every key-wait step draws on one deadline taken at step 2: before step 3b and
   * before each pass back to step 3, `lock_timeout` is set to the whole milliseconds left, so one
   * attempt never waits for the key longer than `IDEMPOTENCY_WAIT_TIMEOUT_MS` in total (IDM-R11).
   * With less than 1 ms left before step 3b, step 3b is skipped but step 3c, which takes no lock,
   * still reads the row, so a response stored by the request it waited for is replayed or refused
   * (IDM-R10); only a missing or expired row then ends in `IdempotencyWaitTimeout`, as does a pass
   * back to step 3 with less than 1 ms left (IDM-R12). Returns once the key is claimed; throws
   * `Replay` or `IdempotencyKeyReused` otherwise.
   */
  async #keyStep<Operation>(tx: KeyedTransaction<Operation>, request: KeyedRequest): Promise<void> {
    const { waitTimeoutMs, keyTtlSeconds } = this.#settings;
    await tx.setLockTimeout(waitTimeoutMs);
    const deadline = this.#now() + waitTimeoutMs;
    const claim: KeyClaim = { ...request, ttlSeconds: keyTtlSeconds };

    await tx.keyWait(async () => {
      for (let pass = 1; ; pass += 1) {
        if (pass > 1) {
          const left = this.#timeLeft(deadline);
          if (left < 1) throw new IdempotencyWaitTimeout();
          await tx.setLockTimeout(left);
        }
        if (await tx.keys.claim(claim)) return;
        const left = this.#timeLeft(deadline);
        if (left >= 1) {
          await tx.setLockTimeout(left);
          if (await tx.keys.claimExpired(claim)) return;
        }
        const row = await tx.keys.read(request.userId, request.key);
        if (row === undefined || row.expired) {
          // Step 3b was skipped: no time is left to replace the row or to wait for it again.
          if (left < 1) throw new IdempotencyWaitTimeout();
          // No row: the cleanup deleted the expired row after step 3. A row read as expired
          // expired after step 3b. Either way the next pass claims the key or finds a live row
          // (IDM-R21).
          continue;
        }
        if (row.fingerprint !== request.fingerprint) throw new IdempotencyKeyReused();
        throw new Replay(row.response);
      }
    });
  }

  /** The whole milliseconds left before the key-wait deadline. */
  #timeLeft(deadline: number): number {
    return Math.floor(deadline - this.#now());
  }

  /**
   * Steps 5 to 8 and the response of step 9. A rejection the table stores rolls back to the
   * savepoint, which also clears a transaction aborted by a refused insert (REV-R06), and becomes
   * the stored response; any other error is rethrown as it is, so the transaction runner rolls
   * back everything, key row included, or retries the attempt (IDM-R14, IDM-R16, IDM-R17).
   */
  async #operate<Operation, Result>(
    tx: KeyedTransaction<Operation>,
    operation: (tx: Operation) => Promise<Result>,
    presenter: Presenter<Result>,
  ): Promise<StoredResponse> {
    let result: Result;
    try {
      result = await operation(tx.operation);
    } catch (error) {
      const { type, ...response } = presenter.problem(error);
      const { ending } = decide({ step: 'operation', status: response.status, type });
      if (ending !== 'rollback-to-savepoint') throw error;
      await tx.rollbackToSavepoint();
      return response;
    }
    const response = presenter.created(result);
    if (decide({ step: 'operation', status: response.status }).ending !== 'commit') {
      throw new Error(`a result was presented with status ${String(response.status)}, not 201`);
    }
    return response;
  }
}
