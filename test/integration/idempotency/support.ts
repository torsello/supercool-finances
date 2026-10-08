import type pg from 'pg';
import { KyselyKeyedTransactions } from '../../../src/modules/idempotency/adapters/persistence/kysely-key-store.js';
import type {
  Presenter,
  ProblemResponse,
} from '../../../src/modules/idempotency/application/ports.js';
import type { StoredResponse } from '../../../src/modules/idempotency/index.js';
import {
  AccountLockTimeout,
  RetriesExhausted,
  StatementTimeout,
} from '../../../src/platform/db/errors.js';
import {
  TransactionRunner,
  type RetryPolicy,
  type RunnerPool,
} from '../../../src/platform/db/transaction-runner.js';
import { UnitOfWorkRunner, type UnitOfWork } from '../../../src/platform/db/unit-of-work.js';
import { ownerPool, runtimePool } from '../../support/db.js';

export const SETTINGS = { waitTimeoutMs: 2000, keyTtlSeconds: 86400 };

export interface Recorded {
  text: string;
  values: readonly unknown[];
}

export interface RecordingHooks {
  /** Before a statement is sent on the recorded connection. */
  before?(statement: Recorded): void | Promise<void>;
  /** After a statement returned, before its caller sees the result. */
  after?(statement: Recorded, result: pg.QueryResult): void | Promise<void>;
}

export interface RecordingPool extends RunnerPool<pg.PoolClient> {
  readonly statements: Recorded[];
  /** The backend pid of the first connection taken, once it is taken. */
  pid(): Promise<number>;
}

/**
 * A pool whose connections record the text and parameters of every statement they are sent, in
 * order, until they are released, and run the hooks around them: the statements of the unit of
 * work's connection, captured by the test itself until `test/support/sql-capture.ts` exists (plan
 * 000 section 9).
 */
export function recordingPool(
  base: pg.Pool = runtimePool(),
  hooks: RecordingHooks = {},
): RecordingPool {
  const statements: Recorded[] = [];
  let resolvePid: (pid: number) => void = () => undefined;
  const firstPid = new Promise<number>((resolve) => {
    resolvePid = resolve;
  });
  return {
    statements,
    pid: () => firstPid,
    async connect() {
      const client = await base.connect();
      const own = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = own.rows[0]?.pid;
      if (pid === undefined) throw new Error('pg_backend_pid() returned no row');
      resolvePid(pid);
      const recorded = client as unknown as { query?: (...args: unknown[]) => unknown };
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<pg.QueryResult>;
      const release = client.release.bind(client);
      recorded.query = async (...args: unknown[]) => {
        if (typeof args[0] !== 'string') return await query(...args);
        const statement = { text: args[0], values: (args[1] as unknown[] | undefined) ?? [] };
        statements.push(statement);
        await hooks.before?.(statement);
        const result = await query(...args);
        await hooks.after?.(statement, result);
        return result;
      };
      client.release = (error?: Error | boolean) => {
        // The own property shadowed the prototype's query; deleting it restores the driver's.
        delete recorded.query;
        release(error);
      };
      return client;
    },
  };
}

/** Keyed transactions over the unit-of-work runner, as the composition root wires them. */
export function keyedTransactions<Operation>(
  pool: RunnerPool<pg.PoolClient>,
  operation: (uow: UnitOfWork) => Operation,
  retry: RetryPolicy = 'movement',
): KyselyKeyedTransactions<Operation> {
  return new KyselyKeyedTransactions(new UnitOfWorkRunner(new TransactionRunner({ pool })), {
    retry,
    operation,
  });
}

/** An error a fake operation throws, presented with the status and type it carries. */
export class Rejection extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
  ) {
    super(type);
  }
}

/** JSON bytes, with bigints as decimal strings (SYS-R06). */
export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  );
}

/** The problem status and type of the use cases' typed errors, as plan 000 section 7 maps them. */
function problemOf(error: unknown): [number, string] {
  if (error instanceof Rejection) return [error.status, error.type];
  if (
    error instanceof AccountLockTimeout ||
    error instanceof RetriesExhausted ||
    error instanceof StatementTimeout
  ) {
    return [503, '/problems/service-unavailable'];
  }
  const types: Record<string, [number, string]> = {
    NotFound: [404, '/problems/not-found'],
    CurrencyMismatch: [422, '/problems/currency-mismatch'],
    AccountNotActive: [422, '/problems/account-not-active'],
    InsufficientFunds: [422, '/problems/insufficient-funds'],
    DestinationUnavailable: [422, '/problems/destination-unavailable'],
    BalanceLimitExceeded: [422, '/problems/balance-limit-exceeded'],
    TransactionNotReversible: [422, '/problems/transaction-not-reversible'],
    InsufficientFundsForReversal: [422, '/problems/insufficient-funds-for-reversal'],
    AlreadyReversed: [409, '/problems/already-reversed'],
  };
  const name = error instanceof Error ? error.name : '';
  return types[name] ?? [500, '/problems/internal-error'];
}

