// npm run load: the load test of SYS-R20 and SYS-AC17 against a running stack, through its load
// balancer (E2E_BASE_URL, http://localhost:8080 by default, local only, since the reconciliation
// reads the stack's database on 127.0.0.1). It funds 1000 customer account pairs
// in EUR through the API, then sends single deposits, withdrawals and transfers in equal thirds as
// an open model: each request leaves at its own scheduled moment, at LOAD_RATE_PER_SECOND requests
// per second (200 by default, 5 ms apart) over 60 seconds, whether or not earlier ones have been
// answered, and its latency runs from
// that moment, so a slow stack shows in the latencies instead of slowing the load down. It drains
// every request still in flight, runs the reconciliation, and writes the report to
// docs/performance.md and reports/load-test.json. The test of SYS-AC17 runs it; so can `make load`
// against the stack of `make up`.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { parse } from 'yaml';
import { issueToken } from '../src/modules/auth/application/token-issuer.js';
import type { TokenSettings } from '../src/modules/auth/application/token-verifier.js';
import { runReconcile } from '../src/modules/ledger/adapters/cli/reconcile.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const REPORT_PATH = join(ROOT, 'docs', 'performance.md');
export const RESULT_PATH = join(ROOT, 'reports', 'load-test.json');

/** The rate of SYS-R20 when `LOAD_RATE_PER_SECOND` is unset; the CI job e2e sets 100. */
export const DEFAULT_RATE_PER_SECOND = 200;
/** Below the load balancer's per-IP limit of 500 requests per second (SEC-R01). */
const MAX_RATE_PER_SECOND = 500;

/**
 * The parameters SYS-R20 and SYS-AC17 fix, and the identities SEC-AC05 spreads them over: the
 * deposits over 10 operators, about 7 requests per second each at 200 per second, and the
 * withdrawals and transfers over the 1000 customers of the pairs, well under the per-user limit of
 * 300 per 10 s (SEC-R09). The rate comes from `LOAD_RATE_PER_SECOND`, 200 by default.
 */
const FIXED_PARAMETERS = {
  durationSeconds: 60,
  pairs: 1000,
  operators: 10,
  /** Every movement moves 1.00 EUR. */
  amount: '100',
  /** What each account of a pair is funded with: 1000.00 EUR, far more than the run withdraws. */
  funding: '100000',
  /** The target the report states, not a guarantee (SYS-R20). */
  p99TargetMs: 300,
} as const;

export type LoadParameters = typeof FIXED_PARAMETERS & { ratePerSecond: number };

/**
 * The parameters of a run: `LOAD_RATE_PER_SECOND` from `environment`, a whole number from 1 to
 * 500, or 200 when unset. Any other value is refused, naming the variable.
 */
export function loadParameters(environment: NodeJS.ProcessEnv = process.env): LoadParameters {
  const raw = environment['LOAD_RATE_PER_SECOND'];
  const ratePerSecond = raw === undefined || raw === '' ? DEFAULT_RATE_PER_SECOND : Number(raw);
  if (
    (raw !== undefined && raw !== '' && !/^[1-9][0-9]*$/.test(raw)) ||
    ratePerSecond > MAX_RATE_PER_SECOND
  ) {
    throw new Error(
      `LOAD_RATE_PER_SECOND must be a whole number from 1 to ${String(MAX_RATE_PER_SECOND)}`,
    );
  }
  return { ratePerSecond, ...FIXED_PARAMETERS };
}

/** The setup's own pace and parallelism, under the load balancer's 500 requests per second. */
const SETUP_RATE_PER_SECOND = 250;
const SETUP_CONCURRENCY = 32;

/**
 * The connections the generator may hold open at once. A request whose moment comes while all are
 * busy waits for one, and that wait counts in its latency. 256 covers 200 requests per second up
 * to more than a second of latency, and stays far below what a Docker VM's port forwarding takes.
 */
export const SOCKETS = 256;

/** A request with no complete answer this long after its moment is lost. */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The most a request may leave after its scheduled moment. Beyond it the generator itself fell
 * behind its schedule, and the run measured less than the rate it claims.
 */
export const MAX_GENERATOR_LAG_MS = 100;

type Kind = 'deposit' | 'withdrawal' | 'transfer';
const KINDS: readonly Kind[] = ['deposit', 'withdrawal', 'transfer'];

