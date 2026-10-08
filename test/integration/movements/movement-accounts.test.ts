import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { KyselyMovementAccounts } from '../../../src/modules/movements/adapters/persistence/kysely-movements.js';
import { TransactionRunner } from '../../../src/platform/db/transaction-runner.js';
import { UnitOfWorkRunner } from '../../../src/platform/db/unit-of-work.js';
import {
  closePools,
  createCustomerAccount,
  runtimePool,
  settlementAccountId,
  writeDirectDeposit,
} from '../../support/db.js';
import { openLockSession } from '../../support/sessions.js';
import { C1, C2 } from './support.js';

describe('movement accounts adapter', () => {
  const unitOfWork = new UnitOfWorkRunner(new TransactionRunner({ pool: runtimePool() }));

  afterAll(async () => {
    await closePools();
  });

  it('MOV-R18 the lookup reads the immutable columns of a source and a destination, and the settlement account, without locks', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    const j1 = await createCustomerAccount({ currency: 'JPY', ownerId: C2 });
    const s = await settlementAccountId('EUR');
    const sj = await settlementAccountId('JPY');
    const session = await openLockSession();
    try {
      // Rows locked FOR UPDATE by another session: a locking read would wait and time out.
      await session.lockRow('accounts', a1.id);
      await session.lockRow('accounts', j1.id);
      const found = await unitOfWork.run(
        async (uow) => {
          await uow.setLockTimeout(100);
          const accounts = new KyselyMovementAccounts(uow.db);
          return {
            pair: await accounts.findAccounts([a1.id, j1.id, randomUUID()]),
            withSettlement: await accounts.findWithSettlement(j1.id),
            system: await accounts.findWithSettlement(s),
            unknown: await accounts.findWithSettlement(randomUUID()),
          };
        },
        { retry: 'none' },
      );
      expect(found.pair.toSorted((x, y) => (x.id < y.id ? -1 : 1))).toEqual(
        [
          { id: a1.id, kind: 'customer', ownerId: C1, currency: 'EUR' },
          { id: j1.id, kind: 'customer', ownerId: C2, currency: 'JPY' },
        ].toSorted((x, y) => (x.id < y.id ? -1 : 1)),
      );
      expect(found.withSettlement).toEqual({
        id: j1.id,
        kind: 'customer',
        ownerId: C2,
        currency: 'JPY',
        settlementId: sj,
      });
      expect(found.system).toMatchObject({ id: s, kind: 'system', ownerId: null });
      expect(found.unknown).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('MOV-R18 LED-R14 the lock takes FOR UPDATE on customer accounts only: a settlement row held FOR NO KEY UPDATE gives no row, without waiting', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR' });
    await writeDirectDeposit(a1, '250');
    const s = await settlementAccountId('EUR');
    const session = await openLockSession();
    try {
      await session.lockRow('accounts', s, 'FOR NO KEY UPDATE');
      const result = await unitOfWork.run(
        async (uow) => {
          // A wait for the settlement row would end in 55P03 after 50 ms and fail the test.
          await uow.setLockTimeout(50);
          const accounts = new KyselyMovementAccounts(uow.db);
          const system = await accounts.lock(s);
          const locked = await accounts.lock(a1.id);

          // FOR UPDATE conflicts with FOR KEY SHARE; FOR NO KEY UPDATE would not.
          const other = await runtimePool().connect();
          let keyShare: unknown;
          try {
            await other.query('BEGIN');
            await other.query('SELECT app.set_lock_timeout(100)');
            await other.query('SELECT 1 FROM accounts WHERE id = $1 FOR KEY SHARE', [a1.id]);
          } catch (error) {
            keyShare = error;
          } finally {
            await other.query('ROLLBACK');
            other.release();
          }
          return { system, locked, keyShare };
        },
        { retry: 'none' },
      );
      expect(result.system).toBeUndefined();
      expect(result.locked).toEqual({ id: a1.id, status: 'active', balance: 250n });
      expect(result.keyShare).toMatchObject({ code: '55P03' });
    } finally {
      await session.close();
    }
  });
});
