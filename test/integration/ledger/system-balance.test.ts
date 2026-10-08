import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KyselyBalanceQueries } from '../../../src/modules/ledger/adapters/persistence/kysely-ledger.js';
import { createDatabase } from '../../../src/platform/db/database.js';
import { UnitOfWork } from '../../../src/platform/db/unit-of-work.js';
import {
  closePools,
  createCustomerAccount,
  rollingBack,
  runtimePool,
  settlementAccountId,
  writeDirectDeposit,
} from '../../support/db.js';
import { requireEnv } from '../../support/env.js';

const MAX = 9223372036854775807n;

describe('system account balances', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_URL') });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await closePools();
  });

  it('LED-R13 a settlement balance is the sum of its entries, as an exact decimal string', async () => {
    const balances = new KyselyBalanceQueries(createDatabase(runtimePool()));
    const s = await settlementAccountId('EUR');
    const before = await balances.entriesSum(s);
    const account = await createCustomerAccount({ currency: 'EUR' });
    await writeDirectDeposit(account, '1234');
    const after = await balances.entriesSum(s);
    expect(after).toMatch(/^-?\d+$/);
    expect(BigInt(after) - BigInt(before)).toBe(-1234n);
  });

  it('LED-R15 the sum stays exact below the bigint range, in a rolled-back transaction', async () => {
    await rollingBack(client, async () => {
      const balances = new KyselyBalanceQueries(new UnitOfWork(client).db);
      const s = await settlementAccountId('EUR');
      const before = BigInt(await balances.entriesSum(s));
      // Two deposits of the bigint maximum, written directly; the deferred checks never run,
      // because the transaction is rolled back.
      for (let i = 0; i < 2; i += 1) {
        const account = randomUUID();
        const transaction = randomUUID();
        await client.query(
          `INSERT INTO accounts (id, kind, owner_id, currency, status, balance)
           VALUES ($1, 'customer', $2, 'EUR', 'active', $3)`,
          [account, randomUUID(), MAX.toString()],
        );
        await client.query(
          `INSERT INTO transactions (id, kind, currency) VALUES ($1, 'deposit', 'EUR')`,
          [transaction],
        );
        await client.query(
          `INSERT INTO ledger_entries (id, transaction_id, account_id, amount, currency)
           VALUES ($1, $3, $4, $5::bigint, 'EUR'), ($2, $3, $6, -$5::bigint, 'EUR')`,
          [randomUUID(), randomUUID(), transaction, account, MAX.toString(), s],
        );
      }
      const after = await balances.entriesSum(s);
      expect(BigInt(after)).toBe(before - 2n * MAX);
      expect(BigInt(after) < -MAX - 1n).toBe(true);
    });
  });
});
