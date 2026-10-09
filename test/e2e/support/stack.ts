import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { readCompose, readRepositoryFile, REPOSITORY_ROOT } from '../../support/deployment.js';
import { describeResult, run, runOk, type CommandOptions, type CommandResult } from './command.js';
import { send } from './http.js';
import { E2E_TMP } from './paths.js';
import { REPLICAS, type Replica } from './urls.js';
import { waitFor } from './wait.js';

/**
 * The e2e harness of plan 008 section 5. The suite owns its stack: every `docker compose` command
 * runs with `COMPOSE_PROJECT_NAME=scf-e2e`, which overrides the `name:` of `compose.yaml`, so the
 * suite never touches the containers or volumes of the developer's own stack; and with its own
 * `SCF_SUBNET_PREFIX`, so its network never clashes with theirs. Both stacks publish the same host
 * ports, so the harness refuses to start while another holds them.
 */
export const PROJECT = 'scf-e2e';

/** The first three octets of the e2e stack's network; `E2E_SUBNET_PREFIX` moves it. */
export const SUBNET_PREFIX = process.env['E2E_SUBNET_PREFIX'] ?? '10.211.0';
export const SUBNET = `${SUBNET_PREFIX}.0/24`;
/** The network Compose creates for the project, which the subnet check skips. */
export const NETWORK = `${PROJECT}_scf`;

/** The fixed addresses of `compose.yaml` on the e2e network. */
export const ADDRESSES = {
  nginx: `${SUBNET_PREFIX}.10`,
  'api-1': `${SUBNET_PREFIX}.11`,
  'api-2': `${SUBNET_PREFIX}.12`,
} as const;

/** The services `up` starts and keeps running, each with a healthcheck (table 1.1 of spec 008). */
export const LONG_RUNNING = ['postgres', 'redis', 'api-1', 'api-2', 'nginx'] as const;

