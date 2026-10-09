import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  DEMO_USERS,
  runSeed,
  type SeedClock,
  type SeedHttp,
  type SeedRequest,
  type SeedResponse,
} from '../../../scripts/seed.js';

/** The demo environment of the tools service (section 1.4 of spec 008). */
const ENV = {
  NODE_ENV: 'development',
  JWT_SECRET: 'demo-only-jwt-secret-for-docker-compose-00000000',
  JWT_ISSUER: 'supercool-finances-local',
  JWT_AUDIENCE: 'supercool-finances-api',
};

/** Starts at an arbitrary instant; `sleep` advances it at once. */
class FakeClock implements SeedClock {
  current = Date.UTC(2026, 9, 8, 12, 0, 0);

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    this.current += ms;
    return Promise.resolve();
  }
}

interface FakeAccount {
  id: string;
  ownerId: string;
  currency: string;
  balance: bigint;
  createdAt: string;
  entries: { id: string; amount: string }[];
}

/**
 * An in-memory API with the behaviour the seed relies on: accounts listed newest first, creation
 * and deposits keyed by user and Idempotency-Key, histories, and readiness. It reads the caller
 * from the token's claims without verifying it, and records every request.
 */
class FakeApi implements SeedHttp {
  readonly requests: SeedRequest[] = [];
  readonly accounts: FakeAccount[] = [];
  transactions = 0;
  ready = true;
  /** Responses stored per (user, key), as the service's key rows. */
  readonly #keys = new Map<string, SeedResponse>();
  #ids = 0;

  expireKeys(): void {
    this.#keys.clear();
  }

  request(request: SeedRequest): Promise<SeedResponse> {
    this.requests.push(request);
    return Promise.resolve(this.#answer(request));
  }

  #nextId(): string {
    this.#ids += 1;
    return `0192f0a0-0000-7000-8000-${this.#ids.toString(16).padStart(12, '0')}`;
  }

