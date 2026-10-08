import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  runtimePool,
  settlementAccountId,
  writeDirectDeposit,
  type TestAccount,
} from '../../support/db.js';
import {
  insertTransaction,
  refusedWrite,
  storedRows,
  type Entry,
  type Refusal,
} from './direct-writes.js';

// "Written directly to the database": SQL run by the runtime role outside the service's code.
describe('ledger database checks', () => {
  let app: pg.PoolClient;
  let a1: TestAccount;
  let b1: TestAccount;
  let s: string;

  beforeAll(async () => {
    app = await runtimePool().connect();
    s = await settlementAccountId('EUR');
  });

  afterAll(async () => {
    app.release();
    await closePools();
  });

  beforeEach(async () => {
    const c1 = randomUUID();
    a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1 });
    b1 = await createCustomerAccount({ currency: 'EUR' });
    await writeDirectDeposit(a1, '1000');
  });

  /** Records the id of each transaction a refused write tried to insert. */
  function tracking(ids: string[]) {
    return async (kind: string, currency: string, entries: Entry[]) => {
      const id = randomUUID();
      ids.push(id);
      await insertTransaction(app, kind, currency, entries, id);
    };
  }

  it('LED-AC03 the database rejects zero amounts and single-entry transactions', async () => {
    const ids: string[] = [];
    const write = tracking(ids);
    const zeroOnB1 = await refusedWrite(app, () =>
      write('deposit', 'EUR', [
        [a1.id, '100', 'EUR'],
        [b1.id, '0', 'EUR'],
        [s, '-100', 'EUR'],
      ]),
    );
    const singleZero = await refusedWrite(app, () =>
      write('deposit', 'EUR', [[a1.id, '0', 'EUR']]),
    );
    const singleEntry = await refusedWrite(app, () =>
      write('deposit', 'EUR', [[a1.id, '100', 'EUR']]),
    );
    const noEntries = await refusedWrite(app, () => write('deposit', 'EUR', []));

    const zeroInsert = {
      at: 'insert',
      error: { code: '23514', constraint: 'ledger_entries_amount_not_zero' },
    };
    const tooFewAtCommit = {
      at: 'commit',
      error: { code: '23514', constraint: 'ledger_transaction_min_entries' },
    };
    expect(zeroOnB1).toMatchObject(zeroInsert);
    expect(singleZero).toMatchObject(zeroInsert);
    expect(singleEntry).toMatchObject(tooFewAtCommit);
    expect(noEntries).toMatchObject(tooFewAtCommit);
    // The "0" entry is the one refused: the entry before it on A1 was accepted.
    expect(zeroOnB1.error.message).toMatch(/ledger_entries_amount_not_zero/);
    expect(ids).toHaveLength(4);
    expect(await storedRows(app, ids)).toBe(0);
    expect(await balanceOf(a1.id)).toBe('1000');
  });

  it('LED-AC04 the balance check runs at commit, not per statement', async () => {
    const steps: string[] = [];
    await app.query('BEGIN');
    const first = await insertTransaction(app, 'deposit', 'EUR', [[a1.id, '100', 'EUR']]);
    steps.push('entry on A1');
    await app.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, amount, currency)
       VALUES ($1, $2, $3, -100, 'EUR')`,
      [randomUUID(), first, s],
    );
    steps.push('entry on S');
    await app.query('UPDATE accounts SET balance = balance + 100 WHERE id = $1', [a1.id]);
    steps.push('balance raised');
    await app.query('COMMIT');
    steps.push('committed');

    expect(steps).toEqual(['entry on A1', 'entry on S', 'balance raised', 'committed']);
    expect(await storedRows(app, [first])).toBe(3);
    expect(await balanceOf(a1.id)).toBe('1100');

    let second = '';
    const refusal: Refusal = await refusedWrite(app, async () => {
      second = await insertTransaction(app, 'deposit', 'EUR', [
        [a1.id, '100', 'EUR'],
        [s, '-99', 'EUR'],
      ]);
      await app.query('UPDATE accounts SET balance = balance + 100 WHERE id = $1', [a1.id]);
    });

    expect(refusal).toMatchObject({
      at: 'commit',
      error: { code: '23514', constraint: 'ledger_transaction_balanced' },
    });
    expect(second).not.toBe('');
    expect(await storedRows(app, [second])).toBe(0);
    expect(await balanceOf(a1.id)).toBe('1100');
  });

  it('LED-AC05 the database rejects mixed currencies', async () => {
    const u1 = await createCustomerAccount({ currency: 'USD', ownerId: a1.ownerId });
    await writeDirectDeposit(u1, '1000');
    const su = await settlementAccountId('USD');

    const ids: string[] = [];
    const write = tracking(ids);
    const refusals = [
      await refusedWrite(app, () =>
        write('deposit', 'EUR', [
          [a1.id, '100', 'EUR'],
          [su, '-100', 'USD'],
        ]),
      ),
      await refusedWrite(app, () =>
        write('transfer', 'EUR', [
          [a1.id, '100', 'EUR'],
          [u1.id, '-100', 'EUR'],
        ]),
      ),
      await refusedWrite(app, () =>
        write('deposit', 'EUR', [
          [a1.id, '100', 'USD'],
          [su, '-100', 'USD'],
        ]),
      ),
      await refusedWrite(app, () =>
        write('deposit', 'EUR', [
          [u1.id, '100', 'USD'],
          [su, '-100', 'USD'],
        ]),
      ),
    ];

    const refusedBy = (constraint: string) => ({
      at: 'insert',
      error: { code: '23503', constraint },
    });
    const byTransaction = refusedBy('ledger_entries_transaction_id_currency_fkey');
    const byAccount = refusedBy('ledger_entries_account_id_currency_fkey');
    // USD on SU in a EUR transaction; EUR on U1, a USD account; USD in a EUR transaction, on A1,
    // a EUR account, where the transaction's foreign key is checked first; USD entries in EUR.
    expect(refusals).toMatchObject([byTransaction, byAccount, byTransaction, byTransaction]);
    expect(ids).toHaveLength(4);
    expect(await storedRows(app, ids)).toBe(0);
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(u1.id)).toBe('1000');
  });

  it('SYS-R15 LED-R01 refuses entries appended to a transaction committed by another database transaction', async () => {
    const a2 = await createCustomerAccount({ currency: 'EUR' });
    const { transactionId: t1 } = await writeDirectDeposit(a1, '500');
    const entriesBefore = await storedRows(app, [t1]);

    const appended = await refusedWrite(app, async () => {
      for (const [accountId, amount] of [
        [a2.id, '100'],
        [s, '-100'],
      ] as const) {
        await app.query(
          `INSERT INTO ledger_entries (id, transaction_id, account_id, amount, currency)
           VALUES ($1, $2, $3, $4, 'EUR')`,
          [randomUUID(), t1, accountId, amount],
        );
      }
      await app.query('UPDATE accounts SET balance = balance + 100 WHERE id = $1', [a2.id]);
    });

    expect(appended).toMatchObject({
      at: 'commit',
      error: { code: '23514', constraint: 'ledger_transaction_written_once' },
    });
    expect(await storedRows(app, [t1])).toBe(entriesBefore);
    expect(await balanceOf(a2.id)).toBe('0');
    expect(await balanceOf(a1.id)).toBe('1500');
  });

  it('SYS-R15 LED-R01 commits a transaction whose row and entries are written inside the savepoint of the movement skeleton', async () => {
    await app.query('BEGIN');
    await app.query('SAVEPOINT work');
    const id = await insertTransaction(app, 'deposit', 'EUR', [
      [a1.id, '100', 'EUR'],
      [s, '-100', 'EUR'],
    ]);
    await app.query('UPDATE accounts SET balance = balance + 100 WHERE id = $1', [a1.id]);
    await app.query('COMMIT');

    expect(await storedRows(app, [id])).toBe(3);
    expect(await balanceOf(a1.id)).toBe('1100');
  });

  it('LED-AC08 the database refuses a negative customer balance', async () => {
    const direct = await refusedWrite(app, () =>
      app.query('UPDATE accounts SET balance = -1 WHERE id = $1', [a1.id]),
    );

    let withdrawal = '';
    const overdraft = await refusedWrite(app, async () => {
      withdrawal = await insertTransaction(app, 'withdrawal', 'EUR', [
        [a1.id, '-1001', 'EUR'],
        [s, '1001', 'EUR'],
      ]);
      await app.query('UPDATE accounts SET balance = balance - 1001 WHERE id = $1', [a1.id]);
    });

    const negative = { code: '23514', constraint: 'accounts_balance_check' };
    expect(direct.error).toMatchObject(negative);
    expect(overdraft.error).toMatchObject(negative);
    expect(withdrawal).not.toBe('');
    expect(await storedRows(app, [withdrawal])).toBe(0);
    expect(await balanceOf(a1.id)).toBe('1000');
  });
});
