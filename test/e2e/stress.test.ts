import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerWithAccounts, type MovementJson } from './support/api.js';
import { closeStackDb, ledgerState, stackDb } from './support/db.js';
import { bearer, headerOf, problemOf, send, type E2eResponse } from './support/http.js';
import { sendWithRetries } from './support/retrying-client.js';
import { ensureStack, waitForBothReplicasThroughNginx } from './support/stack.js';
import { freshUser, type User } from './support/tokens.js';

// Stress tests beyond the ACs, through the load balancer and both replicas: concurrent movements
// must leave every balance, the ledger and the key rows as some one-at-a-time order would.

describe('the stack under concurrent movements', () => {
  beforeAll(async () => {
    await ensureStack();
    await waitForBothReplicasThroughNginx();
  });

  afterAll(closeStackDb);

  // All 500 are sent at once; the HTTP helper keeps at most 100 of them in flight.
  it('500 concurrent transfers among 10 accounts, in both directions of every pair, keep every balance and the ledger consistent', async () => {
    const operator = await freshUser('operator');
    const owners: { user: User; account: string }[] = [];
    for (let index = 0; index < 10; index += 1) {
      const { user, accounts } = await customerWithAccounts(operator, ['10000']);
      owners.push({ user, account: accounts[0]?.id ?? '' });
    }

    // Every ordered pair of accounts, each way, about five times: crossed transfers whose locks
    // would deadlock without the ordering of ADR-0008.
    const transfers = Array.from({ length: 500 }, (_, index) => {
      const from = index % 10;
      const to = (from + 1 + (Math.floor(index / 10) % 9)) % 10;
      return { from, to, amount: BigInt(1 + ((index * 37) % 500)) };
    });
    const outcomes = await Promise.all(
      transfers.map(async ({ from, to, amount }) => {
        const source = owners[from];
        const destination = owners[to];
        return await sendWithRetries({
          method: 'POST',
          url: `/v1/accounts/${source?.account ?? ''}/transfers`,
          headers: { ...bearer(source?.user.token ?? ''), 'idempotency-key': randomUUID() },
          body: {
            amount: String(amount),
            currency: 'EUR',
            destinationAccountId: destination?.account ?? '',
          },
          timeoutMs: 60_000,
        });
      }),
    );

    const expected = owners.map(() => 10_000n);
    let applied = 0;
    for (const [index, outcome] of outcomes.entries()) {
      const { from, to, amount } = transfers[index] ?? { from: 0, to: 0, amount: 0n };
      if (outcome.final.status === 201) {
        applied += 1;
        expected[from] = (expected[from] ?? 0n) - amount;
        expected[to] = (expected[to] ?? 0n) + amount;
      } else {
        expect(outcome.final.status, outcome.final.body).toBe(422);
        expect(problemOf(outcome.final).type).toBe('/problems/insufficient-funds');
      }
    }
    expect(applied).toBeGreaterThan(0);

    const accounts = owners.map((owner) => owner.account);
    const balances = await stackDb().query<{ id: string; balance: string }>(
      'SELECT id, balance::text AS balance FROM accounts WHERE id = ANY($1::uuid[])',
      [accounts],
    );
    const byId = new Map(balances.rows.map((row) => [row.id, row.balance]));
    expect(accounts.map((id) => byId.get(id))).toEqual(expected.map(String));
    expect(expected.reduce((sum, balance) => sum + balance, 0n)).toBe(100_000n);
    const transferred = await stackDb().query<{ count: string }>(
      `SELECT count(DISTINCT t.id)::text AS count FROM transactions t
         JOIN ledger_entries e ON e.transaction_id = t.id
        WHERE t.kind = 'transfer' AND e.account_id = ANY($1::uuid[])`,
      [accounts],
    );
    expect(Number(transferred.rows[0]?.count)).toBe(applied);
    const state = await ledgerState();
    expect(state.drifted).toEqual([]);
    for (const sum of state.sums) expect(sum.sum, sum.currency).toBe('0');
  });

  it('100 concurrent requests with one Idempotency-Key move money once and all answer with one body', async () => {
    const operator = await freshUser('operator');
    const {
      user,
      accounts: [account],
    } = await customerWithAccounts(operator, ['10000']);
    const accountId = account?.id ?? '';
    const key = randomUUID();
    const once = async (): Promise<E2eResponse> =>
      await send({
        method: 'POST',
        url: `/v1/accounts/${accountId}/withdrawals`,
        headers: { ...bearer(user.token), 'idempotency-key': key },
        body: { amount: '100', currency: 'EUR' },
        timeoutMs: 60_000,
      });

    const answers = await Promise.all(Array.from({ length: 100 }, once));

    // The first to take the key moves the money; the others wait for it and replay its answer, or
    // give up waiting with 409 request-in-progress, or get 503 service-unavailable with
    // Retry-After when no pool connection of their replica freed up in time (SEC-R37), which a
    // client retries with the same key. Never anything else.
    const created = answers.filter((answer) => answer.status === 201);
    for (const answer of answers.filter((item) => item.status !== 201)) {
      expect([409, 503], answer.body).toContain(answer.status);
      expect(problemOf(answer).type).toBe(
        answer.status === 409 ? '/problems/request-in-progress' : '/problems/service-unavailable',
      );
      expect(headerOf(answer, 'retry-after')).toBe('1');
    }
    expect(
      created.filter((answer) => headerOf(answer, 'idempotent-replayed') !== 'true').length,
    ).toBeLessThanOrEqual(1);

    // One body for the key: every 201 and a replay sent now carry the same bytes.
    const replay = await once();
    expect(replay.status).toBe(201);
    expect(headerOf(replay, 'idempotent-replayed')).toBe('true');
    for (const answer of created) expect(answer.body).toBe(replay.body);

    const movement = JSON.parse(replay.body) as MovementJson;
    const withdrawals = await stackDb().query<{ id: string }>(
      `SELECT DISTINCT t.id FROM transactions t JOIN ledger_entries e ON e.transaction_id = t.id
        WHERE t.kind = 'withdrawal' AND e.account_id = $1`,
      [accountId],
    );
    expect(withdrawals.rows.map((row) => row.id)).toEqual([movement.id]);
    const balance = await stackDb().query<{ balance: string }>(
      'SELECT balance::text AS balance FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(balance.rows[0]?.balance).toBe('9900');
  });
});
