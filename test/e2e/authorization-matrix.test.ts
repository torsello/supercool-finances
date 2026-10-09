import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRepositoryFile } from '../support/deployment.js';
import {
  createAccount,
  deposit,
  fund,
  type AccountJson,
  type MovementJson,
} from './support/api.js';
import { closeStackDb, stackDb } from './support/db.js';
import { bearer, expectStatus, jsonOf, problemOf, send, type E2eResponse } from './support/http.js';
import { ensureStack } from './support/stack.js';
import { freshUser, type User } from './support/tokens.js';
import { replicaUrl, REPLICAS, type Replica } from './support/urls.js';

type Column = 'No valid token' | 'Customer · own' | 'Customer · foreign' | 'Operator';
const COLUMNS: readonly Column[] = [
  'No valid token',
  'Customer · own',
  'Customer · foreign',
  'Operator',
];

/** One cell of table 1.3 of spec 006: its row, endpoint, column and expected answer. */
interface Cell {
  row: string;
  endpoint: string;
  column: Column;
  status: number;
  type: string | undefined;
}

/** The cells of table 1.3, read from the spec itself, so the cases cannot drift from it. */
function matrixCells(): Cell[] {
  const cells: Cell[] = [];
  for (const line of readRepositoryFile('specs/006-auth/spec.md').split('\n')) {
    if (!/^\| M\d\d /.test(line)) continue;
    const [row = '', endpoint = '', ...answers] = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    answers.forEach((answer, index) => {
      if (answer === '—') return;
      const status = /^(\d{3})/.exec(answer)?.[1];
      if (status === undefined) throw new Error(`no status in ${row}: ${answer}`);
      cells.push({
        row,
        endpoint,
        column: COLUMNS[index] as Column,
        status: Number(status),
        type: /`(\/problems\/[a-z-]+)`/.exec(answer)?.[1],
      });
    });
  }
  return cells;
}

/**
 * The accounts and transactions of the Given, prepared afresh for each request with fresh users:
 * C1 owns A1 ("10000" EUR) and A2 ("0"), C2 owns B1 ("10000") and B2 ("0"); Tc is a deposit of
 * "1000" into A1 and Tf one into B1, each part of those balances.
 */
interface Fixture {
  c1: User;
  c2: User;
  o1: User;
  a1: string;
  a2: string;
  b1: string;
  b2: string;
  tc: string;
  tf: string;
}

async function prepare(): Promise<Fixture> {
  const [c1, c2, o1] = await Promise.all([
    freshUser('customer'),
    freshUser('customer'),
    freshUser('operator'),
  ]);
  const a1 = (await createAccount(c1.token)).id;
  const a2 = (await createAccount(c1.token)).id;
  const b1 = (await createAccount(c2.token)).id;
  const b2 = (await createAccount(c2.token)).id;
  await fund(o1.token, a1, '9000');
  const tc = (jsonOf(expectStatus(await deposit(o1.token, a1, '1000'), 201)) as MovementJson).id;
  await fund(o1.token, b1, '9000');
  const tf = (jsonOf(expectStatus(await deposit(o1.token, b1, '1000'), 201)) as MovementJson).id;
  return { c1, c2, o1, a1, a2, b1, b2, tc, tf };
}

/** Balances, statuses and transactions, which no error may change. */
async function snapshot(fixture: Fixture): Promise<unknown> {
  const accounts = [fixture.a1, fixture.a2, fixture.b1, fixture.b2];
  const users = [fixture.c1.id, fixture.c2.id, fixture.o1.id];
  const owned = await stackDb().query(
    `SELECT id, owner_id, status, balance::text FROM accounts WHERE owner_id = ANY($1::uuid[]) ORDER BY id`,
    [users],
  );
  const transactions = await stackDb().query(
    `SELECT DISTINCT transaction_id FROM ledger_entries WHERE account_id = ANY($1::uuid[]) ORDER BY 1`,
    [accounts],
  );
  return { accounts: owned.rows, transactions: transactions.rows };
}

