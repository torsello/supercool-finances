import { isIPv4, isIPv6 } from 'node:net';
import { parseSentryDsn, SENTRY_DSN_RULE } from '../error-reporting/dsn.js';

/**
 * The service's configuration, read from environment variables once and validated before anything
 * connects or listens (plan 000 section 4, SEC-R39): every variable of section 1.2 of spec 007, of
 * specs 002, 003, 005 and 006, `SENTRY_DSN`, `REPLICA_ID` and `MIGRATION_DATABASE_URL` (spec 008), the
 * timeout budget of SEC-R35, and the demo secrets refused in production (DEP-R07). Every invalid
 * variable is collected into one `ConfigError` that names it with its rule and never its value
 * (SEC-R40, AUT-R18).
 */

export type Environment = Readonly<Record<string, string | undefined>>;

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/** `JWT_SECRET`, `JWT_ISSUER` and `JWT_AUDIENCE` (section 1.4 of spec 006). */
export interface JwtConfig {
  /** Used as given, as UTF-8 bytes; never decoded from base64. */
  secret: string;
  issuer: string;
  audience: string;
}

export interface Config {
  nodeEnv: NodeEnv;
  port: number;
  /** The port of the metrics server, never routed by the load balancer (SEC-R43). */
  metricsPort: number;
  logLevel: LogLevel;
  databaseUrl: string;
  /** Used for nothing but the per-user rate-limit counters (SEC-R07). */
  redisUrl: string;
  /** The HMAC key of pagination cursors (section 1.5 of spec 001). */
  cursorSecret: string;
  /** The largest amount of one deposit, withdrawal or transfer, in minor units (LED-R23). */
  maxAmountMinor: bigint;
  accountLockTimeoutMs: number;
  idempotencyWaitTimeoutMs: number;
  idempotencyKeyTtlSeconds: number;
  dbPoolMax: number;
  dbPoolAcquireTimeoutMs: number;
  redisCommandTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownDrainDelayMs: number;
  shutdownTimeoutMs: number;
  rateLimitUserMax: number;
  rateLimitUserWindowSeconds: number;
  /** The CIDR blocks of the proxies whose `X-Forwarded-For` is trusted (SEC-R18). */
  trustedProxyCidrs: readonly string[];
  /** The exact origins CORS allows; empty turns CORS off (SEC-R16, SEC-R17). */
  corsOrigins: readonly string[];
  /** The replica's name in its log lines (DEP-R14); the host name is used when unset. */
  replicaId: string | undefined;
  /** The owner role's URL, read only by the migrations, validated where it is set (spec 008). */
  migrationDatabaseUrl: string | undefined;
  /**
   * `PGPASSWORD`, which `pg` itself reads for a database URL that holds no password, as the tasks
   * in AWS receive it (section 1.7 of spec 008); read here only so the logs never hold it (SEC-R22).
   */
  databasePassword: string | undefined;
  /**
   * The DSN of the Sentry-compatible endpoint that receives the 500s; `undefined`, when unset or
   * empty, turns error reporting off (section 1.10 of spec 007, SEC-R51). Never logged (SEC-R22).
   */
  sentryDsn: string | undefined;
  jwt: JwtConfig;
}

export interface ConfigProblem {
  variable: string;
  rule: string;
}

/** One error for every invalid variable, each named with its rule, never with its value. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(readonly problems: readonly ConfigProblem[]) {
    super(
      `Invalid configuration: ${problems.map(({ variable, rule }) => `${variable} must be ${rule}`).join('; ')}`,
    );
  }
}

const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

/**
 * The shared integer rule (plan 000 section 4): a string of decimal digits without sign, leading
 * zero, separator, exponent or spaces. Anything else is `undefined`; the range is the caller's.
 */
export function parseDecimalInteger(value: string): bigint | undefined {
  return DECIMAL_INTEGER.test(value) ? BigInt(value) : undefined;
}

/** The fewest UTF-8 bytes of an HMAC-SHA256 key: its output size (RFC 7518 section 3.2). */
const MIN_SECRET_BYTES = 32;

function integerRule(min: bigint, max: bigint): string {
  return `a string of decimal digits without sign or leading zero, from ${String(min)} to ${String(max)}`;
}

/** Reads variables and records each invalid one; `finish` throws them all at once. */
class Reader {
  readonly #env: Environment;
  readonly #problems: ConfigProblem[] = [];

  constructor(env: Environment) {
    this.#env = env;
  }

