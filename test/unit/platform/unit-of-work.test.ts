import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AccountLockTimeout, IdempotencyWaitTimeout } from '../../../src/platform/db/errors.js';
import { UnitOfWork } from '../../../src/platform/db/unit-of-work.js';

/** A client whose every statement fails with SQLSTATE 55P03, as a lock timeout does. */
function lockTimingOutClient(): pg.ClientBase {
  const client = {
    query: () => {
      const error = new pg.DatabaseError('canceling statement due to lock timeout', 0, 'error');
      error.code = '55P03';
      return Promise.reject(error);
    },
  };
  // Only query is used by the unit of work's Kysely instance.
  return client as unknown as pg.ClientBase;
}

describe('unit of work statement classification', () => {
  it('IDM-R12 classifies a 55P03 raised inside keyWait as IdempotencyWaitTimeout', async () => {
    const uow = new UnitOfWork(lockTimingOutClient());
    await expect(uow.keyWait(() => uow.setLockTimeout(2000))).rejects.toBeInstanceOf(
      IdempotencyWaitTimeout,
    );
  });

  it('IDM-R13 classifies a 55P03 raised outside keyWait, also after it, as AccountLockTimeout', async () => {
    const uow = new UnitOfWork(lockTimingOutClient());
    await expect(uow.setLockTimeout(2000)).rejects.toBeInstanceOf(AccountLockTimeout);
    await expect(uow.keyWait(() => uow.setLockTimeout(2000))).rejects.toBeInstanceOf(
      IdempotencyWaitTimeout,
    );
    await expect(uow.setLockTimeout(2000)).rejects.toBeInstanceOf(AccountLockTimeout);
  });
});

describe('unit of work hook points', () => {
  it('SYS-R37 writes each entry with its own amount unless the fault seam rewrites it', () => {
    const entry = { accountId: 'a', amount: -100n };
    expect(new UnitOfWork(lockTimingOutClient()).entryAmount(entry)).toBe(-100n);
    const rewriting = new UnitOfWork(lockTimingOutClient(), {
      entryAmount: (written) => (written.accountId === 'a' ? -99n : written.amount),
    });
    expect(rewriting.entryAmount(entry)).toBe(-99n);
    expect(rewriting.entryAmount({ accountId: 'b', amount: 100n })).toBe(100n);
  });
});
