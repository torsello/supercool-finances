import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, settlementAccountId } from '../../support/db.js';
import { createAccount, deposit, problemOf, transfer, withdraw } from '../../support/http.js';
import { openLockSession } from '../../support/sessions.js';
import { tokenFor } from '../../support/tokens.js';
import { accountRow, entriesSum } from './api-support.js';

describe('system account locks', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('LED-AC09 100 concurrent deposits and withdrawals and a transfer to S complete while another session holds FOR NO KEY UPDATE on S, and S is never updated', async () => {
    const o1 = tokenFor(randomUUID(), 'operator');
    const customers = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const token = tokenFor(randomUUID(), 'customer');
        return { token, account: await createAccount(built.app, token, 'EUR') };
      }),
    );
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    const s = await settlementAccountId('EUR');

    const session = await openLockSession();
    try {
      await session.lockRow('accounts', s, 'FOR NO KEY UPDATE');
      const recorded = { version: (await accountRow(s)).xmin, balance: await entriesSum(s) };

      const deposits = await Promise.all(
        customers.map(async ({ account }) => await deposit(built.app, o1, account.id, '100')),
      );
      const withdrawals = await Promise.all(
        customers.map(
          async ({ token, account }) => await withdraw(built.app, token, account.id, '40'),
        ),
      );
      for (const response of [...deposits, ...withdrawals]) {
        expect(response.statusCode, response.body).toBe(201);
      }

      const toS = await transfer(built.app, c1, a1.id, s, '100');
      expect(toS.statusCode).toBe(422);
      expect(problemOf(toS).type).toBe('/problems/destination-unavailable');
      expect(await balanceOf(a1.id)).toBe('1000');

      // Still before the session releases its lock.
      expect((await accountRow(s)).xmin).toBe(recorded.version);
      expect(BigInt(recorded.balance) - BigInt(await entriesSum(s))).toBe(3000n);
      for (const { account } of customers) expect(await balanceOf(account.id)).toBe('60');
    } finally {
      await session.close();
    }
  });
});