  #caller(request: SeedRequest): { sub: string; role: string } {
    const claims = decodeJwt(request.token ?? '');
    return { sub: String(claims.sub), role: String(claims['role']) };
  }

  #keyed(request: SeedRequest, run: () => SeedResponse): SeedResponse {
    const slot = `${this.#caller(request).sub}:${request.idempotencyKey ?? ''}`;
    const stored = this.#keys.get(slot);
    if (stored !== undefined) return stored;
    const response = run();
    this.#keys.set(slot, response);
    return response;
  }

  #view(account: FakeAccount) {
    return {
      id: account.id,
      currency: account.currency,
      status: 'active',
      balance: account.balance.toString(),
      createdAt: account.createdAt,
      updatedAt: account.createdAt,
    };
  }

  #answer(request: SeedRequest): SeedResponse {
    const { method, path } = request;
    if (method === 'GET' && path === '/health/ready') {
      return this.ready ? { status: 200, body: { status: 'ready' } } : { status: 503, body: {} };
    }
    const caller = this.#caller(request);
    if (method === 'GET' && path.startsWith('/v1/accounts?')) {
      const own = this.accounts
        .filter((account) => account.ownerId === caller.sub)
        .reverse()
        .map((account) => this.#view(account));
      return { status: 200, body: { items: own } };
    }
    if (method === 'POST' && path === '/v1/accounts') {
      expect(caller.role).toBe('customer');
      expect(request.idempotencyKey).toMatch(/^[!-~]{1,255}$/);
      return this.#keyed(request, () => {
        const account: FakeAccount = {
          id: this.#nextId(),
          ownerId: caller.sub,
          currency: (request.body as { currency: string }).currency,
          balance: 0n,
          createdAt: new Date(Date.UTC(2026, 9, 8) + this.#ids).toISOString(),
          entries: [],
        };
        this.accounts.push(account);
        return { status: 201, body: this.#view(account) };
      });
    }
    const entries = /^\/v1\/accounts\/([^/]+)\/entries\?limit=1$/.exec(path);
    if (method === 'GET' && entries !== null) {
      const account = this.accounts.find((item) => item.id === entries[1]);
      if (account === undefined || account.ownerId !== caller.sub) return { status: 404, body: {} };
      return { status: 200, body: { items: account.entries.slice(-1) } };
    }
    const deposit = /^\/v1\/accounts\/([^/]+)\/deposits$/.exec(path);
    if (method === 'POST' && deposit !== null) {
      expect(caller.role).toBe('operator');
      expect(request.idempotencyKey).toMatch(/^[!-~]{1,255}$/);
      return this.#keyed(request, () => {
        const account = this.accounts.find((item) => item.id === deposit[1]);
        if (account === undefined) return { status: 404, body: {} };
        const { amount, currency } = request.body as { amount: string; currency: string };
        expect(currency).toBe(account.currency);
        account.balance += BigInt(amount);
        account.entries.push({ id: this.#nextId(), amount });
        this.transactions += 1;
        return { status: 201, body: { id: this.#nextId(), kind: 'deposit', amount, currency } };
      });
    }
    throw new Error(`unexpected request ${method} ${path}`);
  }
}

/** Collects what the seed writes. */
function capture(): { write(text: string): boolean; text: string } {
  return {
    text: '',
    write(text) {
      this.text += text;
      return true;
    },
  };
}

async function seed(http: SeedHttp, env: Record<string, string> = ENV, clock = new FakeClock()) {
  const stdout = capture();
  const stderr = capture();
  const code = await runSeed({ http, clock, env, stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('the seed', () => {
  it('DEP-AC07 refuses NODE_ENV production and an API not ready within 60 seconds, sending nothing but /health/ready', async () => {
    const production = new FakeApi();
    const refused = await seed(production, { ...ENV, NODE_ENV: 'production' });

    expect(refused.code).not.toBe(0);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('production');
    expect(production.requests).toEqual([]);

    const unready = new FakeApi();
    unready.ready = false;
    const clock = new FakeClock();
    const start = clock.now();
    const waited = await seed(unready, ENV, clock);

    expect(waited.code).not.toBe(0);
    expect(waited.stdout).toBe('');
    expect(waited.stderr).toContain('API not ready');
    expect(clock.now() - start).toBe(60_000);
    expect(unready.requests.length).toBeGreaterThan(1);
    for (const request of unready.requests) {
      expect(request).toEqual({
        method: 'GET',
        path: '/health/ready',
        timeoutMs: expect.any(Number) as unknown,
      });
    }
    expect(unready.accounts).toEqual([]);
  });

  it('DEP-R12 bounds each readiness poll by the time left, so an API that never answers stops the seed at 60 seconds', async () => {
    const clock = new FakeClock();
    const start = clock.now();
    const polls: { timeoutMs: number | undefined; left: number }[] = [];
    // Accepts every request and never answers: each one ends only when its timeout fires, after
    // the 10 s the seed's client defaults to when the request names none.
    const hanging: SeedHttp = {
      request(request) {
        polls.push({ timeoutMs: request.timeoutMs, left: start + 60_000 - clock.now() });
        clock.current += request.timeoutMs ?? 10_000;
        return Promise.reject(new Error('the request timed out'));
      },
    };

    const run = await seed(hanging, ENV, clock);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('API not ready');
    expect(clock.now() - start).toBe(60_000);
    expect(polls.length).toBeGreaterThan(1);
    for (const poll of polls) {
      expect(poll.timeoutMs).toBeDefined();
      expect(poll.timeoutMs ?? Infinity).toBeLessThanOrEqual(poll.left);
    }
  });

  it('DEP-R10 DEP-R11 a first run creates the accounts and deposits of table 1.2 through the API, and a second run after every key expired creates and moves nothing and prints the same JSON', async () => {
    const api = new FakeApi();

    const first = await seed(api);

    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toBe('');
    const printed = JSON.parse(first.stdout) as unknown;
    expect(printed).toEqual({
      users: [
        {
          name: 'demo-operator',
          id: '0192f0a0-0000-7000-8000-00000000d0f1',
          role: 'operator',
          accounts: [],
        },
        {
          name: 'demo-customer-1',
          id: '0192f0a0-0000-7000-8000-00000000d0c1',
          role: 'customer',
          accounts: [
            { id: expect.any(String) as unknown, currency: 'EUR', balance: '250000' },
            { id: expect.any(String) as unknown, currency: 'USD', balance: '100000' },
          ],
        },
        {
          name: 'demo-customer-2',
          id: '0192f0a0-0000-7000-8000-00000000d0c2',
          role: 'customer',
          accounts: [{ id: expect.any(String) as unknown, currency: 'EUR', balance: '50000' }],
        },
        {
          name: 'demo-customer-3',
          id: '0192f0a0-0000-7000-8000-00000000d0c3',
          role: 'customer',
          accounts: [{ id: expect.any(String) as unknown, currency: 'JPY', balance: '150000' }],
        },
      ],
    });
    expect(api.accounts.map((account) => [account.ownerId.slice(-4), account.currency])).toEqual([
      ['d0c1', 'EUR'],
      ['d0c1', 'USD'],
      ['d0c2', 'EUR'],
      ['d0c3', 'JPY'],
    ]);
    expect(api.transactions).toBe(4);
    // No token is ever printed.
    for (const request of api.requests.filter((item) => item.token !== undefined)) {
      expect(first.stdout).not.toContain(request.token);
    }

    api.expireKeys();
    const before = api.requests.length;
    const second = await seed(api);

    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(api.accounts).toHaveLength(4);
    expect(api.transactions).toBe(4);
    expect(api.requests.slice(before).filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('DEP-R10 deposits into an account left empty by an interrupted run, and creates only the currencies missing', async () => {
    const api = new FakeApi();
    await seed(api);
    // demo-customer-2's EUR account loses its deposit history, as if the run had stopped between
    // creating it and depositing; demo-customer-3's JPY account is gone.
    const eur = api.accounts.find((account) => account.ownerId.endsWith('d0c2'));
    if (eur === undefined) throw new Error('no account for demo-customer-2');
    eur.entries = [];
    eur.balance = 0n;
    api.accounts.splice(
      api.accounts.findIndex((account) => account.ownerId.endsWith('d0c3')),
      1,
    );
    api.expireKeys();
    const transactions = api.transactions;

    const run = await seed(api);

    expect(run.code, run.stderr).toBe(0);
    expect(api.transactions).toBe(transactions + 2);
    expect(eur.balance).toBe(50000n);
    expect(api.accounts.filter((account) => account.ownerId.endsWith('d0c3'))).toHaveLength(1);
    expect(api.accounts).toHaveLength(4);
  });

  it('DEP-R10 exits 1 and names the step when the API refuses a request', async () => {
    const api = new FakeApi();
    const refusing: SeedHttp = {
      request: async (request) =>
        request.method === 'POST' && request.path.endsWith('/deposits')
          ? { status: 422, body: { type: '/problems/account-not-active' } }
          : await api.request(request),
    };

    const run = await seed(refusing);

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('deposit');
    expect(run.stderr).toContain('422');
    expect(run.stderr).toContain('/problems/account-not-active');
  });

  it('DEP-R10 lists the table of users with fixed ids', () => {
    expect(DEMO_USERS.map((user) => [user.name, user.id, user.role])).toEqual([
      ['demo-operator', '0192f0a0-0000-7000-8000-00000000d0f1', 'operator'],
      ['demo-customer-1', '0192f0a0-0000-7000-8000-00000000d0c1', 'customer'],
      ['demo-customer-2', '0192f0a0-0000-7000-8000-00000000d0c2', 'customer'],
      ['demo-customer-3', '0192f0a0-0000-7000-8000-00000000d0c3', 'customer'],
    ]);
  });
});
