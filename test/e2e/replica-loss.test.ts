import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount, fund } from './support/api.js';
import { closeStackDb, ledgerState, stackDb, transactionsOn } from './support/db.js';
import { bearer, send, type E2eRequest } from './support/http.js';
import { sendWithRetries, type RetriedRequest } from './support/retrying-client.js';
import {
  composeOk,
  ensureStack,
  reconcileInTools,
  restoreReplicas,
  startServices,
  stopServices,
  toolsTokens,
  waitExited,
  waitForBothReplicasThroughNginx,
  waitHealthy,
} from './support/stack.js';
import { delay, waitFor } from './support/wait.js';

const CUSTOMERS = 20;
const WORKERS = 8;
const LOGICAL_REQUESTS = 400;
const FUNDING = 100_000n;
const AMOUNT = 100n;

interface Customer {
  id: string;
  token: string;
  accounts: [string, string];
}

/** One logical request: a withdrawal or a transfer of "100" EUR, with its own key. */
interface Logical {
  key: string;
  kind: 'withdrawal' | 'transfer';
  customer: Customer;
  source: string;
  destination?: string;
  request: E2eRequest;
}

function plan(customers: readonly Customer[]): Logical[] {
  return Array.from({ length: LOGICAL_REQUESTS }, (_, index) => {
    const customer = customers[index % customers.length] as Customer;
    const kind = index % 2 === 0 ? 'withdrawal' : 'transfer';
    // Transfers go one way and back, between the two accounts of the same customer.
    const [first, second] =
      Math.floor(index / 2) % 2 === 0
        ? customer.accounts
        : ([customer.accounts[1], customer.accounts[0]] as const);
    const key = randomUUID();
    const body =
      kind === 'withdrawal'
        ? { amount: String(AMOUNT), currency: 'EUR' }
        : { amount: String(AMOUNT), currency: 'EUR', destinationAccountId: second };
    return {
      key,
      kind,
      customer,
      source: first,
      ...(kind === 'transfer' ? { destination: second } : {}),
      request: {
        method: 'POST',
        url: `/v1/accounts/${first}/${kind === 'withdrawal' ? 'withdrawals' : 'transfers'}`,
        headers: { ...bearer(customer.token), 'idempotency-key': key },
        body,
        timeoutMs: 60_000,
      },
    };
  });
}

/**
 * The traffic and the disruptions of DEP-AC11. One pacer spaces the workers' new requests: 12 ms
 * apart while both replicas serve, 125 ms while a replica is down or coming back, and further apart
 * as the requests budgeted for that disruption run low, up to 500 ms, so traffic slows down but
 * never stops while Docker takes its time, and requests are left for what comes next.
 */
class Traffic {
  readonly outcomes = new Map<string, RetriedRequest>();
  finals = 0;
  issued = 0;
  /** Requests issued while api-2 was stopping or down, and while api-1 was killed or down. */
  issuedDuringStop = 0;
  issuedDuringKill = 0;
  /** When each attempt, retries included, was sent, and when each replica was healthy again. */
  readonly sentAt: number[] = [];
  readonly healthyAt: { replica: string; at: number }[] = [];
  private phase: 'normal' | 'stop' | 'kill' = 'normal';
  private nextSlot = 0;

  constructor(private readonly logical: readonly Logical[]) {}

  /** The gap before the next new request: wider as the budget of a disruption runs low. */
  private gapMs(): number {
    if (this.phase === 'normal') return 12;
    // The stop of api-2 has the requests up to 190, the kill of api-1 all that are left.
    const budget = this.phase === 'stop' ? 190 : LOGICAL_REQUESTS;
    const remaining = budget - this.issued;
    return remaining >= 40 ? 125 : Math.min(500, (125 * 40) / Math.max(remaining, 1));
  }

  /** Waits for the next free moment of the pacer, which keeps one gap between new requests. */
  private async slot(): Promise<void> {
    const now = performance.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + this.gapMs();
    await delay(at - now);
  }

