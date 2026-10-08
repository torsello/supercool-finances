import { afterAll, describe, expect, it } from 'vitest';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  ownerPool,
  runtimePool,
  settlementAccountId,
  writeDirectDeposit,
} from '../../support/db.js';
import { openLockSession } from '../../support/sessions.js';

describe('test helpers', () => {
  afterAll(async () => {
    await closePools();
  });

  it('connects as the runtime role and as the owner role', async () => {
    const runtime = await runtimePool().query<{ user: string }>('SELECT current_user AS user');
    const owner = await ownerPool().query<{ user: string }>('SELECT current_user AS user');

    expect(runtime.rows[0]?.user).toBe('scf_app');
    expect(owner.rows[0]?.user).toBe('scf_owner');
  });

  it('creates a customer account with balance 0', async () => {
    const account = await createCustomerAccount({ currency: 'MXN' });

    const row = await runtimePool().query<{ kind: string; status: string; currency: string }>(
      'SELECT kind, status, currency FROM accounts WHERE id = $1',
      [account.id],
    );
    expect(row.rows[0]).toEqual({ kind: 'customer', status: 'active', currency: 'MXN' });
    expect(await balanceOf(account.id)).toBe('0');
  });

  it('writeDirectDeposit commits a complete, reconciled deposit with its audit record', async () => {
    const account = await createCustomerAccount({ currency: 'EUR' });
    const settlement = await settlementAccountId('EUR');

    const first = await writeDirectDeposit(account, '1000');
    const second = await writeDirectDeposit(account, '50');

    expect(await balanceOf(account.id)).toBe('1050');
    const entries = await runtimePool().query<{ account_id: string; amount: string }>(
      `SELECT account_id, amount FROM ledger_entries WHERE transaction_id = $1 ORDER BY amount`,
      [first.transactionId],
    );
    expect(entries.rows).toEqual([
      { account_id: settlement, amount: '-1000' },
      { account_id: account.id, amount: '1000' },
    ]);
    const transaction = await runtimePool().query<{ kind: string; currency: string }>(
      'SELECT kind, currency FROM transactions WHERE id = $1',
      [second.transactionId],
    );
    expect(transaction.rows[0]).toEqual({ kind: 'deposit', currency: 'EUR' });
    const audit = await runtimePool().query<{
      action: string;
      actor_role: string;
      account_ids: string[];
    }>('SELECT action, actor_role, account_ids FROM audit_records WHERE transaction_id = $1', [
      first.transactionId,
    ]);
    expect(audit.rows).toEqual([
      { action: 'deposit', actor_role: 'operator', account_ids: [account.id] },
    ]);
    const sum = await runtimePool().query<{ sum: string }>(
      'SELECT SUM(amount)::text AS sum FROM ledger_entries WHERE account_id = $1',
      [account.id],
    );
    expect(sum.rows[0]?.sum).toBe('1050');
  });

  it('a lock session holds a row lock as the owner role until a runtime backend is blocked by it', async () => {
    const account = await createCustomerAccount({ currency: 'EUR' });
    const session = await openLockSession();
    const waiter = await runtimePool().connect();
    try {
      await session.lockRow('accounts', account.id);
      const pid = await session.backendPid(waiter);
      const events: string[] = [];

      await waiter.query('BEGIN');
      const blocked = waiter
        .query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [account.id])
        .then(() => events.push('waiter got the lock'));

      await session.waitUntilBlocked(pid);
      events.push('waiter is blocked');
      await session.release();
      await blocked;
      await waiter.query('ROLLBACK');

      expect(events).toEqual(['waiter is blocked', 'waiter got the lock']);
    } finally {
      waiter.release();
      await session.close();
    }
  });

  it('waitUntilBlocked fails when the backend is never blocked', async () => {
    const session = await openLockSession();
    const idle = await runtimePool().connect();
    try {
      const pid = await session.backendPid(idle);
      await expect(session.waitUntilBlocked(pid, { timeoutMs: 200 })).rejects.toThrow(
        /not blocked/,
      );
    } finally {
      idle.release();
      await session.close();
    }
  });
});