interface Pair {
  token: string;
  a: string;
  b: string;
}

export interface Machine {
  host: string;
  os: string;
  node: string;
  docker: string;
}

export interface LoadResult {
  finishedAt: string;
  baseUrl: string;
  machine: Machine;
  parameters: LoadParameters;
  setup: { requests: number; statusCodes: Record<string, number>; seconds: number };
  run: {
    /** Requests on the schedule: the rate times the duration. */
    scheduled: number;
    /** Requests sent: every scheduled one, unless the run stopped early. */
    sent: number;
    /** Complete answers. Every request sent ends as one of these, an error or a loss. */
    responses: number;
    /** The answers by kind of movement. */
    byKind: Record<Kind, number>;
    statusCodes: Record<string, number>;
    non2xx: number;
    fiveXx: number;
    /** The 5xx answers by status and problem type, as "503 /problems/service-unavailable". */
    fiveXxTypes: Record<string, number>;
    /** Connection errors, by code. */
    errors: number;
    errorCodes: Record<string, number>;
    /** Requests with no answer within `REQUEST_TIMEOUT_MS` of their moment. */
    lost: number;
    /** From the first scheduled moment to the last answer, and the wait after the last send. */
    seconds: number;
    drainSeconds: number;
    sendRatePerSecond: number;
    throughputPerSecond: number;
    latencyMs: { p50: number; p95: number; p99: number; max: number; mean: number };
    generator: { maxLagMs: number; p99LagMs: number; behind: boolean };
    p99TargetMet: boolean;
  };
  reconciliation: { exitCode: number; report: unknown };
  /** No 5xx, no error, no lost request, a schedule kept and a ledger that reconciles. */
  passed: boolean;
}

/** The stack's settings, read from `compose.yaml`: the API runs with these demo values. */
function stackSettings(): { jwt: TokenSettings; databaseUrl: string } {
  const compose = parse(readFileSync(join(ROOT, 'compose.yaml'), 'utf8'), { merge: true }) as {
    'x-service-environment': Record<string, string>;
    services: { postgres: { ports: string[] } };
  };
  const environment = compose['x-service-environment'];
  const value = (name: string): string => {
    const found = environment[name];
    if (found === undefined) throw new Error(`compose.yaml sets no ${name}`);
    return found;
  };
  // The runtime role's URL, through the port PostgreSQL publishes on the host.
  const url = new URL(value('DATABASE_URL'));
  const published = /^127\.0\.0\.1:(\d+):5432$/.exec(compose.services.postgres.ports[0] ?? '');
  if (published === null) throw new Error('compose.yaml publishes no PostgreSQL port');
  url.hostname = '127.0.0.1';
  url.port = published[1] ?? '';
  return {
    jwt: {
      secret: value('JWT_SECRET'),
      issuer: value('JWT_ISSUER'),
      audience: value('JWT_AUDIENCE'),
    },
    databaseUrl: url.toString(),
  };
}

/** Runs `task` for every index, at most `ratePerSecond` starts per second and `concurrency` at once. */
async function paced<T>(
  count: number,
  ratePerSecond: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array<T>(count);
  const start = performance.now();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) {
      const index = next;
      next += 1;
      const due = start + (index * 1000) / ratePerSecond;
      const wait = due - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      results[index] = await task(index);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/** Counts statuses of the setup requests; a setup request that is not 201 stops the run. */
class SetupClient {
  readonly statusCodes: Record<string, number> = {};
  requests = 0;

  constructor(private readonly baseUrl: string) {}

  async post(path: string, token: string, body: unknown): Promise<{ id: string }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify(body),
    });
    this.requests += 1;
    const status = String(response.status);
    this.statusCodes[status] = (this.statusCodes[status] ?? 0) + 1;
    const text = await response.text();
    if (response.status !== 201) {
      throw new Error(`setup: POST ${path} answered ${status}: ${text}`);
    }
    return JSON.parse(text) as { id: string };
  }
}

/** The value at quantile `q` of sorted `values`, by the nearest-rank method. */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? 0;
}