  async worker(): Promise<void> {
    for (;;) {
      await this.slot();
      if (this.issued >= this.logical.length) return;
      const item = this.logical[this.issued] as Logical;
      this.issued += 1;
      if (this.phase === 'stop') this.issuedDuringStop += 1;
      if (this.phase === 'kill') this.issuedDuringKill += 1;
      const outcome = await sendWithRetries(item.request, {
        sender: async (request) => {
          this.sentAt.push(performance.now());
          return await send(request);
        },
      });
      this.outcomes.set(item.key, outcome);
      this.finals += 1;
    }
  }

  private async healthy(replica: string): Promise<void> {
    await waitHealthy([replica]);
    this.healthyAt.push({ replica, at: performance.now() });
  }

  async disrupt(): Promise<void> {
    try {
      await waitFor('50 final answers', () => (this.finals >= 50 ? true : undefined), {
        intervalMs: 20,
      });
      this.phase = 'stop';
      await stopServices(['api-2']);
      await waitExited('api-2');
      await startServices(['api-2']);
      await this.healthy('api-2');
      this.phase = 'normal';
      await waitFor('200 final answers', () => (this.finals >= 200 ? true : undefined), {
        intervalMs: 20,
      });
      // Killed while the workers still send briskly, so requests are in flight on api-1.
      await composeOk(['kill', '-s', 'SIGKILL', 'api-1']);
      this.phase = 'kill';
      await waitExited('api-1');
      await startServices(['api-1']);
      await this.healthy('api-1');
    } finally {
      this.phase = 'normal';
    }
  }
}