/** Every variable `compose.yaml` interpolates, such as `RATE_LIMIT_IP_RPS`. */
function interpolatedVariables(): Set<string> {
  const names = new Set<string>();
  for (const match of readRepositoryFile('compose.yaml').matchAll(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    names.add(match[1] ?? '');
  }
  return names;
}

/**
 * The environment of every Compose command: the suite's own, without any variable `compose.yaml`
 * interpolates or any `COMPOSE_*` setting, so the limits are the defaults the ACs expect whatever
 * the developer's shell or `.env` holds; then the project name and the subnet of the e2e stack.
 */
export function composeEnvironment(): NodeJS.ProcessEnv {
  const dropped = interpolatedVariables();
  const kept = Object.entries(process.env).filter(
    ([name]) => !dropped.has(name) && !name.startsWith('COMPOSE_'),
  );
  return {
    ...Object.fromEntries(kept),
    COMPOSE_PROJECT_NAME: PROJECT,
    SCF_SUBNET_PREFIX: SUBNET_PREFIX,
  };
}

/**
 * An empty env file, given to every Compose command run from the working tree, so Compose never
 * reads the developer's `.env` for interpolation (DEP-R06).
 */
function emptyEnvFile(): string {
  mkdirSync(E2E_TMP, { recursive: true });
  const path = join(E2E_TMP, 'empty.env');
  writeFileSync(path, '');
  return path;
}

export interface ComposeOptions extends CommandOptions {
  /** Compose files, each passed with `-f`; `compose.yaml` alone when not given. */
  files?: readonly string[];
}

/** `docker compose <args>` for the e2e project, from the working tree unless `cwd` says otherwise. */
export async function compose(
  args: readonly string[],
  options: ComposeOptions = {},
): Promise<CommandResult> {
  const files = (options.files ?? []).flatMap((file) => ['-f', file]);
  return await run('docker', ['compose', '--env-file', emptyEnvFile(), ...files, ...args], {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: options.env ?? composeEnvironment(),
    timeoutMs: options.timeoutMs ?? 900_000,
  });
}

/** `compose`, failing with the command's output unless it exits with code 0. */
export async function composeOk(
  args: readonly string[],
  options: ComposeOptions = {},
): Promise<CommandResult> {
  const result = await compose(args, options);
  if (result.code !== 0) throw new Error(describeResult('docker compose', args, result));
  return result;
}

/** Parses JSON printed either as one array or as one object per line, as Compose versions do. */
export function parseJsonLines<T>(text: string): T[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as T[];
  return trimmed.split('\n').map((line) => JSON.parse(line) as T);
}

/** One container as `docker compose ps --all --format json` lists it. */
export interface ServiceState {
  ID: string;
  Name: string;
  Service: string;
  State: string;
  Health: string;
  ExitCode: number;
  Publishers: { URL: string; TargetPort: number; PublishedPort: number; Protocol: string }[] | null;
}

export async function serviceStates(options: ComposeOptions = {}): Promise<ServiceState[]> {
  const result = await composeOk(['ps', '--all', '--format', 'json'], options);
  return parseJsonLines<ServiceState>(result.stdout);
}

/** One entry of a container's health log, as `docker inspect` shows it. */
export interface HealthProbe {
  Start: string;
  End: string;
  ExitCode: number;
  Output: string;
}

/** The part of `docker inspect` the suite reads. */
export interface ContainerInspect {
  Id: string;
  Name: string;
  Config: { Labels: Record<string, string> | null; User: string; Env: string[] | null };
  State: {
    Status: string;
    Running: boolean;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
    Health?: { Status: string; Log: HealthProbe[] | null };
  };
  Mounts: { Type?: string; Name?: string; Source: string; Destination: string }[] | null;
}

export async function inspectContainers(ids: readonly string[]): Promise<ContainerInspect[]> {
  if (ids.length === 0) return [];
  const result = await runOk('docker', ['inspect', ...ids]);
  return JSON.parse(result.stdout) as ContainerInspect[];
}

/** The Compose service a container belongs to. */
export function serviceOf(container: ContainerInspect): string {
  return container.Config.Labels?.['com.docker.compose.service'] ?? '';
}

/** Every container of the e2e project, running or not. */
export async function projectContainers(): Promise<ContainerInspect[]> {
  const result = await runOk('docker', [
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${PROJECT}`,
  ]);
  return await inspectContainers(result.stdout.split('\n').filter((id) => id !== ''));
}

/** The one container of `service`, failing when there is none. */
export async function containerOf(service: string): Promise<ContainerInspect> {
  const result = await composeOk(['ps', '--all', '--quiet', service]);
  const ids = result.stdout.split('\n').filter((id) => id !== '');
  const [container] = await inspectContainers(ids);
  if (container === undefined || ids.length !== 1) {
    throw new Error(`expected one container of ${service}, found ${String(ids.length)}`);
  }
  return container;
}

/** Every host port the long-running services of `compose.yaml` publish. */
export function stackHostPorts(): number[] {
  return readCompose()
    .services.filter((service) => service.profiles.length === 0)
    .flatMap((service) => service.ports)
    .flatMap((port) => (port.hostPort === undefined ? [] : [Number(port.hostPort)]));
}

/** Whether a process already listens on `port` of the loopback. */
async function portTaken(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(true);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve(false);
      });
    });
  });
}

/** The host ports the e2e project's own containers publish. */
async function ownPublishedPorts(): Promise<Set<number>> {
  const result = await runOk('docker', [
    'ps',
    '--filter',
    `label=com.docker.compose.project=${PROJECT}`,
    '--format',
    '{{.Ports}}',
  ]);
  return new Set([...result.stdout.matchAll(/:(\d+)->/g)].map((match) => Number(match[1])));
}

/**
 * Refuses to start while another stack or process holds one of the stack's host ports: the
 * developer's own stack, started with `docker compose up` or `npm run infra:up`, must be stopped
 * first, and the harness never stops it itself.
 */
export async function assertPortsFree(): Promise<void> {
  const ours = await ownPublishedPorts();
  for (const port of stackHostPorts()) {
    if (ours.has(port)) continue;
    const users = await runOk('docker', [
      'ps',
      '--filter',
      `publish=${String(port)}`,
      '--format',
      '{{.Names}}',
    ]);
    const names = users.stdout.split('\n').filter((name) => name !== '');
    if (names.length > 0) {
      throw new Error(
        `port ${String(port)} is published by ${names.join(', ')}. The e2e stack ${PROJECT} uses the same host ports: stop that stack first (docker compose down, which keeps its volumes).`,
      );
    }
    if (await portTaken(port)) {
      throw new Error(`port ${String(port)} of 127.0.0.1 is taken by a process outside Docker.`);
    }
  }
}

/** The first and last address of an IPv4 block, or undefined for any other block. */
export function ipv4Range(cidr: string): [number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
  if (match === null) return undefined;
  const [a, b, c, d, bits] = match.slice(1).map(Number) as [number, number, number, number, number];
  const address = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
  const size = 2 ** (32 - bits);
  const first = Math.floor(address / size) * size;
  return [first, first + size - 1];
}

/** Whether two IPv4 blocks share an address. */
export function overlaps(left: string, right: string): boolean {
  const a = ipv4Range(left);
  const b = ipv4Range(right);
  return a !== undefined && b !== undefined && a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Refuses to start while another Docker network uses an address of the e2e subnet, which Docker
 * would refuse anyway with a less helpful message, or which would route the fixed addresses of
 * nginx and the replicas to the wrong network.
 */
export async function assertSubnetFree(): Promise<void> {
  const listed = await runOk('docker', ['network', 'ls', '--format', '{{.Name}}']);
  const names = listed.stdout.split('\n').filter((name) => name !== '' && name !== NETWORK);
  if (names.length === 0) return;
  const inspected = JSON.parse(
    (await runOk('docker', ['network', 'inspect', ...names])).stdout,
  ) as {
    Name: string;
    IPAM: { Config: { Subnet?: string }[] | null };
  }[];
  for (const network of inspected) {
    for (const config of network.IPAM.Config ?? []) {
      if (config.Subnet !== undefined && overlaps(config.Subnet, SUBNET)) {
        throw new Error(
          `the Docker network ${network.Name} uses ${config.Subnet}, which overlaps the e2e subnet ${SUBNET}: remove it, or set E2E_SUBNET_PREFIX.`,
        );
      }
    }
  }
}

export async function assertStackCanStart(): Promise<void> {
  await assertPortsFree();
  await assertSubnetFree();
}

/**
 * Stops and removes the e2e stack with its volumes, the tools service included; `images` also
 * removes the images Compose built for it.
 */
export async function downStack(
  options: ComposeOptions & { images?: boolean } = {},
): Promise<void> {
  const images = options.images === true ? ['--rmi', 'local'] : [];
  await composeOk(
    ['--profile', 'tools', 'down', '--volumes', '--remove-orphans', ...images],
    options,
  );
}

/**
 * Builds the stack from the working tree and starts it with `up --build --wait`, after the checks
 * of plan 008 section 5; `fresh` removes it and its volumes first. Also builds the tools image,
 * which `up` does not build, so the tools commands run the same sources as the stack.
 */
export async function startStack({ fresh = false }: { fresh?: boolean } = {}): Promise<void> {
  if (fresh) await downStack();
  await assertStackCanStart();
  await composeOk(['up', '--build', '--wait']);
  await composeOk(['build', '--quiet', 'tools']);
}

/** Whether the stack runs healthy from the working tree, not from DEP-AC01's clone. */
export async function stackIsUp(): Promise<boolean> {
  const states = await serviceStates();
  const healthy = LONG_RUNNING.every((service) =>
    states.some(
      (state) =>
        state.Service === service && state.State === 'running' && state.Health === 'healthy',
    ),
  );
  if (!healthy) return false;
  const nginx = await containerOf('nginx');
  return (nginx.Mounts ?? []).every((mount) =>
    mount.Source.startsWith(join(REPOSITORY_ROOT, 'docker')),
  );
}

/** Starts the stack unless it already runs healthy from the working tree. */
export async function ensureStack(): Promise<void> {
  if (await stackIsUp()) return;
  await startStack();
}

export async function stopServices(services: readonly string[]): Promise<CommandResult> {
  return await composeOk(['stop', ...services]);
}

export async function startServices(services: readonly string[]): Promise<CommandResult> {
  return await composeOk(['start', ...services]);
}

/** Waits until every container of `services` reports `healthy`. */
export async function waitHealthy(services: readonly string[]): Promise<void> {
  await waitFor(`${services.join(', ')} to be healthy`, async () => {
    const containers = await Promise.all(
      services.map(async (service) => await containerOf(service)),
    );
    return containers.every((container) => container.State.Health?.Status === 'healthy')
      ? true
      : undefined;
  });
}

/** Waits until the container of `service` has exited, and returns its state. */
export async function waitExited(service: string): Promise<ContainerInspect> {
  return await waitFor(`${service} to exit`, async () => {
    const container = await containerOf(service);
    return container.State.Status === 'exited' ? container : undefined;
  });
}

/** The current time of the Docker daemon, the clock of its log timestamps, for `--since`. */
export async function daemonTime(): Promise<string> {
  const result = await runOk('docker', ['system', 'info', '--format', '{{.SystemTime}}']);
  return result.stdout.trim();
}

/**
 * Every line a service's container wrote, on standard output and error in the order written, since
 * `since` if given. Docker's timestamps, fixed-width, merge the two streams; they are removed.
 */
export async function containerLogs(service: string, since?: string): Promise<string[]> {
  const container = await containerOf(service);
  const result = await runOk('docker', [
    'logs',
    '--timestamps',
    ...(since === undefined ? [] : ['--since', since]),
    container.Id,
  ]);
  const lines = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const space = line.indexOf(' ');
      return { at: line.slice(0, space), text: line.slice(space + 1) };
    });
  lines.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
  return lines.map((line) => line.text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The lines of a JSON log that parse as objects; the others are left out. */
export function jsonLines(lines: readonly string[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(value)) records.push(value);
  }
  return records;
}

/**
 * Waits until nginx passes requests to both replicas again, seen in their logs: after a restart
 * nginx skips a replica that failed for its `fail_timeout`, 10 s by default.
 */
export async function waitForBothReplicasThroughNginx(): Promise<void> {
  const since = await daemonTime();
  const prefix = `probe-${randomUUID()}`;
  let sent = 0;
  await waitFor('both replicas to serve requests through nginx', async () => {
    sent += 1;
    await send({
      url: '/health/live',
      headers: { 'x-request-id': `${prefix}-${String(sent)}` },
      timeoutMs: 10_000,
    });
    const served = await Promise.all(
      REPLICAS.map(async (replica) =>
        (await containerLogs(replica, since)).some((line) => line.includes(prefix)),
      ),
    );
    return served.every(Boolean) ? true : undefined;
  });
}

/**
 * Starts the replicas a test stopped or killed, waits until both are healthy and nginx routes to
 * both again, so the next test finds the stack as it was (plan 008 section 5).
 */
export async function restoreReplicas(): Promise<void> {
  const states = await serviceStates();
  const down = REPLICAS.filter(
    (replica) => !states.some((state) => state.Service === replica && state.State === 'running'),
  );
  if (down.length > 0) await startServices(down);
  await waitHealthy(REPLICAS);
  await waitForBothReplicasThroughNginx();
}

/** `docker compose run --rm tools <args>`: an npm script in the tools service (DEP-R09). */
export async function runTools(args: readonly string[]): Promise<CommandResult> {
  return await compose(['run', '--rm', 'tools', ...args]);
}

export async function runToolsOk(args: readonly string[]): Promise<CommandResult> {
  const result = await runTools(args);
  if (result.code !== 0)
    throw new Error(describeResult('docker compose run --rm tools', args, result));
  return result;
}

/** What `npm run seed` prints (DEP-R10). */
export interface SeedOutput {
  users: {
    name: string;
    id: string;
    role: string;
    accounts: { id: string; currency: string; balance: string }[];
  }[];
}

/**
 * The JSON document of the seed's standard output: from its first line that opens an object, since
 * `npm run` without `--silent` prints its own header lines first.
 */
export function parseSeedOutput(stdout: string): SeedOutput {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.startsWith('{'));
  if (start === -1) throw new Error(`no JSON in the seed's output:\n${stdout}`);
  return JSON.parse(lines.slice(start).join('\n')) as SeedOutput;
}

/** Runs the seed, which changes nothing once it has run, and returns what it prints. */
export async function seedStack(): Promise<SeedOutput> {
  return parseSeedOutput((await runToolsOk(['npm', 'run', '--silent', 'seed'])).stdout);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tokens minted in the tools service with `npm run --silent token`, as the ACs of spec 008 mint
 * them: one container runs the script once per user, which is far faster than a container each.
 * A failure never prints a token.
 */
export async function toolsTokens(
  users: readonly { sub: string; role: 'customer' | 'operator' }[],
): Promise<string[]> {
  for (const user of users) {
    if (!UUID.test(user.sub)) throw new Error(`not a UUID: ${user.sub}`);
  }
  const script = users
    .map((user) => `npm run --silent token -- --sub ${user.sub} --role ${user.role}`)
    .join(' && ');
  // Standard output holds the tokens, so no failure ever prints it: only its line count and
  // standard error, where the token script writes no token (AUT-R19).
  const result = await runTools(['sh', '-c', script]);
  const tokens = result.stdout.split('\n').filter((line) => line !== '');
  if (result.code !== 0 || tokens.length !== users.length) {
    throw new Error(
      `minting ${String(users.length)} tokens exited with ${String(result.code)} after ${String(tokens.length)} lines on stdout (not shown); stderr:\n${result.stderr.slice(-4000)}`,
    );
  }
  return tokens;
}

/** The report `npm run reconcile` prints (section 1.5 of spec 002). */
export interface ReconciliationReport {
  discrepancies: unknown[];
  totals: { currency: string; sum: string }[];
}

/** The reconciliation of LED-R21, run in the tools service, as the ACs of spec 008 run it. */
export async function reconcileInTools(): Promise<{
  code: number;
  report: ReconciliationReport | undefined;
  output: string;
}> {
  const result = await runTools(['npm', 'run', '--silent', 'reconcile']);
  const line = result.stdout.split('\n').find((item) => item.startsWith('{'));
  return {
    code: result.code,
    report: line === undefined ? undefined : (JSON.parse(line) as ReconciliationReport),
    output: `${result.stdout}${result.stderr}`,
  };
}

export type { Replica };
