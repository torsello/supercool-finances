import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listAccounts,
  listHistory,
  NotFound,
  readAccount,
  type Position,
} from '../../../src/modules/accounts/index.js';
import { KyselyAccountQueries } from '../../../src/modules/accounts/adapters/persistence/kysely-accounts.js';
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

/** Ids that share a random prefix, so their order is the order of their suffixes. */
function idFactory(): (suffix: string) => string {
  const prefix = randomBytes(4).toString('hex');
  return (suffix) => `${prefix}-0000-7000-8000-00000000${suffix}`;
}

describe('account queries', () => {
  const queries = new KyselyAccountQueries(createDatabase(runtimePool()));

  afterAll(async () => {
    await closePools();
  });

  describe('read', () => {
    it('ACC-R07 a customer reads their own account, without its owner id', async () => {
      const owner = randomUUID();
      const { id } = await createCustomerAccount({ currency: 'JPY', ownerId: owner });
      await writeDirectDeposit({ id }, '1500');
      const account = await readAccount(queries, { userId: owner, role: 'customer' }, id);
      expect(account).toEqual({
        id,
        currency: 'JPY',
        status: 'active',
        balance: 1500n,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/) as string,
        updatedAt: expect.stringMatching(/\.\d{6}Z$/) as string,
      });
      expect(account.updatedAt >= account.createdAt).toBe(true);
      await expect(
        readAccount(queries, { userId: owner, role: 'customer' }, id.toUpperCase()),
      ).resolves.toMatchObject({ id });
    });

    it('ACC-R09 another customer, an unknown id and an id that is not a UUID are not found', async () => {
      const { id } = await createCustomerAccount({ currency: 'EUR' });
      const stranger = { userId: randomUUID(), role: 'customer' } as const;
      for (const target of [id, randomUUID(), 'not-a-uuid']) {
        await expect(readAccount(queries, stranger, target)).rejects.toBeInstanceOf(NotFound);
      }
    });

    it('ACC-R10 an operator reads any customer account, with its owner id', async () => {
      const owner = randomUUID();
      const { id } = await createCustomerAccount({ currency: 'EUR', ownerId: owner });
      const operator = { userId: randomUUID(), role: 'operator' } as const;
      await expect(readAccount(queries, operator, id)).resolves.toMatchObject({
        id,
        ownerId: owner,
        currency: 'EUR',
        status: 'active',
        balance: 0n,
      });
    });

    it('ACC-R25 SYS-R38 a system account is not found, for a customer or an operator', async () => {
      const settlement = await settlementAccountId('EUR');
      for (const role of ['customer', 'operator'] as const) {
        await expect(
          readAccount(queries, { userId: randomUUID(), role }, settlement),
        ).rejects.toBeInstanceOf(NotFound);
      }
    });
  });

  /**
   * The list and history fixtures are written directly as the runtime role, with chosen
   * created_at values, inside a transaction that is rolled back (plan 000 section 9).
   */
  describe('lists and history', () => {
    let client: pg.Client;
    let onClient: KyselyAccountQueries;

    beforeAll(async () => {
      client = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_URL') });
      await client.connect();
      onClient = new KyselyAccountQueries(new UnitOfWork(client).db);
    });

    afterAll(async () => {
      await client.end();
    });

    async function insertAccount(
      id: string,
      ownerId: string,
      createdAt: string,
      status = 'active',
    ) {
      await client.query(
        `INSERT INTO accounts (id, kind, owner_id, currency, status, balance, created_at, updated_at)
         VALUES ($1, 'customer', $2, 'EUR', $3, 0, $4, $4)`,
        [id, ownerId, status, createdAt],
      );
    }

    /** Pages through a list with `limit`, following each next position to the end. */
    async function allPages<T extends Position>(
      page: (after: Position | undefined) => Promise<{ items: T[]; next: Position | undefined }>,
    ): Promise<T[][]> {
      const pages: T[][] = [];
      let after: Position | undefined;
      do {
        const result = await page(after);
        pages.push(result.items);
        after = result.next;
        if (pages.length > 20) throw new Error('paging did not end');
      } while (after !== undefined);
      return pages;
    }

    it('ACC-R08 ACC-R22 ACC-R25 lists the caller own accounts newest first, resuming strictly after a position at microsecond precision', async () => {
      await rollingBack(client, async () => {
        const id = idFactory();
        const owner = randomUUID();
        await insertAccount(id('0001'), owner, '2026-10-07T12:00:00.000000Z');
        await insertAccount(id('0003'), owner, '2026-10-07T12:00:00.000000Z', 'frozen');
        await insertAccount(id('0002'), owner, '2026-10-07T12:00:00.000000Z', 'closed');
        await insertAccount(id('0007'), owner, '2026-10-07T11:59:59.999999Z');
        await insertAccount(id('0009'), owner, '2026-10-07T12:00:01.000100Z');
        await insertAccount(id('0004'), owner, '2026-10-07T12:00:01.000500Z');
        await insertAccount(id('0005'), randomUUID(), '2026-10-07T12:00:00.500000Z');
        const expected = ['0004', '0009', '0003', '0002', '0001', '0007'].map(id);

        const byOne = await allPages((after) => listAccounts(onClient, owner, { limit: 1, after }));
        expect(byOne.map((page) => page.length)).toEqual([1, 1, 1, 1, 1, 1]);
        expect(byOne.flat().map((account) => account.id)).toEqual(expected);

        const byTwo = await allPages((after) => listAccounts(onClient, owner, { limit: 2, after }));
        expect(byTwo.map((page) => page.map((account) => account.id))).toEqual([
          expected.slice(0, 2),
          expected.slice(2, 4),
          expected.slice(4, 6),
        ]);

        const first = await listAccounts(onClient, owner, { limit: 1 });
        expect(first.next).toEqual({ createdAt: '2026-10-07T12:00:01.000500Z', id: id('0004') });
        const second = await listAccounts(onClient, owner, { limit: 1, after: first.next });
        expect(second.items.map((account) => account.id)).toEqual([id('0009')]);

        const all = await listAccounts(onClient, owner, { limit: 100 });
        expect(all.next).toBeUndefined();
        expect(all.items.map((account) => account.status)).toEqual([
          'active',
          'active',
          'frozen',
          'closed',
          'active',
          'active',
        ]);
        expect(all.items[0]).not.toHaveProperty('ownerId');
      });
    });

    it('ACC-R21 ACC-R22 ACC-R25 lists an account entries newest first with their transaction kind, never an entry of another account', async () => {
      await rollingBack(client, async () => {
        const id = idFactory();
        const owner = randomUUID();
        const account = id('00a1');
        const other = id('00b1');
        await insertAccount(account, owner, '2026-10-07T10:00:00.000000Z');
        await insertAccount(other, randomUUID(), '2026-10-07T10:00:00.000000Z');
        const settlement = await settlementAccountId('EUR');

        const transactions: [suffix: string, kind: string][] = [
          ['0e01', 'deposit'],
          ['0e02', 'withdrawal'],
          ['0e03', 'transfer'],
          ['0e04', 'deposit'],
        ];
        for (const [suffix, kind] of transactions) {
          await client.query(
            `INSERT INTO transactions (id, kind, currency) VALUES ($1, $2, 'EUR')`,
            [id(suffix), kind],
          );
        }
        const entries: [
          suffix: string,
          tx: string,
          accountId: string,
          amount: string,
          at: string,
        ][] = [
          ['0001', '0e01', account, '5000', '2026-10-07T12:00:00.000000Z'],
          ['0101', '0e01', settlement, '-5000', '2026-10-07T12:00:00.000000Z'],
          ['0003', '0e02', account, '-1200', '2026-10-07T12:00:00.000000Z'],
          ['0103', '0e02', settlement, '1200', '2026-10-07T12:00:00.000000Z'],
          ['0009', '0e03', account, '-300', '2026-10-07T12:00:01.000100Z'],
          ['0109', '0e03', other, '300', '2026-10-07T12:00:01.000100Z'],
          ['0004', '0e04', account, '100', '2026-10-07T12:00:01.000500Z'],
          ['0104', '0e04', settlement, '-100', '2026-10-07T12:00:01.000500Z'],
        ];
        for (const [suffix, tx, accountId, amount, at] of entries) {
          await client.query(
            `INSERT INTO ledger_entries (id, transaction_id, account_id, amount, currency, created_at)
             VALUES ($1, $2, $3, $4, 'EUR', $5)`,
            [id(suffix), id(tx), accountId, amount, at],
          );
        }

        const viewer = { userId: owner, role: 'customer' } as const;
        const pages = await allPages((after) =>
          listHistory(onClient, viewer, account, { limit: 1, after }),
        );
        expect(pages.flat()).toEqual([
          {
            id: id('0004'),
            transactionId: id('0e04'),
            kind: 'deposit',
            amount: 100n,
            currency: 'EUR',
            createdAt: '2026-10-07T12:00:01.000500Z',
          },
          {
            id: id('0009'),
            transactionId: id('0e03'),
            kind: 'transfer',
            amount: -300n,
            currency: 'EUR',
            createdAt: '2026-10-07T12:00:01.000100Z',
          },
          {
            id: id('0003'),
            transactionId: id('0e02'),
            kind: 'withdrawal',
            amount: -1200n,
            currency: 'EUR',
            createdAt: '2026-10-07T12:00:00.000000Z',
          },
          {
            id: id('0001'),
            transactionId: id('0e01'),
            kind: 'deposit',
            amount: 5000n,
            currency: 'EUR',
            createdAt: '2026-10-07T12:00:00.000000Z',
          },
        ]);

        const page = await listHistory(onClient, viewer, account, { limit: 3 });
        expect(page.items).toHaveLength(3);
        expect(page.next).toEqual({ createdAt: '2026-10-07T12:00:00.000000Z', id: id('0003') });
        const rest = await listHistory(onClient, viewer, account, { limit: 3, after: page.next });
        expect(rest.items.map((entry) => entry.id)).toEqual([id('0001')]);
        expect(rest.next).toBeUndefined();

        const operator = { userId: randomUUID(), role: 'operator' } as const;
        const seen = await listHistory(onClient, operator, account, { limit: 100 });
        expect(seen.items.map((entry) => entry.id)).toEqual(pages.flat().map((entry) => entry.id));
      });
    });

    it('ACC-R09 ACC-R25 SYS-R38 the history of another customer account, an unknown id, an id that is not a UUID or a system account is not found', async () => {
      await rollingBack(client, async () => {
        const owner = randomUUID();
        const account = randomUUID();
        await insertAccount(account, owner, '2026-10-07T10:00:00.000000Z');
        const settlement = await settlementAccountId('EUR');
        const stranger = { userId: randomUUID(), role: 'customer' } as const;
        for (const target of [account, randomUUID(), 'not-a-uuid', settlement]) {
          await expect(
            listHistory(onClient, stranger, target, { limit: 20 }),
          ).rejects.toBeInstanceOf(NotFound);
        }
        const operator = { userId: randomUUID(), role: 'operator' } as const;
        for (const target of [settlement, randomUUID(), 'not-a-uuid']) {
          await expect(
            listHistory(onClient, operator, target, { limit: 20 }),
          ).rejects.toBeInstanceOf(NotFound);
        }
      });
    });

    it('ACC-R08 the account list statements are served by the index accounts_owner_list, without a sort', async () => {
      await rollingBack(client, async () => {
        const captured: { text: string; values: unknown[] }[] = [];
        // Records the statements the adapter sends; only query is used by the unit of work.
        const capturing = {
          query: (text: string, values: unknown[]) => {
            captured.push({ text, values });
            return client.query(text, values);
          },
        } as unknown as pg.ClientBase;
        const queries = new KyselyAccountQueries(new UnitOfWork(capturing).db);
        await queries.listOwned(randomUUID(), 21);
        await queries.listOwned(randomUUID(), 21, {
          createdAt: '2026-10-07T12:00:00.000000Z',
          id: randomUUID(),
        });
        expect(captured).toHaveLength(2);
        // Test-only planner settings, so the tiny test table cannot make a scan without the index
        // cheaper; a Sort node then means the order is not the index's.
        await client.query('SET LOCAL enable_seqscan = off');
        await client.query('SET LOCAL enable_bitmapscan = off');
        for (const { text, values } of captured) {
          const plan = await client.query<{ 'QUERY PLAN': unknown }>(
            `EXPLAIN (FORMAT JSON) ${text}`,
            values,
          );
          const nodes = JSON.stringify(plan.rows[0]?.['QUERY PLAN']);
          expect(nodes).toContain('"Index Name":"accounts_owner_list"');
          expect(nodes).not.toContain('"Node Type":"Sort"');
        }
      });
    });

    it('ACC-R08 ACC-R25 never lists a system account or another customer account', async () => {
      await rollingBack(client, async () => {
        const owner = randomUUID();
        const own = randomUUID();
        await insertAccount(own, owner, '2026-10-07T10:00:00.000000Z');
        await insertAccount(randomUUID(), randomUUID(), '2026-10-07T10:00:00.000000Z');
        const listed = await listAccounts(onClient, owner, { limit: 100 });
        expect(listed.items.map((account) => account.id)).toEqual([own]);
      });
    });
  });
});