describe('losing a replica during traffic', () => {
  let customers: Customer[] = [];
  let funding: Set<string>;

  beforeAll(async () => {
    await ensureStack();
    await waitForBothReplicasThroughNginx();
    const operatorId = randomUUID();
    const ids = Array.from({ length: CUSTOMERS }, () => randomUUID());
    const [operatorToken = '', ...tokens] = await toolsTokens([
      { sub: operatorId, role: 'operator' },
      ...ids.map((sub) => ({ sub, role: 'customer' as const })),
    ]);
    customers = await Promise.all(
      ids.map(async (id, index) => {
        const token = tokens[index] ?? '';
        const first = await createAccount(token);
        const second = await createAccount(token);
        await fund(operatorToken, first.id, String(FUNDING));
        await fund(operatorToken, second.id, String(FUNDING));
        return { id, token, accounts: [first.id, second.id] as [string, string] };
      }),
    );
    funding = new Set(await transactionsOn(customers.flatMap((customer) => customer.accounts)));
  });

  afterAll(async () => {
    await restoreReplicas();
    await closeStackDb();
  });

  it('DEP-AC11 losing a replica during traffic never loses or duplicates money', async () => {
    const logical = plan(customers);
    const traffic = new Traffic(logical);
    await Promise.all([
      traffic.disrupt(),
      ...Array.from({ length: WORKERS }, async () => {
        await traffic.worker();
      }),
    ]);

    const attempts = new Map<string, number>();
    for (const outcome of traffic.outcomes.values()) {
      for (const attempt of outcome.attempts) {
        attempts.set(String(attempt), (attempts.get(String(attempt)) ?? 0) + 1);
      }
    }
    console.info(
      `DEP-AC11: ${String(traffic.issuedDuringStop)} requests issued while api-2 stopped, ${String(traffic.issuedDuringKill)} while api-1 was killed; attempts: ${[...attempts].map(([status, count]) => `${String(count)} × ${status}`).join(', ')}`,
    );

    // The workers kept sending through both disruptions, up to the moment each replica was
    // healthy again: a request went out in the last second before each waitHealthy resolved.
    expect(traffic.issuedDuringStop).toBeGreaterThan(0);
    expect(traffic.issuedDuringKill).toBeGreaterThan(0);
    expect(traffic.healthyAt.map((item) => item.replica)).toEqual(['api-2', 'api-1']);
    for (const { replica, at } of traffic.healthyAt) {
      const lastSecond = traffic.sentAt.filter((sent) => sent > at - 1000 && sent <= at);
      expect(
        lastSecond.length,
        `requests sent in the last second before ${replica} was healthy`,
      ).toBeGreaterThan(0);
    }

    // Every logical request has a final answer of 201 or 422.
    expect(traffic.outcomes.size).toBe(LOGICAL_REQUESTS);
    const finals = logical.map((item) => {
      const outcome = traffic.outcomes.get(item.key);
      if (outcome === undefined) throw new Error(`no outcome for ${item.key}`);
      expect([201, 422], `${item.key}: ${outcome.attempts.join(', ')}`).toContain(
        outcome.final.status,
      );
      return { item, outcome };
    });

    // Sent again now, every key answers with the one execution's result, byte for byte.
    const replays = await Promise.all(
      finals.map(async ({ item }) => await sendWithRetries(item.request)),
    );
    for (const [index, { item, outcome }] of finals.entries()) {
      const replay = replays[index];
      expect(replay?.final.status, item.key).toBe(outcome.final.status);
      expect(replay?.final.body, item.key).toBe(outcome.final.body);
    }

    // Each 201 key has exactly one transaction, the one its stored response names, and the
    // others none.
    const succeeded = finals.filter(({ outcome }) => outcome.final.status === 201);
    const accountIds = customers.flatMap((customer) => customer.accounts);
    const created = (await transactionsOn(accountIds)).filter((id) => !funding.has(id));
    const answered = succeeded.map(
      ({ outcome }) => (JSON.parse(outcome.final.body) as { id: string }).id,
    );
    expect(new Set(answered).size).toBe(succeeded.length);
    expect(new Set(created)).toEqual(new Set(answered));
    const stored = await stackDb().query<{ key: string; status: number; body: string }>(
      `SELECT key, status, convert_from(body, 'UTF8') AS body FROM idempotency_keys
        WHERE user_id = ANY($1::uuid[]) AND key = ANY($2::text[])`,
      [customers.map((customer) => customer.id), logical.map((item) => item.key)],
    );
    expect(stored.rows).toHaveLength(LOGICAL_REQUESTS);
    const storedByKey = new Map(stored.rows.map((row) => [row.key, row]));
    for (const { item, outcome } of finals) {
      expect(storedByKey.get(item.key)?.status, item.key).toBe(outcome.final.status);
      expect(storedByKey.get(item.key)?.body, item.key).toBe(outcome.final.body);
    }

    // Every balance is its funding changed by the final 201s that involve it.
    const expected = new Map(accountIds.map((id) => [id, FUNDING]));
    for (const { item } of succeeded) {
      expected.set(item.source, (expected.get(item.source) ?? 0n) - AMOUNT);
      if (item.destination !== undefined) {
        expected.set(item.destination, (expected.get(item.destination) ?? 0n) + AMOUNT);
      }
    }
    const balances = await stackDb().query<{ id: string; balance: string }>(
      'SELECT id, balance::text AS balance FROM accounts WHERE id = ANY($1::uuid[])',
      [accountIds],
    );
    expect(Object.fromEntries(balances.rows.map((row) => [row.id, row.balance]))).toEqual(
      Object.fromEntries([...expected].map(([id, balance]) => [id, String(balance)])),
    );

    // One audit record per transaction, and the ledger reconciles.
    const all = [...funding, ...created];
    const audits = await stackDb().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_records WHERE account_ids && $1::uuid[]`,
      [accountIds],
    );
    expect(Number(audits.rows[0]?.count)).toBe(all.length);
    const audited = await stackDb().query<{ count: string }>(
      'SELECT count(DISTINCT transaction_id)::text AS count FROM audit_records WHERE transaction_id = ANY($1::uuid[])',
      [all],
    );
    expect(Number(audited.rows[0]?.count)).toBe(all.length);
    const state = await ledgerState();
    expect(state.drifted).toEqual([]);
    for (const sum of state.sums) expect(sum.sum, sum.currency).toBe('0');
    const reconciliation = await reconcileInTools();
    expect(reconciliation.code, reconciliation.output).toBe(0);
    expect(reconciliation.report?.discrepancies).toEqual([]);
  });
});