function run(command: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** The machine the run used: the host, and the Docker engine, which may run inside a VM. */
export function describeMachine(): Machine {
  const processors = cpus();
  const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);
  const macos = platform() === 'darwin' ? run('sw_vers', ['-productVersion']) : undefined;
  const info = run('docker', ['info', '--format', '{{json .}}']);
  let docker = 'unknown';
  if (info !== undefined) {
    const parsed = JSON.parse(info) as {
      ServerVersion?: string;
      OperatingSystem?: string;
      NCPU?: number;
      MemTotal?: number;
    };
    docker =
      `Docker Engine ${parsed.ServerVersion ?? '?'} on ${parsed.OperatingSystem ?? '?'}, ` +
      `${String(parsed.NCPU ?? '?')} CPUs and ${gib(parsed.MemTotal ?? 0)} GiB available to containers`;
  }
  return {
    host: `${processors[0]?.model ?? 'unknown CPU'}, ${String(processors.length)} CPUs, ${gib(totalmem())} GiB of memory`,
    os: macos === undefined ? `${platform()} ${release()} ${arch()}` : `macOS ${macos} (${arch()})`,
    node: `Node.js ${process.version}`,
    docker,
  };
}

/** Creates the customers, their account pairs and the operators, and funds every account. */
async function setUp(
  baseUrl: string,
  jwt: TokenSettings,
  parameters: LoadParameters,
): Promise<{ pairs: Pair[]; operators: string[]; client: SetupClient; seconds: number }> {
  const started = performance.now();
  const now = Date.now() / 1000;
  const client = new SetupClient(baseUrl);
  const operators = await Promise.all(
    Array.from(
      { length: parameters.operators },
      async () => await issueToken({ userId: randomUUID(), role: 'operator' }, jwt, now),
    ),
  );
  const customers = await Promise.all(
    Array.from(
      { length: parameters.pairs },
      async () => await issueToken({ userId: randomUUID(), role: 'customer' }, jwt, now),
    ),
  );
  const accounts = await paced(
    customers.length * 2,
    SETUP_RATE_PER_SECOND,
    SETUP_CONCURRENCY,
    async (index) => {
      const token = customers[Math.floor(index / 2)] ?? '';
      return (await client.post('/v1/accounts', token, { currency: 'EUR' })).id;
    },
  );
  await paced(accounts.length, SETUP_RATE_PER_SECOND, SETUP_CONCURRENCY, async (index) => {
    const operator = operators[index % operators.length] ?? '';
    await client.post(`/v1/accounts/${accounts[index] ?? ''}/deposits`, operator, {
      amount: parameters.funding,
      currency: 'EUR',
    });
  });
  const pairs = customers.map((token, index) => ({
    token,
    a: accounts[index * 2] ?? '',
    b: accounts[index * 2 + 1] ?? '',
  }));
  return { pairs, operators, client, seconds: (performance.now() - started) / 1000 };
}

/** The body, path and token of the scheduled request number `index`. */
function movement(
  index: number,
  pairs: readonly Pair[],
  operators: readonly string[],
  amount: string,
): { kind: Kind; path: string; token: string; body: Record<string, string> } {
  const kind = KINDS[index % KINDS.length] ?? 'deposit';
  const round = Math.floor(index / KINDS.length);
  const pair = pairs[round % pairs.length] ?? { token: '', a: '', b: '' };
  const body = { amount, currency: 'EUR' };
  if (kind === 'deposit') {
    const account = round % 2 === 0 ? pair.a : pair.b;
    return {
      kind,
      path: `/v1/accounts/${account}/deposits`,
      token: operators[round % operators.length] ?? '',
      body,
    };
  }
  if (kind === 'withdrawal') {
    return { kind, path: `/v1/accounts/${pair.a}/withdrawals`, token: pair.token, body };
  }
  return {
    kind,
    path: `/v1/accounts/${pair.a}/transfers`,
    token: pair.token,
    body: { ...body, destinationAccountId: pair.b },
  };
}

const sum = (values: Iterable<number>): number => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