/**
 * A presenter for the use cases until the HTTP adapter's exists (08-api): a result as a 201 with
 * its `Location` and JSON body, an error as a problem of the type plan 000 section 7 gives it,
 * both with the request id.
 */
export function testPresenter<Result>(
  requestId: string,
  location: (result: Result) => string,
): Presenter<Result> {
  return {
    created: (result): StoredResponse => ({
      status: 201,
      headers: { 'content-type': 'application/json', location: location(result) },
      body: jsonBytes({ ...(result as object), requestId }),
    }),
    problem: (error): ProblemResponse => {
      const [status, type] = problemOf(error);
      return {
        status,
        type,
        headers: { 'content-type': 'application/problem+json' },
        body: jsonBytes({ type, status, requestId }),
      };
    },
  };
}

export interface KeyRowRecord {
  fingerprint: string;
  status: number | null;
  headers: Record<string, string> | null;
  body: Buffer | null;
  created_at: string;
  expires_at: string;
  ttl_seconds: string;
  /** The row version: unchanged when nothing wrote the row. */
  xmin: string;
}

/** The key row of (user, key), read directly as the runtime role. */
export async function keyRowOf(userId: string, key: string): Promise<KeyRowRecord | undefined> {
  const result = await runtimePool().query<KeyRowRecord>(
    `SELECT fingerprint, status, headers, body, created_at::text, expires_at::text,
            trim_scale(extract(epoch FROM expires_at - created_at))::text AS ttl_seconds, xmin::text
     FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
    [userId, key],
  );
  return result.rows[0];
}

/** Moves a key row's expiry one second into the past, without the cleanup. */
export async function expireKeyRow(userId: string, key: string): Promise<void> {
  await runtimePool().query(
    `UPDATE idempotency_keys SET expires_at = now() - interval '1 second'
     WHERE user_id = $1 AND key = $2`,
    [userId, key],
  );
}

/**
 * Resolves once backend `pid` waits for a lock held by backend `blocker`, read with
 * `pg_blocking_pids` only, never a fixed sleep (plan 000 section 9).
 */
export async function waitUntilBlockedBy(
  pid: number,
  blocker: number,
  { timeoutMs = 5000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await ownerPool().query<{ blocked: boolean }>(
      'SELECT $2::int = ANY (pg_blocking_pids($1::int)) AS blocked',
      [pid, blocker],
    );
    if (result.rows[0]?.blocked === true) return;
    if (Date.now() >= deadline) {
      throw new Error(`Backend ${String(pid)} was not blocked by ${String(blocker)} in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The statement kinds of the skeleton, to compare a recorded order without the full SQL text. */
export function step(statement: Recorded): string {
  const text = statement.text.replace(/\s+/g, ' ').trim();
  if (text.startsWith('BEGIN')) return 'BEGIN';
  if (text === 'COMMIT' || text === 'ROLLBACK') return text;
  if (text.startsWith('SAVEPOINT')) return 'SAVEPOINT';
  if (text.startsWith('ROLLBACK TO SAVEPOINT')) return 'ROLLBACK TO SAVEPOINT';
  if (text.startsWith('SELECT app.set_lock_timeout')) {
    return `set_lock_timeout(${String(statement.values[0])})`;
  }
  if (text.startsWith('INSERT INTO idempotency_keys')) return 'key insert';
  if (text.startsWith('UPDATE idempotency_keys SET fingerprint')) return 'key replace';
  if (text.startsWith('SELECT fingerprint')) return 'key read';
  if (text.startsWith('UPDATE idempotency_keys SET status')) return 'key complete';
  if (text.includes('for update')) return 'lock';
  const write = /^(insert into|update|delete from) "?(\w+)"?/i.exec(text);
  if (write !== null) return `${(write[1] ?? '').toLowerCase()} ${write[2] ?? ''}`;
  return 'select';
}
