import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AccountBalanceNotZero,
  changeAccountStatus,
  InvalidStatusTransition,
  NotFound,
  type AccountStatus,
  type StatusAction,
} from '../../../src/modules/accounts/index.js';
import { KyselyAccountTransactions } from '../../../src/modules/accounts/adapters/persistence/kysely-accounts.js';
import { AccountLockTimeout } from '../../../src/platform/db/errors.js';
import { TransactionRunner } from '../../../src/platform/db/transaction-runner.js';
import { UnitOfWorkRunner } from '../../../src/platform/db/unit-of-work.js';
import { UuidV7Generator } from '../../../src/platform/ids/uuid-v7.js';
import {
  closePools,
  createCustomerAccount,
  runtimePool,
  settlementAccountId,
  writeDirectDeposit,
} from '../../support/db.js';
import { openLockSession } from '../../support/sessions.js';

const OPERATOR = { id: '0192f0c4-0000-7000-8000-0000000000ee', role: 'operator' } as const;

async function backendPid(client: pg.ClientBase): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('pg_backend_pid() returned no row');
  return pid;
}

/** Resolves once some backend waits for a lock held by backend `blocker`; fails after 5 s. */
async function waitUntilBlockedBy(blocker: number): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = await runtimePool().query<{ blocked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))) AS blocked`,
      [blocker],
    );
    if (result.rows[0]?.blocked === true) return;
    if (Date.now() >= deadline) throw new Error(`No backend was blocked by ${String(blocker)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface StoredAccount {
  status: string;
  balance: string;
  updated_at: string;
}

interface StoredAudit {
  actor_id: string;
  actor_role: string;
  action: string;
  account_ids: string[];
  old_status: string | null;
  new_status: string | null;
  transaction_id: string | null;
  request_id: string;
}

describe('change account status use case', () => {
  const ids = new UuidV7Generator();
  const transactions = new KyselyAccountTransactions(
    new UnitOfWorkRunner(new TransactionRunner({ pool: runtimePool() })),
    ids,
  );

  afterAll(async () => {
    await closePools();
  });

  function change(accountId: string, action: StatusAction, options: { lockMs?: number } = {}) {
    return changeAccountStatus(
      { transactions, accountLockTimeoutMs: options.lockMs ?? 2000 },
      { accountId, action, actor: OPERATOR, requestId: `req-${action}` },
    );
  }

  async function stored(accountId: string): Promise<StoredAccount> {
    const result = await runtimePool().query<StoredAccount>(
      `SELECT status, balance, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
       FROM accounts WHERE id = $1`,
      [accountId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`No account ${accountId}`);
    return row;
  }

  async function audits(accountId: string): Promise<StoredAudit[]> {
    const result = await runtimePool().query<StoredAudit>(
      `SELECT actor_id, actor_role, action, account_ids::text[] AS account_ids, old_status, new_status,
              transaction_id, request_id
       FROM audit_records WHERE $1::uuid = ANY (account_ids) AND action IN ('freeze', 'unfreeze', 'close')
       ORDER BY created_at, id`,
      [accountId],
    );
    return result.rows;
  }

  /** The database's clock, in milliseconds since the epoch. */
  async function databaseClockMs(): Promise<number> {
    const result = await runtimePool().query<{ ms: number }>(
      'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms',
    );
    const ms = result.rows[0]?.ms;
    if (ms === undefined) throw new Error('clock_timestamp() returned no row');
    return ms;
  }

  /** A fresh customer account in the given status, with an optional balance from a deposit. */
  async function accountIn(status: AccountStatus, balance?: string): Promise<string> {
    const { id } = await createCustomerAccount({ currency: 'EUR' });
    if (balance !== undefined) await writeDirectDeposit({ id }, balance);
    if (status === 'frozen' || status === 'closed') {
      await runtimePool().query(`UPDATE accounts SET status = $2 WHERE id = $1`, [id, status]);
    }
    return id;
  }

  it('ACC-R11 ACC-R12 ACC-R13 ACC-R26 each transition updates the status and updated_at and writes one audit record with old and new status', async () => {
    const steps: [StatusAction, AccountStatus, AccountStatus][] = [
      ['freeze', 'active', 'frozen'],
      ['unfreeze', 'frozen', 'active'],
      ['freeze', 'active', 'frozen'],
      ['close', 'frozen', 'closed'],
    ];
    const id = await accountIn('active');
    let previous = await stored(id);
    for (const [action, , next] of steps) {
      const result = await change(id, action);
      const now = await stored(id);
      expect(result).toMatchObject({ id, status: next, balance: 0n, updatedAt: now.updated_at });
      expect(now.status).toBe(next);
      expect(now.updated_at > previous.updated_at).toBe(true);
      previous = now;
    }
    expect(await audits(id)).toEqual(
      steps.map(([action, from, to]) => ({
        actor_id: OPERATOR.id,
        actor_role: 'operator',
        action,
        account_ids: [id],
        old_status: from,
        new_status: to,
        transaction_id: null,
        request_id: `req-${action}`,
      })),
    );
  });

  it('ACC-R13 closes an active account whose balance is 0', async () => {
    const id = await accountIn('active');
    await expect(change(id, 'close')).resolves.toMatchObject({ status: 'closed' });
    expect(await audits(id)).toEqual([
      expect.objectContaining({ action: 'close', old_status: 'active', new_status: 'closed' }),
    ]);
  });

  it('ACC-R15 a request for the status the account already has changes nothing and writes no audit record', async () => {
    for (const [status, action] of [
      ['frozen', 'freeze'],
      ['active', 'unfreeze'],
      ['closed', 'close'],
    ] as const) {
      const id = await accountIn(status);
      const before = await stored(id);
      await expect(change(id, action)).resolves.toMatchObject({
        id,
        status,
        updatedAt: before.updated_at,
      });
      expect(await stored(id)).toEqual(before);
      expect(await audits(id)).toEqual([]);
    }
  });

  it('ACC-R14 ACC-R16 a refused change leaves the account unchanged and writes no audit record', async () => {
    const cases = [
      ['closed', undefined, 'freeze', InvalidStatusTransition],
      ['closed', undefined, 'unfreeze', InvalidStatusTransition],
      ['active', '1', 'close', AccountBalanceNotZero],
      ['frozen', '2500', 'close', AccountBalanceNotZero],
    ] as const;
    for (const [status, balance, action, error] of cases) {
      const id = await accountIn(status, balance);
      const before = await stored(id);
      await expect(change(id, action)).rejects.toBeInstanceOf(error);
      expect(await stored(id)).toEqual(before);
      expect(await audits(id)).toEqual([]);
    }
  });

  it('ACC-R17 decides on the status read under the row lock, after a concurrent change commits', async () => {
    const id = await accountIn('active');
    const holder = await runtimePool().connect();
    let closing: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE accounts SET status = 'frozen', updated_at = clock_timestamp() WHERE id = $1`,
        [id],
      );
      const pid = await backendPid(holder);
      closing = change(id, 'close', { lockMs: 4000 });
      await waitUntilBlockedBy(pid);
      await holder.query('COMMIT');
      await expect(closing).resolves.toMatchObject({ status: 'closed' });
    } catch (error) {
      await holder.query('ROLLBACK');
      await closing?.catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
    expect(await audits(id)).toEqual([
      expect.objectContaining({ action: 'close', old_status: 'frozen', new_status: 'closed' }),
    ]);
  });

  it('SYS-R38 SYS-R42 a system account, an unknown id and an id that is not a UUID are not found, and nothing is written', async () => {
    const settlement = await settlementAccountId('EUR');
    for (const id of [settlement, randomUUID(), 'not-a-uuid']) {
      for (const action of ['freeze', 'unfreeze', 'close'] as const) {
        await expect(change(id, action)).rejects.toBeInstanceOf(NotFound);
      }
    }
    const stillSystem = await runtimePool().query<{ status: string | null }>(
      'SELECT status FROM accounts WHERE id = $1',
      [settlement],
    );
    expect(stillSystem.rows).toEqual([{ status: null }]);
    expect(await audits(settlement)).toEqual([]);
  });

  it('ACC-R28 ACC-R29 with a session holding FOR UPDATE on the row and a lock timeout of 200 ms, ends with AccountLockTimeout after at least 200 ms, with the account and the audit table unchanged', async () => {
    const id = await accountIn('active');
    const before = await stored(id);
    const session = await openLockSession();
    try {
      await session.lockRow('accounts', id);
      for (const action of ['freeze', 'close'] as const) {
        // lock_timeout runs on the database's clock, which may drift from the host's by a fraction
        // of a millisecond (Docker's VM), so the lower bound is read on the database's clock.
        const startedAt = await databaseClockMs();
        const started = performance.now();
        await expect(change(id, action, { lockMs: 200 })).rejects.toBeInstanceOf(
          AccountLockTimeout,
        );
        const elapsed = performance.now() - started;
        expect((await databaseClockMs()) - startedAt).toBeGreaterThanOrEqual(200);
        expect(elapsed).toBeLessThan(5000);
      }
    } finally {
      await session.close();
    }
    expect(await stored(id)).toEqual(before);
    expect(await audits(id)).toEqual([]);
    await expect(change(id, 'freeze')).resolves.toMatchObject({ status: 'frozen' });
  });
});
