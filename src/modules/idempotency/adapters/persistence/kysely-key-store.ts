import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../../platform/db/schema.js';
import type { RetryPolicy } from '../../../../platform/db/transaction-runner.js';
import type { UnitOfWork, UnitOfWorkRunner } from '../../../../platform/db/unit-of-work.js';
import type { StoredHeaders, StoredResponse } from '../../domain/outcome.js';
import type {
  KeyClaim,
  KeyedTransaction,
  KeyedTransactions,
  KeyRow,
  KeyStore,
} from '../../application/ports.js';

/** The stored headers as written by step 9; anything else in a committed row is a defect. */
function storedHeaders(value: unknown): StoredHeaders {
  if (typeof value === 'object' && value !== null) {
    const headers = value as Record<string, unknown>;
    const contentType = headers['content-type'];
    const location = headers['location'];
    if (
      typeof contentType === 'string' &&
      (location === undefined || typeof location === 'string')
    ) {
      return location === undefined
        ? { 'content-type': contentType }
        : { 'content-type': contentType, location };
    }
  }
  throw new Error('key row holds headers that step 9 never writes');
}

/**
 * The key statements of plan 005 section 3, on the unit of work's connection. Expiry is compared
 * with `clock_timestamp()`, not the transaction's `now()`, so a row that expired while this
 * transaction waited counts as expired (IDM-R21).
 */
export class KyselyKeyStore implements KeyStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** Step 3: waits while another transaction holds a conflicting row, then claims or not. */
  async claim(claim: KeyClaim): Promise<boolean> {
    const result = await sql<{ claimed: boolean }>`INSERT INTO idempotency_keys
      (user_id, key, fingerprint, created_at, expires_at)
      VALUES (${claim.userId}, ${claim.key}, ${claim.fingerprint}, now(),
              now() + ${claim.ttlSeconds}::integer * interval '1 second')
      ON CONFLICT (user_id, key) DO NOTHING
      RETURNING true AS claimed`.execute(this.db);
    return result.rows.length === 1;
  }

  /** Step 3b: replaces an expired row; waits while another transaction holds the row. */
  async claimExpired(claim: KeyClaim): Promise<boolean> {
    const result = await sql<{ claimed: boolean }>`UPDATE idempotency_keys
      SET fingerprint = ${claim.fingerprint}, status = NULL, headers = NULL, body = NULL,
          created_at = now(), expires_at = now() + ${claim.ttlSeconds}::integer * interval '1 second'
      WHERE user_id = ${claim.userId} AND key = ${claim.key} AND expires_at <= clock_timestamp()
      RETURNING true AS claimed`.execute(this.db);
    return result.rows.length === 1;
  }

  /** Step 3c: the committed row, without a lock, so retries never queue behind each other. */
  async read(userId: string, key: string): Promise<KeyRow | undefined> {
    const result = await sql<{
      fingerprint: string;
      status: number | null;
      headers: unknown;
      body: Buffer | null;
      expired: boolean;
    }>`SELECT fingerprint, status, headers, body, expires_at <= clock_timestamp() AS expired
      FROM idempotency_keys WHERE user_id = ${userId} AND key = ${key}`.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    // Only committed rows are read, and the deferred trigger commits none incomplete (IDM-R18).
    if (row.status === null || row.body === null) {
      throw new Error('key row committed without a stored response');
    }
    return {
      fingerprint: row.fingerprint,
      response: { status: row.status, headers: storedHeaders(row.headers), body: row.body },
      expired: row.expired,
    };
  }

  /** Step 9: the response in the row this transaction claimed. */
  async complete(userId: string, key: string, response: StoredResponse): Promise<void> {
    const body = Buffer.from(
      response.body.buffer,
      response.body.byteOffset,
      response.body.byteLength,
    );
    const result = await sql`UPDATE idempotency_keys
      SET status = ${response.status}, headers = ${JSON.stringify(response.headers)}::jsonb,
          body = ${body}
      WHERE user_id = ${userId} AND key = ${key}`.execute(this.db);
    if (result.numAffectedRows !== 1n) throw new Error('the claimed key row was not found');
  }
}

/**
 * Keyed requests in one transaction of the unit-of-work runner, with the retry policy of their
 * operation, and the operation's own ports built on the same connection by the composition root,
 * since one module's adapters never import another's. The key-wait steps run in the unit of
 * work's key-wait scope, so a 55P03 raised there is `IdempotencyWaitTimeout` and one raised after
 * them `AccountLockTimeout` (plan 000 section 6.3).
 */
export class KyselyKeyedTransactions<Operation> implements KeyedTransactions<Operation> {
  constructor(
    private readonly unitOfWork: UnitOfWorkRunner,
    private readonly options: { retry: RetryPolicy; operation: (uow: UnitOfWork) => Operation },
  ) {}

  async run<T>(work: (tx: KeyedTransaction<Operation>) => Promise<T>): Promise<T> {
    return await this.unitOfWork.run(
      async (uow) =>
        await work({
          keys: new KyselyKeyStore(uow.db),
          keyWait: async (statements) => await uow.keyWait(statements),
          setLockTimeout: async (ms) => {
            await uow.setLockTimeout(ms);
          },
          savepoint: async () => {
            await uow.savepoint('work');
          },
          rollbackToSavepoint: async () => {
            await uow.rollbackToSavepoint('work');
          },
          operation: this.options.operation(uow),
        }),
      { retry: this.options.retry },
    );
  }
}