/** Runs the whole load test against `baseUrl` and returns its result. */
export async function runLoadTest(
  baseUrl: string,
  parameters: LoadParameters = loadParameters(),
): Promise<LoadResult> {
  const settings = stackSettings();
  const {
    pairs,
    operators,
    client,
    seconds: setupSeconds,
  } = await setUp(baseUrl, settings.jwt, parameters);

  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: SOCKETS,
    // `localhost` names ::1 and 127.0.0.1; Docker may publish on 127.0.0.1 only.
    autoSelectFamilyAttemptTimeout: 30_000,
  });
  const scheduled = parameters.ratePerSecond * parameters.durationSeconds;
  const intervalMs = 1000 / parameters.ratePerSecond;
  const latencies: number[] = [];
  const lags: number[] = [];
  const statusCodes: Record<string, number> = {};
  const fiveXxTypes: Record<string, number> = {};
  const errorCodes: Record<string, number> = {};
  const byKind: Record<Kind, number> = { deposit: 0, withdrawal: 0, transfer: 0 };
  let lost = 0;
  let lastAnswer = 0;

  /** Sends request number `index`, due at `due`, and settles once it has an outcome. */
  const send = async (index: number, due: number): Promise<void> => {
    const { kind, path, token, body } = movement(index, pairs, operators, parameters.amount);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        if (error instanceof LostRequest) {
          lost += 1;
        } else {
          const code = (error as NodeJS.ErrnoException).code ?? 'error';
          errorCodes[code] = (errorCodes[code] ?? 0) + 1;
        }
        settle();
      };
      const request = http.request(
        new URL(path, baseUrl),
        {
          method: 'POST',
          agent,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': String(payload.length),
            'idempotency-key': randomUUID(),
          },
        },
        (response) => {
          // Only a 5xx body is kept, for its problem type; every other body is discarded.
          const serverError = (response.statusCode ?? 0) >= 500;
          const chunks: Buffer[] = [];
          if (serverError) response.on('data', (chunk: Buffer) => chunks.push(chunk));
          else response.resume();
          response.once('error', fail);
          response.once('end', () => {
            if (settled) return;
            const now = performance.now();
            latencies.push(now - due);
            lastAnswer = Math.max(lastAnswer, now);
            const status = String(response.statusCode ?? 0);
            statusCodes[status] = (statusCodes[status] ?? 0) + 1;
            if (serverError) {
              const type = problemType(Buffer.concat(chunks).toString('utf8'));
              const key = `${status} ${type}`;
              fiveXxTypes[key] = (fiveXxTypes[key] ?? 0) + 1;
            }
            byKind[kind] += 1;
            settle();
          });
        },
      );
      const timer = setTimeout(
        () => {
          request.destroy(new LostRequest());
        },
        REQUEST_TIMEOUT_MS - (performance.now() - due),
      );
      request.once('error', fail);
      request.end(payload);
    });
  };

  // The schedule: request i is due at start + i × 5 ms. Each tick sends every request now due,
  // without waiting for any answer, and records how late it left.
  const inFlight: Promise<void>[] = [];
  const start = performance.now() + 20;
  let next = 0;
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      while (next < scheduled && start + next * intervalMs <= now) {
        const due = start + next * intervalMs;
        lags.push(now - due);
        inFlight.push(send(next, due));
        next += 1;
      }
      if (next >= scheduled) {
        resolve();
        return;
      }
      setTimeout(tick, Math.max(0, start + next * intervalMs - performance.now()));
    };
    tick();
  });
  const lastSent = performance.now();
  // Drain: every request sent ends with an answer, an error or a loss before anything is counted.
  await Promise.all(inFlight);
  agent.destroy();

  latencies.sort((left, right) => left - right);
  lags.sort((left, right) => left - right);
  const round = (value: number): number => Math.round(value * 10) / 10;
  const responses = latencies.length;
  const total = (prefix: string): number =>
    sum(
      Object.entries(statusCodes)
        .filter(([status]) => status.startsWith(prefix))
        .map(([, count]) => count),
    );
  const fiveXx = total('5');
  const errors = sum(Object.values(errorCodes));
  const p99 = round(percentile(latencies, 0.99));
  const maxLagMs = round(lags.at(-1) ?? 0);
  const behind = maxLagMs > MAX_GENERATOR_LAG_MS || next < scheduled;
  const end = Math.max(lastAnswer, lastSent);

  // The reconciliation of LED-R21 against the stack's database, as the runtime role.
  const lines: string[] = [];
  const capture = { write: (text: string): boolean => lines.push(text) > 0 };
  const exitCode = await runReconcile({
    databaseUrl: settings.databaseUrl,
    stdout: capture,
    stderr: capture,
  });
  const reportLine = lines
    .join('')
    .split('\n')
    .find((line) => line.startsWith('{'));

  return {
    finishedAt: new Date().toISOString(),
    baseUrl,
    machine: describeMachine(),
    parameters,
    setup: {
      requests: client.requests,
      statusCodes: client.statusCodes,
      seconds: round(setupSeconds),
    },
    run: {
      scheduled,
      sent: next,
      responses,
      byKind,
      statusCodes,
      non2xx: responses - total('2'),
      fiveXx,
      fiveXxTypes,
      errors,
      errorCodes,
      lost,
      seconds: round((end - start) / 1000),
      drainSeconds: round((end - lastSent) / 1000),
      sendRatePerSecond: round(next / ((lastSent - start) / 1000)),
      throughputPerSecond: round(responses / ((end - start) / 1000)),
      latencyMs: {
        p50: round(percentile(latencies, 0.5)),
        p95: round(percentile(latencies, 0.95)),
        p99,
        max: round(latencies.at(-1) ?? 0),
        mean: round(sum(latencies) / Math.max(1, responses)),
      },
      generator: { maxLagMs, p99LagMs: round(percentile(lags, 0.99)), behind },
      p99TargetMet: p99 < parameters.p99TargetMs,
    },
    reconciliation: {
      exitCode,
      report: reportLine === undefined ? undefined : (JSON.parse(reportLine) as unknown),
    },
    passed:
      fiveXx === 0 &&
      errors === 0 &&
      lost === 0 &&
      responses === scheduled &&
      !behind &&
      exitCode === 0,
  };
}

