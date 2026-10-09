import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_USERS } from '../../scripts/seed.js';
import { bearer, expectStatus, jsonOf, send } from './support/http.js';
import { closeStackDb, stackDb } from './support/db.js';
import {
  parseSeedOutput,
  reconcileInTools,
  runTools,
  startStack,
  toolsTokens,
  type SeedOutput,
} from './support/stack.js';

/** Table 1.2 of spec 008: each user's role, and each customer's accounts with their balances. */
const TABLE_1_2 = [
  { name: 'demo-operator', role: 'operator', accounts: [] },
  {
    name: 'demo-customer-1',
    role: 'customer',
    accounts: [
      { currency: 'EUR', balance: '250000' },
      { currency: 'USD', balance: '100000' },
    ],
  },
  { name: 'demo-customer-2', role: 'customer', accounts: [{ currency: 'EUR', balance: '50000' }] },
  { name: 'demo-customer-3', role: 'customer', accounts: [{ currency: 'JPY', balance: '150000' }] },
];

const OPERATOR_ID = DEMO_USERS.find((user) => user.role === 'operator')?.id ?? '';
const CUSTOMER_1 = DEMO_USERS.find((user) => user.name === 'demo-customer-1')?.id ?? '';

/** What the seed and the API add to the database: accounts, transactions and audit records. */
async function counts(): Promise<Record<string, string>> {
  const result = await stackDb().query<{ accounts: string; transactions: string; audits: string }>(
    `SELECT (SELECT count(*) FROM accounts)::text AS accounts,
            (SELECT count(*) FROM transactions)::text AS transactions,
            (SELECT count(*) FROM audit_records)::text AS audits`,
  );
  return { ...result.rows[0] };
}

describe('the demo seed', () => {
  beforeAll(async () => {
    await startStack({ fresh: true });
  });

  afterAll(closeStackDb);

  it('DEP-AC06 creates the demo data once, through the API, even after its keys expired', async () => {
    const first = await runTools(['npm', 'run', 'seed']);
    expect(first.code, first.stderr).toBe(0);
    const seeded: SeedOutput = parseSeedOutput(first.stdout);

    expect(
      seeded.users.map((user) => ({
        name: user.name,
        role: user.role,
        accounts: user.accounts.map(({ currency, balance }) => ({ currency, balance })),
      })),
    ).toEqual(TABLE_1_2);
    for (const user of seeded.users) {
      expect(user.id).toBe(DEMO_USERS.find((demo) => demo.name === user.name)?.id);
    }

    // Every deposit is in the account's history, with an audit record by demo-operator.
    const customers = seeded.users.filter((user) => user.role === 'customer');
    const tokens = await toolsTokens(customers.map((user) => ({ sub: user.id, role: 'customer' })));
    for (const [index, customer] of customers.entries()) {
      for (const account of customer.accounts) {
        const history = await send({
          url: `/v1/accounts/${account.id}/entries`,
          headers: bearer(tokens[index] ?? ''),
        });
        const { items } = jsonOf(expectStatus(history, 200)) as {
          items: { transactionId: string; kind: string; amount: string }[];
        };
        expect(items.map(({ kind, amount }) => ({ kind, amount }))).toEqual([
          { kind: 'deposit', amount: account.balance },
        ]);
        const audit = await stackDb().query<{
          actor_id: string;
          actor_role: string;
          action: string;
        }>('SELECT actor_id, actor_role, action FROM audit_records WHERE transaction_id = $1', [
          items[0]?.transactionId,
        ]);
        expect(audit.rows).toEqual([
          { actor_id: OPERATOR_ID, actor_role: 'operator', action: 'deposit' },
        ]);
      }
    }

    const reconciliation = await reconcileInTools();
    expect(reconciliation.code, reconciliation.output).toBe(0);
    expect(reconciliation.report?.discrepancies).toEqual([]);

    // Every key row expires (IDM-R21); the second run must still change nothing (DEP-R11).
    const before = await counts();
    const expired = await stackDb().query(
      "UPDATE idempotency_keys SET expires_at = now() - interval '1 second'",
    );
    expect(expired.rowCount).toBeGreaterThan(0);

    const second = await runTools(['npm', 'run', 'seed']);
    expect(second.code, second.stderr).toBe(0);
    expect(parseSeedOutput(second.stdout)).toEqual(seeded);
    expect(await counts()).toEqual(before);
  });

  it('DEP-AC08 a token minted with Docker only is accepted by the stack', async () => {
    const minted = await runTools([
      'npm',
      'run',
      '--silent',
      'token',
      '--',
      '--sub',
      CUSTOMER_1,
      '--role',
      'customer',
    ]);
    // Checked with booleans whose messages name no token, so a failure never prints one.
    expect(minted.code, minted.stderr).toBe(0);
    const lines = minted.stdout.split('\n');
    expect(lines.length, 'lines of the token command, the last one empty').toBe(2);
    expect(lines[1] === '', 'the output ends with the first line').toBe(true);
    const token = lines[0] ?? '';

    const list = await send({ url: '/v1/accounts', headers: bearer(token) });
    expect(list.status).toBe(200);
    const { items } = jsonOf(list) as { items: { currency: string; balance: string }[] };
    expect(
      items
        .map(({ currency, balance }) => ({ currency, balance }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    ).toEqual([
      { currency: 'EUR', balance: '250000' },
      { currency: 'USD', balance: '100000' },
    ]);
  });
});