interface KeyRow {
  user_id: string;
  key: string;
  status: number;
  body: string;
}

/** The users' idempotency records, which no error may change; only a lookup 404 adds its own. */
async function keyRows(fixture: Fixture): Promise<KeyRow[]> {
  const result = await stackDb().query<KeyRow>(
    `SELECT user_id, key, status, encode(body, 'hex') AS body FROM idempotency_keys
      WHERE user_id = ANY($1::uuid[]) ORDER BY 1, 2`,
    [[fixture.c1.id, fixture.c2.id, fixture.o1.id]],
  );
  return result.rows;
}

async function account(id: string): Promise<{ status: string; balance: string; owner_id: string }> {
  const result = await stackDb().query<{ status: string; balance: string; owner_id: string }>(
    'SELECT status, balance::text AS balance, owner_id FROM accounts WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no account ${id}`);
  return row;
}

/** A request of one cell, against one replica. */
interface Call {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** Whether the endpoint takes an Idempotency-Key: a fresh one is sent. */
  keyed: boolean;
}

/** The ids a column uses (section 3 of spec 006, AUT-AC16): own, foreign or the operator's. */
function ids(
  fixture: Fixture,
  column: Column,
): { account: string; closable: string; transaction: string } {
  return column === 'Customer · foreign' || column === 'Operator'
    ? { account: fixture.b1, closable: fixture.b2, transaction: fixture.tf }
    : { account: fixture.a1, closable: fixture.a2, transaction: fixture.tc };
}

const MOVEMENT = { amount: '100', currency: 'EUR' };

interface Case extends Cell {
  /** Runs before the request: M06 freezes the account first, as O1. */
  before?: (fixture: Fixture, column: Column) => Promise<void>;
  call: (fixture: Fixture, column: Column) => Call;
  /** For a success, the change of its row. */
  verify?: (fixture: Fixture, response: E2eResponse) => Promise<void> | void;
}

/** The four cells of a row, from its own expectations. */
function row(
  number: string,
  endpoint: string,
  answers: Partial<Record<Column, [number, string | undefined]>>,
  details: Pick<Case, 'call' | 'before'> & {
    verify?: Partial<Record<Column, Case['verify']>>;
  },
): Case[] {
  return COLUMNS.flatMap((column) => {
    const answer = answers[column];
    if (answer === undefined) return [];
    const verify = details.verify?.[column];
    return [
      {
        row: number,
        endpoint,
        column,
        status: answer[0],
        type: answer[1],
        call: details.call,
        ...(details.before === undefined ? {} : { before: details.before }),
        ...(verify === undefined ? {} : { verify }),
      },
    ];
  });
}

const UNAUTHENTICATED: [number, string] = [401, '/problems/unauthenticated'];
const FORBIDDEN: [number, string] = [403, '/problems/forbidden'];
const NOT_FOUND: [number, string] = [404, '/problems/not-found'];

const CASES: Case[] = [
  ...row(
    'M01',
    '`POST /accounts`',
    { 'No valid token': UNAUTHENTICATED, 'Customer · own': [201, undefined], Operator: FORBIDDEN },
    {
      call: () => ({
        method: 'POST',
        path: '/v1/accounts',
        body: { currency: 'EUR' },
        keyed: true,
      }),
      verify: {
        'Customer · own': async (fixture, response) => {
          const created = jsonOf(response) as AccountJson;
          expect(created).toMatchObject({ currency: 'EUR', status: 'active', balance: '0' });
          expect((await account(created.id)).owner_id).toBe(fixture.c1.id);
        },
      },
    },
  ),
  ...row(
    'M02',
    '`GET /accounts`',
    { 'No valid token': UNAUTHENTICATED, 'Customer · own': [200, undefined], Operator: FORBIDDEN },
    {
      call: () => ({ method: 'GET', path: '/v1/accounts', keyed: false }),
      verify: {
        'Customer · own': (fixture, response) => {
          const { items } = jsonOf(response) as { items: AccountJson[] };
          expect(items.map((item) => item.id).sort()).toEqual([fixture.a1, fixture.a2].sort());
        },
      },
    },
  ),
  ...row(
    'M03',
    '`GET /accounts/{id}`',
    {
      'No valid token': UNAUTHENTICATED,
      'Customer · own': [200, undefined],
      'Customer · foreign': NOT_FOUND,
      Operator: [200, undefined],
    },
    {
      call: (fixture, column) => ({
        method: 'GET',
        path: `/v1/accounts/${ids(fixture, column).account}`,
        keyed: false,
      }),
      verify: {
        'Customer · own': (fixture, response) => {
          const read = jsonOf(response) as AccountJson;
          expect(read).toMatchObject({ id: fixture.a1, balance: '10000' });
          expect(read.ownerId).toBeUndefined();
        },
        Operator: (fixture, response) => {
          expect(jsonOf(response)).toMatchObject({ id: fixture.b1, ownerId: fixture.c2.id });
        },
      },
    },
  ),
  ...row(
    'M04',
    '`GET /accounts/{id}/entries`',
    {
      'No valid token': UNAUTHENTICATED,
      'Customer · own': [200, undefined],
      'Customer · foreign': NOT_FOUND,
      Operator: [200, undefined],
    },
    {
      call: (fixture, column) => ({
        method: 'GET',
        path: `/v1/accounts/${ids(fixture, column).account}/entries`,
        keyed: false,
      }),
      verify: {
        'Customer · own': (fixture, response) => {
          const { items } = jsonOf(response) as { items: { transactionId: string }[] };
          expect(items).toHaveLength(2);
          expect(items.map((item) => item.transactionId)).toContain(fixture.tc);
        },
        Operator: (fixture, response) => {
          const { items } = jsonOf(response) as { items: { transactionId: string }[] };
          expect(items).toHaveLength(2);
          expect(items.map((item) => item.transactionId)).toContain(fixture.tf);
        },
      },
    },
  ),
  ...row(
    'M05',
    '`POST /accounts/{id}/freeze`',
    {
      'No valid token': UNAUTHENTICATED,
      'Customer · own': FORBIDDEN,
      'Customer · foreign': FORBIDDEN,
      Operator: [200, undefined],
    },
    {
      call: (fixture, column) => ({
        method: 'POST',
        path: `/v1/accounts/${ids(fixture, column).account}/freeze`,
        keyed: false,
      }),
      verify: {
        Operator: async (fixture) => {
          expect((await account(fixture.b1)).status).toBe('frozen');
        },
      },
    },
  ),
  ...row(
    'M06',
    '`POST /accounts/{id}/unfreeze`',
    {
      'No valid token': UNAUTHENTICATED,
      'Customer · own': FORBIDDEN,
      'Customer · foreign': FORBIDDEN,
      Operator: [200, undefined],
    },
    {
      before: async (fixture, column) => {
        const frozen = await send({
          method: 'POST',
          url: `/v1/accounts/${ids(fixture, column).account}/freeze`,
          headers: bearer(fixture.o1.token),
        });
        expectStatus(frozen, 200);
      },
      call: (fixture, column) => ({
        method: 'POST',
        path: `/v1/accounts/${ids(fixture, column).account}/unfreeze`,
        keyed: false,
      }),
      verify: {
        Operator: async (fixture) => {
          expect((await account(fixture.b1)).status).toBe('active');
        },
      },
    },
  ),
  ...row(
    'M07',
    '`POST /accounts/{id}/close`',
    {
      'No valid token': UNAUTHENTICATED,
      'Customer · own': FORBIDDEN,
      'Customer · foreign': FORBIDDEN,
      Operator: [200, undefined],
    },
    {
      call: (fixture, column) => ({
        method: 'POST',
        path: `/v1/accounts/${ids(fixture, column).closable}/close`,
        keyed: false,
      }),
      verify: {
        Operator: async (fixture) => {
          expect((await account(fixture.b2)).status).toBe('closed');
        },
      },
    },
  ),
  ...row(
    'M08',
    '`POST /accounts/{id}/deposits`',
    {
      'No valid token': UNAUTHENTICATED,
      'Customer · own': FORBIDDEN,
      'Customer · foreign': FORBIDDEN,
      Operator: [201, undefined],
    },
    {
      call: (fixture, column) => ({
        method: 'POST',
        path: `/v1/accounts/${ids(fixture, column).account}/deposits`,
        body: MOVEMENT,
        keyed: true,
      }),
      verify: {
        Operator: async (fixture) => {
          expect((await account(fixture.b1)).balance).toBe('10100');
        },
      },
    },
  ),
  ...row(
    'M09',
    '`POST /accounts/{id}/withdrawals`',
    {
      'No valid token': UNAUTHENTICATED,
      'Customer · own': [201, undefined],
      'Customer · foreign': NOT_FOUND,
      Operator: FORBIDDEN,
    },
    {
      call: (fixture, column) => ({
        method: 'POST',
        path: `/v1/accounts/${ids(fixture, column).account}/withdrawals`,
        body: MOVEMENT,
        keyed: true,
      }),
      verify: {
        'Customer · own': async (fixture) => {
          expect((await account(fixture.a1)).balance).toBe('9900');
        },
      },
    },
  ),
  ...row(
    'M10',
    '`POST /accounts/{id}/transfers`, to an own account',
    {
      'No valid token': UNAUTHENTICATED,
      'Customer · own': [201, undefined],
      'Customer · foreign': NOT_FOUND,
      Operator: FORBIDDEN,
    },
    {
      call: (fixture, column) => ({
        method: 'POST',
        path: `/v1/accounts/${ids(fixture, column).account}/transfers`,
        body: { ...MOVEMENT, destinationAccountId: fixture.a2 },
        keyed: true,
      }),
      verify: {
        'Customer · own': async (fixture) => {
          expect((await account(fixture.a1)).balance).toBe('9900');
          expect((await account(fixture.a2)).balance).toBe('100');
        },
      },
    },
  ),
  ...row(
    'M11',
    '`POST /accounts/{id}/transfers`, to another customer',
    {
      'No valid token': UNAUTHENTICATED,
      'Customer · own': [201, undefined],
      'Customer · foreign': NOT_FOUND,
      Operator: FORBIDDEN,
    },
    {
      call: (fixture, column) => ({
        method: 'POST',
        path: `/v1/accounts/${ids(fixture, column).account}/transfers`,
        // For the foreign source, B1, the other customer is C1, with A1.
        body: {
          ...MOVEMENT,
          destinationAccountId: column === 'Customer · foreign' ? fixture.a1 : fixture.b2,
        },
        keyed: true,
      }),
      verify: {
        'Customer · own': async (fixture) => {
          expect((await account(fixture.a1)).balance).toBe('9900');
          expect((await account(fixture.b2)).balance).toBe('100');
        },
      },
    },
  ),
  ...row(
    'M12',
    '`GET /transactions/{id}`',
    {
      'No valid token': UNAUTHENTICATED,
      'Customer · own': [200, undefined],
      'Customer · foreign': NOT_FOUND,
      Operator: [200, undefined],
    },
    {
      call: (fixture, column) => ({
        method: 'GET',
        path: `/v1/transactions/${ids(fixture, column).transaction}`,
        keyed: false,
      }),
      verify: {
        'Customer · own': (fixture, response) => {
          const { entries } = jsonOf(response) as {
            entries: { accountId: string; amount: string }[];
          };
          expect(entries).toEqual([{ accountId: fixture.a1, amount: '1000' }]);
        },
        Operator: (fixture, response) => {
          const { entries } = jsonOf(response) as {
            entries: { accountId: string; amount: string }[];
          };
          expect(entries).toHaveLength(2);
          expect(entries).toContainEqual({ accountId: fixture.b1, amount: '1000' });
          expect(entries.map((entry) => entry.amount).sort()).toEqual(['-1000', '1000']);
        },
      },
    },
  ),
  ...row(
    'M13',
    '`POST /transactions/{id}/reversals`',
    {
      'No valid token': UNAUTHENTICATED,
      'Customer · own': FORBIDDEN,
      'Customer · foreign': FORBIDDEN,
      Operator: [201, undefined],
    },
    {
      call: (fixture, column) => ({
        method: 'POST',
        path: `/v1/transactions/${ids(fixture, column).transaction}/reversals`,
        body: { reason: 'correction' },
        keyed: true,
      }),
      verify: {
        Operator: async (fixture) => {
          expect((await account(fixture.b1)).balance).toBe('9000');
          const reversal = await stackDb().query(
            "SELECT id FROM transactions WHERE kind = 'reversal' AND reversed_transaction_id = $1",
            [fixture.tf],
          );
          expect(reversal.rowCount).toBe(1);
        },
      },
    },
  ),
];

function tokenOf(fixture: Fixture, column: Column): Record<string, string> {
  if (column === 'No valid token') return {};
  return bearer(column === 'Operator' ? fixture.o1.token : fixture.c1.token);
}

const RUNS = REPLICAS.flatMap((replica) => CASES.map((item) => ({ ...item, replica })));

describe('the authorization matrix on every replica', () => {
  beforeAll(ensureStack);
  afterAll(closeStackDb);

  it('AUT-AC16 has one case per cell of table 1.3 of spec 006, with the cell’s endpoint, column and answer', () => {
    const shape = (cell: Cell): string =>
      [cell.row, cell.endpoint, cell.column, String(cell.status), cell.type ?? ''].join(' | ');
    const cells = matrixCells();
    expect(cells).toHaveLength(50);
    expect(CASES.map(shape).sort()).toEqual(cells.map(shape).sort());
    expect(RUNS).toHaveLength(100);
  });

  it.each(RUNS.map((run) => [run.row, run.column, run.replica, run] as const))(
    'AUT-AC16 %s, %s, on %s',
    async (_row, column, replica: Replica, run) => {
      const fixture = await prepare();
      await run.before?.(fixture, column);
      const call = run.call(fixture, column);
      const before = await snapshot(fixture);
      const keysBefore = await keyRows(fixture);
      const key = call.keyed ? randomUUID() : undefined;
      const response = await send({
        method: call.method,
        url: `${replicaUrl(replica)}${call.path}`,
        headers: {
          ...tokenOf(fixture, column),
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        ...(call.body === undefined ? {} : { body: call.body }),
      });

      expect(response.status, response.body).toBe(run.status);
      if (run.type !== undefined) {
        expect(problemOf(response).type).toBe(run.type);
        expect(await snapshot(fixture)).toEqual(before);
        // No existing key record changes. A 404 at the lookup step, which only a keyed request
        // past the role check reaches, stores its own key's record with that 404 (IDM-R14);
        // every other error stores nothing.
        const keysAfter = await keyRows(fixture);
        const added = keysAfter.filter(
          (row) => !keysBefore.some((old) => old.user_id === row.user_id && old.key === row.key),
        );
        expect(keysAfter.filter((row) => !added.includes(row))).toEqual(keysBefore);
        if (run.status === 404 && key !== undefined) {
          expect(added.map(({ key: stored, status }) => ({ key: stored, status }))).toEqual([
            { key, status: 404 },
          ]);
        } else {
          expect(added).toEqual([]);
        }
      } else {
        expect(run.verify, `${run.row} ${column} checks the change of its row`).toBeDefined();
        await run.verify?.(fixture, response);
      }
    },
  );
});