/** The `type` of a problem details body, or what the body was when it is not one. */
function problemType(body: string): string {
  try {
    const parsed = JSON.parse(body) as { type?: unknown };
    if (typeof parsed.type === 'string') return parsed.type;
  } catch {
    // Not JSON, such as a load balancer's own HTML page.
  }
  return body.trim() === '' ? '(empty body)' : '(no problem body)';
}

/** A request that got no complete answer within `REQUEST_TIMEOUT_MS` of its moment. */
class LostRequest extends Error {
  constructor() {
    super(`no answer within ${String(REQUEST_TIMEOUT_MS)} ms`);
  }
}

/** The report of `docs/performance.md`. */
export function renderReport(result: LoadResult): string {
  const { run: measured, parameters, machine } = result;
  const target = measured.p99TargetMet
    ? `met: p99 ${String(measured.latencyMs.p99)} ms is under ${String(parameters.p99TargetMs)} ms`
    : `missed: p99 ${String(measured.latencyMs.p99)} ms is not under ${String(parameters.p99TargetMs)} ms`;
  const codes = Object.entries(measured.statusCodes)
    .map(([status, count]) => `${status}: ${String(count)}`)
    .join(', ');
  const fiveXxTypes = Object.entries(measured.fiveXxTypes)
    .map(([type, count]) => `${type}: ${String(count)}`)
    .join(', ');
  const errorCodes = Object.entries(measured.errorCodes)
    .map(([code, count]) => `${code}: ${String(count)}`)
    .join(', ');
  const reconciliation =
    result.reconciliation.exitCode === 0
      ? 'clean: every cached balance matches the ledger and every currency sums to zero (SYS-AC11, SYS-AC12)'
      : `exit code ${String(result.reconciliation.exitCode)}: ${JSON.stringify(result.reconciliation.report)}`;
  const generator = measured.generator.behind
    ? `fell behind its schedule: a request left ${String(measured.generator.maxLagMs)} ms after its moment, more than ${String(MAX_GENERATOR_LAG_MS)} ms, so the run is not valid`
    : `kept its schedule: every request left at most ${String(measured.generator.maxLagMs)} ms after its moment (p99 ${String(measured.generator.p99LagMs)} ms; the limit is ${String(MAX_GENERATOR_LAG_MS)} ms)`;
  return `# Performance

The latest result of the load test of SYS-R20 (\`scripts/load-test.ts\`), written by the test itself. It runs as \`npm run load\` or \`make load\` against the stack of \`docker compose up --build --wait\`, and the e2e test of SYS-AC17 runs it too, so every e2e run rewrites this file. The rate is \`LOAD_RATE_PER_SECOND\`, 200 requests per second by default; the CI job \`e2e\` runs at 100, because its runner has 2 CPUs for the whole stack and the generator, and the result committed here is a local run at 200. The p99 target is reported, not guaranteed: a run that misses it does not fail. A run fails on a 5xx, a connection error, a lost request, a ledger that does not reconcile, or a generator that fell behind its schedule.

## Machine

- Host: ${machine.host}; ${machine.os}; ${machine.node}.
- Docker: ${machine.docker}.
- Stack: two replicas behind nginx, with PostgreSQL and Redis, from \`compose.yaml\` with its defaults. The client runs on the host and reaches nginx at ${result.baseUrl}, so the latencies include Docker's port forwarding.

## Method

- Setup: ${String(parameters.pairs)} customers, each with a pair of EUR accounts funded with "${parameters.funding}" EUR each through the API, and ${String(parameters.operators)} operators: ${String(result.setup.requests)} setup requests in ${String(result.setup.seconds)} s.
- Load: an open model. ${String(measured.scheduled)} single deposits, withdrawals and transfers of "${parameters.amount}" EUR in equal thirds, each with its own Idempotency-Key, scheduled one every ${String(1000 / parameters.ratePerSecond)} ms for a constant ${String(parameters.ratePerSecond)} requests per second over ${String(parameters.durationSeconds)} s. Each leaves at its moment whether or not earlier ones were answered, over at most ${String(SOCKETS)} connections, and its latency runs from its scheduled moment, so a slow answer, or a wait for a free connection, counts in full. Deposits rotate over the operators; withdrawals and transfers (from one account of a pair to the other) over the customers (SEC-AC05).
- Count: every request still in flight when the schedule ends is drained, so each one ends as an answer, a connection error, or a loss after ${String(REQUEST_TIMEOUT_MS / 1000)} s without an answer.
- Finished at ${result.finishedAt}.

## Results

| Measure | Value |
| --- | ---: |
| p50 latency | ${String(measured.latencyMs.p50)} ms |
| p95 latency | ${String(measured.latencyMs.p95)} ms |
| p99 latency | ${String(measured.latencyMs.p99)} ms |
| Maximum latency | ${String(measured.latencyMs.max)} ms |
| Requests sent | ${String(measured.sent)} of ${String(measured.scheduled)} scheduled, at ${String(measured.sendRatePerSecond)} per second |
| Achieved throughput | ${String(measured.throughputPerSecond)} responses per second |
| Responses | ${String(measured.responses)} (${String(measured.byKind.deposit)} deposits, ${String(measured.byKind.withdrawal)} withdrawals, ${String(measured.byKind.transfer)} transfers) |
| Non-2xx responses | ${String(measured.non2xx)} |
| 5xx responses | ${String(measured.fiveXx)}${fiveXxTypes === '' ? '' : ` (${fiveXxTypes})`} |
| Connection errors | ${String(measured.errors)}${errorCodes === '' ? '' : ` (${errorCodes})`} |
| Lost requests | ${String(measured.lost)} |
| Drain after the last send | ${String(measured.drainSeconds)} s |

- Status codes: ${codes === '' ? 'none' : codes}.
- Target p99 under ${String(parameters.p99TargetMs)} ms: ${target}.
- Generator: ${generator}.
- Reconciliation after the run: ${reconciliation}.
`;
}

async function main(): Promise<number> {
  const baseUrl = (process.env['E2E_BASE_URL'] ?? 'http://localhost:8080').replace(/\/+$/, '');
  // The reconciliation reads the stack's database on 127.0.0.1, so the API must be the same stack.
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)) {
    throw new Error('E2E_BASE_URL must name this machine: localhost, 127.0.0.1 or [::1]');
  }
  const result = await runLoadTest(baseUrl);
  mkdirSync(dirname(RESULT_PATH), { recursive: true });
  writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  // Formatted as the repository formats Markdown, so npm run check passes on the written report.
  const options = (await resolveConfig(REPORT_PATH)) ?? {};
  writeFileSync(
    REPORT_PATH,
    await format(renderReport(result), { ...options, parser: 'markdown' }),
  );
  const { latencyMs, throughputPerSecond, responses, fiveXx, errors, lost, generator } = result.run;
  process.stdout.write(
    `${JSON.stringify({ latencyMs, throughputPerSecond, responses, fiveXx, errors, lost, generator, reconciliation: result.reconciliation.exitCode })}\n`,
  );
  // A missed p99 target never fails the command (SYS-AC17); anything else that is wrong does.
  return result.passed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`load test: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
