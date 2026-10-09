// npm run seed: creates the demo users' accounts and deposits of section 1.2 of spec 008 through
// the API of the local stack, at http://nginx:8080 (DEP-R10 to DEP-R12). It runs in the tools
// service: docker compose run --rm tools npm run --silent seed.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { issueToken } from '../src/modules/auth/application/token-issuer.js';
import { ConfigError, loadAuthConfig, type Environment } from '../src/platform/config/config.js';

/** The load balancer of the local stack, as the tools service reaches it (section 1.2). */
export const SEED_API_URL = 'http://nginx:8080';

/** How long the seed waits for `/health/ready` to answer 200, and how often it asks (DEP-R12). */
export const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 1000;

/** How long one request may take before the seed gives up on it. */
const REQUEST_TIMEOUT_MS = 10_000;

type Role = 'operator' | 'customer';

interface DemoAccount {
  currency: string;
  /** The initial deposit, in minor units of the currency. */
  deposit: string;
}

interface DemoUser {
  name: string;
  id: string;
  role: Role;
  accounts: readonly DemoAccount[];
}

/**
 * Table 1.2 of spec 008: fixed user ids, so the token script can mint tokens for them; two
 * currencies of exponent 2 and JPY, of exponent 0 (2500.00 EUR, 1000.00 USD, 500.00 EUR and
 * 150000 JPY).
 */
export const DEMO_USERS: readonly DemoUser[] = [
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
      { currency: 'EUR', deposit: '250000' },
      { currency: 'USD', deposit: '100000' },
    ],
  },
  {
    name: 'demo-customer-2',
    id: '0192f0a0-0000-7000-8000-00000000d0c2',
    role: 'customer',
    accounts: [{ currency: 'EUR', deposit: '50000' }],
  },
  {
    name: 'demo-customer-3',
    id: '0192f0a0-0000-7000-8000-00000000d0c3',
    role: 'customer',
    accounts: [{ currency: 'JPY', deposit: '150000' }],
  },
];

export interface SeedRequest {
  method: 'GET' | 'POST';
  /** The path and query, such as `/v1/accounts?limit=100`. */
  path: string;
  token?: string;
  idempotencyKey?: string;
  body?: unknown;
  /** How long the request may take; `REQUEST_TIMEOUT_MS` when not given. */
  timeoutMs?: number;
}

export interface SeedResponse {
  status: number;
  /** The parsed JSON body; undefined when there is none or it is not JSON. */
  body: unknown;
}

/** How the seed reaches the API; tests inject a fake. */
export interface SeedHttp {
  request(request: SeedRequest): Promise<SeedResponse>;
}

/** Milliseconds since the epoch, and a wait; tests inject a clock they advance. */
export interface SeedClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

interface Output {
  write(text: string): unknown;
}

export interface SeedOptions {
  http: SeedHttp;
  clock: SeedClock;
  env: Environment;
  stdout: Output;
  stderr: Output;
}

const AccountSchema = z.object({
  id: z.string(),
  currency: z.string(),
  balance: z.string(),
  createdAt: z.string(),
});
type Account = z.infer<typeof AccountSchema>;
const AccountPageSchema = z.object({
  items: z.array(AccountSchema),
  nextCursor: z.string().optional(),
});
const EntryPageSchema = z.object({ items: z.array(z.unknown()) });

/** A refusal: why the seed stops, written on stderr, never with a token or a secret. */
class SeedFailure extends Error {}

/** The problem type of an error answer, when it has one. */
function problemTypeOf(body: unknown): string {
  const parsed = z.object({ type: z.string() }).safeParse(body);
  return parsed.success ? ` ${parsed.data.type}` : '';
}

/** Sends one request and returns its parsed body when the status is the expected one. */
async function expectStatus<T>(
  http: SeedHttp,
  step: string,
  request: SeedRequest,
  status: number,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: SeedResponse;
  try {
    response = await http.request(request);
  } catch {
    throw new SeedFailure(`${step}: the API could not be reached`);
  }
  if (response.status !== status) {
    throw new SeedFailure(
      `${step}: answered ${String(response.status)}${problemTypeOf(response.body)}`,
    );
  }
  const parsed = schema.safeParse(response.body);
  if (!parsed.success) throw new SeedFailure(`${step}: answered an unexpected body`);
  return parsed.data;
}

/** Polls `/health/ready` until it answers 200, for at most 60 seconds of `clock` (DEP-R12). */
async function waitUntilReady(http: SeedHttp, clock: SeedClock): Promise<void> {
  const deadline = clock.now() + READY_TIMEOUT_MS;
  const notReady = new SeedFailure(
    `API not ready: /health/ready did not answer 200 within ${String(READY_TIMEOUT_MS / 1000)} seconds`,
  );
  for (;;) {
    const remaining = deadline - clock.now();
    if (remaining <= 0) throw notReady;
    try {
      // Each poll is bounded by the time left, so a replica that accepts the connection and never
      // answers cannot hold the seed past its deadline.
      const response = await http.request({
        method: 'GET',
        path: '/health/ready',
        timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
      });
      if (response.status === 200) return;
    } catch {
      // Not reachable yet, or no answer in time: the load balancer or the replicas are starting.
    }
    const left = deadline - clock.now();
    if (left <= 0) throw notReady;
    await clock.sleep(Math.min(READY_POLL_MS, left));
  }
}