  #fail(variable: string, rule: string): void {
    this.#problems.push({ variable, rule });
  }

  /** An integer in [min, max]; `fallback` when unset. An empty string is invalid, not unset. */
  bigint(variable: string, min: bigint, max: bigint, fallback: bigint): bigint {
    const value = this.#env[variable];
    if (value === undefined) return fallback;
    const parsed = parseDecimalInteger(value);
    if (parsed === undefined || parsed < min || parsed > max) {
      this.#fail(variable, integerRule(min, max));
      return fallback;
    }
    return parsed;
  }

  /** An integer small enough for a JavaScript number, such as a port or a timeout. */
  integer(variable: string, min: number, max: number, fallback: number): number {
    return Number(this.bigint(variable, BigInt(min), BigInt(max), BigInt(fallback)));
  }

  /** A required value, not empty, for which `valid` holds. */
  required(variable: string, rule: string, valid: (value: string) => boolean = () => true): string {
    const value = this.#env[variable];
    if (value === undefined || value === '' || !valid(value)) {
      this.#fail(variable, rule);
      return '';
    }
    return value;
  }

  oneOf<T extends string>(variable: string, values: readonly T[], fallback: T): T {
    const value = this.#env[variable];
    if (value === undefined) return fallback;
    const found = values.find((candidate) => candidate === value);
    if (found === undefined) this.#fail(variable, `one of ${values.join(', ')}`);
    return found ?? fallback;
  }

  /** A value that may be unset; when set, `valid` must hold, an empty string included. */
  optional(variable: string, rule: string, valid: (value: string) => boolean): string | undefined {
    const value = this.#env[variable];
    if (value === undefined) return undefined;
    if (!valid(value)) {
      this.#fail(variable, rule);
      return undefined;
    }
    return value;
  }

  /**
   * A comma-separated list, empty when unset or empty; each item, without the spaces around it,
   * must satisfy `valid`.
   */
  list(variable: string, rule: string, valid: (item: string) => boolean): string[] {
    const value = this.#env[variable];
    if (value === undefined || value === '') return [];
    const items = value.split(',').map((item) => item.trim());
    if (!items.every(valid)) {
      this.#fail(variable, rule);
      return [];
    }
    return items;
  }

  /** A variable that must not be set at all, whatever its value. */
  unset(variable: string, rule: string): void {
    if (this.#env[variable] !== undefined) this.#fail(variable, rule);
  }

  /** Records a rule across variables, such as the budget of SEC-R35, under `variable`. */
  refuse(variable: string, rule: string): void {
    this.#fail(variable, rule);
  }

  /** Whether any of `variables` was found invalid. */
  anyInvalid(variables: readonly string[]): boolean {
    return this.#problems.some((problem) => variables.includes(problem.variable));
  }

  finish(): void {
    if (this.#problems.length > 0) throw new ConfigError(this.#problems);
  }
}

function isLongSecret(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') >= MIN_SECRET_BYTES;
}

const DATABASE_URL_PARAMETERS: ReadonlySet<string> = new Set([
  'sslmode',
  'sslrootcert',
  'application_name',
  'connect_timeout',
]);

function urlOf(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isPostgresProtocol(url: URL): boolean {
  return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
}

function isPostgresUrl(value: string): boolean {
  const url = urlOf(value);
  // pg turns every query parameter into a connection setting, and sends some, such as `options`
  // or `statement_timeout`, as startup parameters that would override the role's timeouts
  // (SEC-R29), so only these are accepted (section 1.2 of spec 007).
  return (
    url !== undefined &&
    isPostgresProtocol(url) &&
    [...url.searchParams.keys()].every((name) => DATABASE_URL_PARAMETERS.has(name))
  );
}

function isRedisUrl(value: string): boolean {
  const url = urlOf(value);
  return url !== undefined && (url.protocol === 'redis:' || url.protocol === 'rediss:');
}

const CIDR = /^([^/]+)\/(0|[1-9][0-9]{0,2})$/;

/** An IPv4 block with a prefix of 0 to 32, or an IPv6 block with a prefix of 0 to 128. */
export function isCidr(value: string): boolean {
  const match = CIDR.exec(value);
  const address = match?.[1];
  const prefix = match?.[2];
  if (address === undefined || prefix === undefined) return false;
  if (isIPv4(address)) return Number(prefix) <= 32;
  return isIPv6(address) && Number(prefix) <= 128;
}

/**
 * An origin as a browser sends it in `Origin`: a scheme, a lowercase host and an optional port,
 * with no path, credentials or trailing slash, so it can be compared exactly (SEC-R17). `http:`
 * only outside production.
 */
function isOrigin(value: string, nodeEnv: NodeEnv): boolean {
  const url = urlOf(value);
  if (url === undefined || url.origin !== value) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && nodeEnv !== 'production');
}

const REPLICA_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** A valid `REPLICA_ID`: 1 to 64 characters of `A-Z a-z 0-9 . _ -` (DEP-R14, SEC-R39). */
export function isReplicaId(value: string): boolean {
  return REPLICA_ID.test(value);
}

/**
 * The demo `JWT_SECRET` and `CURSOR_SECRET` committed in `compose.yaml`: visibly fake 48-byte
 * values that gitleaks does not flag (DEP-R35), refused when `NODE_ENV` is `production` (DEP-R07).
 */
export const DEMO_SECRETS = {
  JWT_SECRET: 'demo-only-jwt-secret-for-docker-compose-00000000',
  CURSOR_SECRET: 'demo-only-cursor-secret-for-docker-compose-00000',
} as const;

/**
 * Refuses, in production, `JWT_SECRET` or `CURSOR_SECRET` equal to any of the demo values, its own
 * or the other's, naming the variable and never its value (DEP-R07).
 */
function refuseDemoSecrets(reader: Reader, env: Environment, nodeEnv: NodeEnv): void {
  if (nodeEnv !== 'production') return;
  const demos: readonly string[] = Object.values(DEMO_SECRETS);
  for (const variable of Object.keys(DEMO_SECRETS)) {
    const value = env[variable];
    if (value !== undefined && demos.includes(value)) {
      reader.refuse(variable, 'not a demo value of compose.yaml when NODE_ENV is production');
    }
  }
}

/** The variables of the request-timeout budget of SEC-R35, the request timeout first. */
const BUDGET_VARIABLES = [
  'REQUEST_TIMEOUT_MS',
  'DB_POOL_ACQUIRE_TIMEOUT_MS',
  'REDIS_COMMAND_TIMEOUT_MS',
  'IDEMPOTENCY_WAIT_TIMEOUT_MS',
  'ACCOUNT_LOCK_TIMEOUT_MS',
] as const;

/** Attempts of a money movement in the budget (SYS-R18), and the sum of the two backoff bounds. */
const BUDGET_ATTEMPTS = 3;
const BUDGET_BACKOFF_MS = 30;

/**
 * The worst case of section 1.1 of spec 007 that the request timeout must exceed: the pool wait,
 * one Redis command, and three attempts each waiting for the key and two account locks, plus the
 * backoff between them (SEC-R35).
 */
export function timeoutBudgetMs(config: {
  dbPoolAcquireTimeoutMs: number;
  redisCommandTimeoutMs: number;
  idempotencyWaitTimeoutMs: number;
  accountLockTimeoutMs: number;
}): number {
  return (
    config.dbPoolAcquireTimeoutMs +
    config.redisCommandTimeoutMs +
    BUDGET_ATTEMPTS * (config.idempotencyWaitTimeoutMs + 2 * config.accountLockTimeoutMs) +
    BUDGET_BACKOFF_MS
  );
}

/**
 * The budgets of SEC-R35, each checked once the variables it compares are valid on their own, so
 * one error lists every rule broken. The rules name every variable involved and no value, the sum
 * included (SEC-R40).
 */
function checkBudget(reader: Reader, config: Config): void {
  // Taken before the request budget is checked, whose refusal names REQUEST_TIMEOUT_MS too.
  const shutdownComparable = !reader.anyInvalid(['REQUEST_TIMEOUT_MS', 'SHUTDOWN_TIMEOUT_MS']);
  if (!reader.anyInvalid(BUDGET_VARIABLES) && config.requestTimeoutMs <= timeoutBudgetMs(config)) {
    reader.refuse(
      'REQUEST_TIMEOUT_MS',
      'greater than DB_POOL_ACQUIRE_TIMEOUT_MS + REDIS_COMMAND_TIMEOUT_MS + 3 × (IDEMPOTENCY_WAIT_TIMEOUT_MS + 2 × ACCOUNT_LOCK_TIMEOUT_MS) + 30',
    );
  }
  if (shutdownComparable && config.shutdownTimeoutMs < config.requestTimeoutMs) {
    reader.refuse('SHUTDOWN_TIMEOUT_MS', 'not less than REQUEST_TIMEOUT_MS');
  }
}

function readJwt(reader: Reader): JwtConfig {
  return {
    secret: reader.required(
      'JWT_SECRET',
      `at least ${String(MIN_SECRET_BYTES)} bytes in UTF-8`,
      isLongSecret,
    ),
    issuer: reader.required('JWT_ISSUER', 'set and not empty'),
    audience: reader.required('JWT_AUDIENCE', 'set and not empty'),
  };
}

/**
 * Only the token settings, for the token script, which needs no database or cursor setting
 * (plan 006 section 4).
 */
export function loadAuthConfig(env: Environment): JwtConfig {
  const reader = new Reader(env);
  const jwt = readJwt(reader);
  reader.finish();
  return jwt;
}

export function loadConfig(env: Environment): Config {
  const reader = new Reader(env);
  const jwt = readJwt(reader);
  const nodeEnv = reader.oneOf('NODE_ENV', NODE_ENVS, 'development');
  const port = reader.integer('PORT', 1, 65535, 3000);
  const metricsPort = reader.integer('METRICS_PORT', 1, 65535, 9464);
  // Compared once both are valid, the default of METRICS_PORT included, so a clash is refused
  // before anything listens (SEC-R40).
  if (!reader.anyInvalid(['PORT', 'METRICS_PORT']) && metricsPort === port) {
    reader.refuse('METRICS_PORT', `${integerRule(1n, 65535n)}, different from PORT`);
  }
  const config: Config = {
    nodeEnv,
    port,
    metricsPort,
    logLevel: reader.oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
    databaseUrl: reader.required(
      'DATABASE_URL',
      'a postgres:// or postgresql:// URL whose only query parameters are sslmode, sslrootcert, application_name and connect_timeout',
      isPostgresUrl,
    ),
    redisUrl: reader.required('REDIS_URL', 'a redis:// or rediss:// URL', isRedisUrl),
    cursorSecret: reader.required(
      'CURSOR_SECRET',
      `at least ${String(MIN_SECRET_BYTES)} bytes in UTF-8 and different from JWT_SECRET`,
      (value) => isLongSecret(value) && value !== env['JWT_SECRET'],
    ),
    maxAmountMinor: reader.bigint('MAX_AMOUNT_MINOR', 1n, 9223372036854775807n, 100000000000n),
    // Below the runtime role's statement_timeout of 5 s, so a lock wait ends as 55P03 (MOV-R31).
    accountLockTimeoutMs: reader.integer('ACCOUNT_LOCK_TIMEOUT_MS', 1, 4999, 2000),
    idempotencyWaitTimeoutMs: reader.integer('IDEMPOTENCY_WAIT_TIMEOUT_MS', 1, 4999, 2000),
    idempotencyKeyTtlSeconds: reader.integer('IDEMPOTENCY_KEY_TTL_SECONDS', 3600, 2592000, 86400),
    dbPoolMax: reader.integer('DB_POOL_MAX', 1, 100, 10),
    dbPoolAcquireTimeoutMs: reader.integer('DB_POOL_ACQUIRE_TIMEOUT_MS', 1, 60000, 2000),
    redisCommandTimeoutMs: reader.integer('REDIS_COMMAND_TIMEOUT_MS', 1, 5000, 100),
    requestTimeoutMs: reader.integer('REQUEST_TIMEOUT_MS', 1, 120000, 25000),
    shutdownDrainDelayMs: reader.integer('SHUTDOWN_DRAIN_DELAY_MS', 0, 60000, 2000),
    shutdownTimeoutMs: reader.integer('SHUTDOWN_TIMEOUT_MS', 1, 120000, 30000),
    rateLimitUserMax: reader.integer('RATE_LIMIT_USER_MAX', 1, 1000000, 300),
    rateLimitUserWindowSeconds: reader.integer('RATE_LIMIT_USER_WINDOW_S', 1, 3600, 10),
    trustedProxyCidrs: reader.list(
      'TRUSTED_PROXY_CIDRS',
      'comma-separated IPv4 or IPv6 CIDR blocks, or empty',
      isCidr,
    ),
    corsOrigins: reader.list(
      'CORS_ORIGINS',
      'comma-separated origins (scheme, lowercase host and optional port, no path), https:// or http:// only when NODE_ENV is not production, or empty; never *',
      (item) => isOrigin(item, nodeEnv),
    ),
    replicaId: reader.optional(
      'REPLICA_ID',
      '1 to 64 characters of A-Z a-z 0-9 . _ -',
      isReplicaId,
    ),
    migrationDatabaseUrl: reader.optional(
      'MIGRATION_DATABASE_URL',
      'a postgres:// or postgresql:// URL',
      (value) => {
        const url = urlOf(value);
        return url !== undefined && isPostgresProtocol(url);
      },
    ),
    databasePassword: reader.optional(
      'PGPASSWORD',
      'unset, or a non-empty value',
      (value) => value !== '',
    ),
    // Empty is off, like unset, so an empty line of .env turns nothing on (SEC-R51).
    sentryDsn:
      env['SENTRY_DSN'] === ''
        ? undefined
        : reader.optional(
            'SENTRY_DSN',
            SENTRY_DSN_RULE,
            (value) => parseSentryDsn(value) !== undefined,
          ),
    jwt,
  };
  // pg reads PGOPTIONS when the URL has no `options`, and sends it as the connection's options.
  reader.unset('PGOPTIONS', "unset, because pg would send it as the connection's options");
  refuseDemoSecrets(reader, env, nodeEnv);
  checkBudget(reader, config);
  reader.finish();
  return config;
}
