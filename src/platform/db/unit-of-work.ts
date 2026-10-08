import { Kysely, PostgresDialect, sql, type PostgresPool, type PostgresPoolClient } from 'kysely';
import type pg from 'pg';
import type { Database } from './schema.js';
import { classifyDatabaseError, type DatabaseStep } from './sqlstate.js';
import type { RetryPolicy, TransactionRunner } from './transaction-runner.js';

/** The named write steps at which the fault-injection seam can throw (plan 000 section 8). */
export type FaultStep = 'after-entries' | 'after-balances';

/**
 * The hook point of the `unit-of-work-faults` test seam (SYS-R37). Only the test app passes it;
 * the production composition root never does.
 */
export interface UnitOfWorkFaults {
  /** Called when the work reaches a named step; a hook that throws injects a fault there. */
  atStep?(step: FaultStep): void;
  /**
   * Called with each ledger entry before it is written; the amount it returns is written in place
   * of the entry's own, so a test can write one entry with another amount (LED-AC23).
   */
  entryAmount?(entry: { accountId: string; amount: bigint }): bigint;
}

/** The name of the seam a unit of work runner has attached, if any (SYS-AC24). */
export type UnitOfWorkTestHook = 'unit-of-work-faults';

/** The savepoints of the movement skeleton (plan 000 section 6.2). */
export type SavepointName = 'work';

/**
 * A Kysely instance whose every statement runs on one client, so it joins the transaction the
 * runner opened. Statement errors are classified at the statement, by the step it ran at (plan 000
 * section 6.3).
 */
function databaseOn(client: pg.ClientBase, step: () => DatabaseStep): Kysely<Database> {
  const pooled = {
    // Only the (sql, parameters) overload is implemented: Kysely calls the cursor overload only to
    // stream, which the service never does, so the cast goes through unknown.
    query: (async (text: string, values: readonly unknown[]) => {
      try {
        return await client.query(text, [...values]);
      } catch (error) {
        throw classifyDatabaseError(error, step());
      }
    }) as unknown as PostgresPoolClient['query'],
    release() {
      // The runner owns the client and releases it once the transaction ends.
    },
  } satisfies PostgresPoolClient;
  const pool: PostgresPool = {
    connect: () => Promise.resolve(pooled),
    end: () => Promise.resolve(),
    options: {},
  };
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * One database transaction's connection (plan 000 section 6.2): the Kysely instance repositories
 * write through, savepoints, the lock-timeout call and the hook point of the fault seam.
 */
export class UnitOfWork {
  readonly db: Kysely<Database>;
  readonly #faults: UnitOfWorkFaults | undefined;
  #step: DatabaseStep = 'work';

  constructor(client: pg.ClientBase, faults?: UnitOfWorkFaults) {
    this.db = databaseOn(client, () => this.#step);
    this.#faults = faults;
  }

  /**
   * Runs the key-wait statements of the movement skeleton (steps 3, 3b, 3c and their re-passes,
   * plan 000 section 6.2): a lock timeout there is `IdempotencyWaitTimeout`, never
   * `AccountLockTimeout` (IDM-R12, IDM-R13). Statements outside it are classified as `work`.
   */
  async keyWait<T>(statements: () => Promise<T>): Promise<T> {
    this.#step = 'key-wait';
    try {
      return await statements();
    } finally {
      this.#step = 'work';
    }
  }

  /**
   * Bounds the next lock waits of this transaction through `app.set_lock_timeout`, never a `SET`
   * (SEC-R30, SEC-R31); the value ends with the transaction.
   */
  async setLockTimeout(ms: number): Promise<void> {
    await sql`SELECT app.set_lock_timeout(${ms}::integer)`.execute(this.db);
  }

  async savepoint(name: SavepointName): Promise<void> {
    await sql`SAVEPOINT ${sql.id(name)}`.execute(this.db);
  }

  async rollbackToSavepoint(name: SavepointName): Promise<void> {
    await sql`ROLLBACK TO SAVEPOINT ${sql.id(name)}`.execute(this.db);
  }

  /** Marks a named write step; the fault seam, when attached, may throw here. */
  reached(step: FaultStep): void {
    this.#faults?.atStep?.(step);
  }

  /** The amount to write for a ledger entry: its own, unless the fault seam rewrites it. */
  entryAmount(entry: { accountId: string; amount: bigint }): bigint {
    return this.#faults?.entryAmount?.(entry) ?? entry.amount;
  }
}

/**
 * Runs work on a unit of work inside one transaction of the runner (plan 000 section 6.1).
 * `attachedTestHooks()` names the seam attached, so SYS-AC24 can assert there is none.
 */
export class UnitOfWorkRunner {
  readonly #runner: TransactionRunner<pg.PoolClient>;
  readonly #faults: UnitOfWorkFaults | undefined;

  constructor(
    runner: TransactionRunner<pg.PoolClient>,
    options: { faults?: UnitOfWorkFaults } = {},
  ) {
    this.#runner = runner;
    this.#faults = options.faults;
  }

  attachedTestHooks(): UnitOfWorkTestHook[] {
    return this.#faults === undefined ? [] : ['unit-of-work-faults'];
  }

  async run<T>(work: (uow: UnitOfWork) => Promise<T>, options: { retry: RetryPolicy }): Promise<T> {
    return await this.#runner.run(
      async (client) => await work(new UnitOfWork(client, this.#faults)),
      options,
    );
  }
}
