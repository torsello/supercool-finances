import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceOf, customerWithAccounts, withdraw } from './support/api.js';
import { closeStackDb, stackDb } from './support/db.js';
import { headerOf, problemOf } from './support/http.js';
import { ensureStack } from './support/stack.js';
import { freshUser } from './support/tokens.js';
import { replicaUrl } from './support/urls.js';

describe('two replicas', () => {
  beforeAll(ensureStack);
  afterAll(closeStackDb);

  it('SYS-AC14 any replica gives the same result: one transaction per key, and one ledger', async () => {
    const operator = await freshUser('operator');
    const {
      user: c1,
      accounts: [a1],
    } = await customerWithAccounts(operator, ['1000']);
    const accountId = a1?.id ?? '';

    // The same withdrawal with key k1, first to replica 1, then to replica 2.
    const k1 = randomUUID();
    const first = await withdraw(c1.token, accountId, '100', {
      key: k1,
      base: replicaUrl('api-1'),
      headers: { 'x-request-id': 'r1' },
    });
    const second = await withdraw(c1.token, accountId, '100', {
      key: k1,
      base: replicaUrl('api-2'),
      headers: { 'x-request-id': 'r2' },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(first.status);
    expect(second.body).toBe(first.body);
    expect(headerOf(second, 'x-request-id')).toBe('r2');
    expect(headerOf(second, 'idempotent-replayed')).toBe('true');
    const withdrawals = await stackDb().query(
      `SELECT DISTINCT e.transaction_id FROM ledger_entries e JOIN transactions t ON t.id = e.transaction_id
        WHERE e.account_id = $1 AND t.kind = 'withdrawal'`,
      [accountId],
    );
    expect(withdrawals.rowCount).toBe(1);

    // Ten withdrawals of "300" at once, with distinct keys, spread across both replicas: "900"
    // is left, so exactly three succeed.
    const concurrent = await Promise.all(
      Array.from(
        { length: 10 },
        async (_, index) =>
          await withdraw(c1.token, accountId, '300', {
            base: replicaUrl(index % 2 === 0 ? 'api-1' : 'api-2'),
          }),
      ),
    );
    const succeeded = concurrent.filter((response) => response.status === 201);
    expect(succeeded).toHaveLength(3);
    for (const refused of concurrent.filter((response) => response.status !== 201)) {
      expect(refused.status).toBe(422);
      expect(problemOf(refused).type).toBe('/problems/insufficient-funds');
    }
    expect(await balanceOf(c1.token, accountId)).toBe('0');
  });
});