/** Every account of the caller, following the cursor through every page. */
async function listAccounts(http: SeedHttp, user: DemoUser, token: string): Promise<Account[]> {
  const accounts: Account[] = [];
  let cursor: string | undefined;
  do {
    const query = cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const page = await expectStatus(
      http,
      `list the accounts of ${user.name}`,
      { method: 'GET', path: `/v1/accounts?limit=100${query}`, token },
      200,
      AccountPageSchema,
    );
    accounts.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return accounts;
}

/** The oldest of the accounts in `currency`, the one the seed created first; none when absent. */
function oldestIn(accounts: readonly Account[], currency: string): Account | undefined {
  return accounts
    .filter((account) => account.currency === currency)
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    )[0];
}

/**
 * Creates a missing account and deposits its initial amount (section 1.2): it deposits only into
 * an account created in this run or whose history is empty, so a second run moves no money,
 * whatever time has passed (DEP-R11). Each request carries a fixed Idempotency-Key, so a retry
 * within the key's lifetime is replayed. Returns the account's id.
 */
async function seedAccount(
  http: SeedHttp,
  user: DemoUser,
  demo: DemoAccount,
  existing: readonly Account[],
  tokens: { customer: string; operator: string },
): Promise<string> {
  let account = oldestIn(existing, demo.currency);
  let empty = account === undefined;
  if (account === undefined) {
    account = await expectStatus(
      http,
      `create the ${demo.currency} account of ${user.name}`,
      {
        method: 'POST',
        path: '/v1/accounts',
        token: tokens.customer,
        idempotencyKey: `seed-account-${demo.currency}`,
        body: { currency: demo.currency },
      },
      201,
      AccountSchema,
    );
  } else {
    const history = await expectStatus(
      http,
      `read the history of the ${demo.currency} account of ${user.name}`,
      { method: 'GET', path: `/v1/accounts/${account.id}/entries?limit=1`, token: tokens.customer },
      200,
      EntryPageSchema,
    );
    empty = history.items.length === 0;
  }
  if (empty) {
    await expectStatus(
      http,
      `deposit into the ${demo.currency} account of ${user.name}`,
      {
        method: 'POST',
        path: `/v1/accounts/${account.id}/deposits`,
        token: tokens.operator,
        idempotencyKey: `seed-deposit-${user.id}-${demo.currency}`,
        body: { amount: demo.deposit, currency: demo.currency },
      },
      201,
      z.unknown(),
    );
  }
  return account.id;
}

interface SeededUser {
  name: string;
  id: string;
  role: Role;
  accounts: { id: string; currency: string; balance: string }[];
}

/**
 * `npm run seed` (section 1.2 of spec 008): refuses `NODE_ENV` `production`, waits for the API to
 * be ready, then for each customer of table 1.2 creates the accounts that do not exist yet and
 * deposits their initial amounts as the operator, through the API, so every deposit is a real
 * movement with ledger entries and an audit record. It mints the users' tokens itself and never
 * prints them. It prints the users with their account ids, currencies and balances as one JSON
 * document and returns 0; on a refusal it prints one line naming the reason on stderr and returns
 * 1 (DEP-R10 to DEP-R12).
 */
export async function runSeed(options: SeedOptions): Promise<0 | 1> {
  const { http, clock, env, stdout, stderr } = options;
  try {
    if (env['NODE_ENV'] === 'production') {
      throw new SeedFailure(
        'refused: NODE_ENV is production, and the seed is for the local stack only',
      );
    }
    await waitUntilReady(http, clock);
    const settings = loadAuthConfig(env);
    const tokenOf = async (user: DemoUser): Promise<string> =>
      await issueToken({ userId: user.id, role: user.role }, settings, clock.now() / 1000);
    const operator = DEMO_USERS.find((user) => user.role === 'operator');
    if (operator === undefined) throw new SeedFailure('table 1.2 has no operator');
    const operatorToken = await tokenOf(operator);

    const seeded: SeededUser[] = [];
    for (const user of DEMO_USERS) {
      if (user.role === 'operator') {
        seeded.push({ name: user.name, id: user.id, role: user.role, accounts: [] });
        continue;
      }
      const customerToken = await tokenOf(user);
      const existing = await listAccounts(http, user, customerToken);
      const ids: string[] = [];
      for (const demo of user.accounts) {
        ids.push(
          await seedAccount(http, user, demo, existing, {
            customer: customerToken,
            operator: operatorToken,
          }),
        );
      }
      const current = await listAccounts(http, user, customerToken);
      seeded.push({
        name: user.name,
        id: user.id,
        role: user.role,
        accounts: ids.map((id) => {
          const account = current.find((item) => item.id === id);
          if (account === undefined) throw new SeedFailure(`account ${id} of ${user.name} is gone`);
          return { id: account.id, currency: account.currency, balance: account.balance };
        }),
      });
    }
    stdout.write(`${JSON.stringify({ users: seeded }, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof SeedFailure) {
      stderr.write(`seed: ${error.message}\n`);
      return 1;
    }
    if (error instanceof ConfigError) {
      stderr.write(`seed: ${error.message}\n`);
      return 1;
    }
    stderr.write(`seed: failed (${error instanceof Error ? error.name : 'unknown error'})\n`);
    return 1;
  }
}

/** The API through `fetch`, as JSON. */
export function fetchHttp(baseUrl: string): SeedHttp {
  return {
    async request(request) {
      const headers: Record<string, string> = {};
      if (request.token !== undefined) headers['authorization'] = `Bearer ${request.token}`;
      if (request.idempotencyKey !== undefined) headers['idempotency-key'] = request.idempotencyKey;
      if (request.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(new URL(request.path, baseUrl), {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: response.status, body };
    },
  };
}

const SYSTEM_CLOCK: SeedClock = {
  now: () => Date.now(),
  sleep: async (ms) => {
    await new Promise((done) => setTimeout(done, ms));
  },
};

// Runs only as the entry point, so the unit tests can import runSeed.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSeed({
    http: fetchHttp(SEED_API_URL),
    clock: SYSTEM_CLOCK,
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
