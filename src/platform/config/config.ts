/**
 * The service's configuration, read from environment variables once and validated before anything
 * connects or listens (plan 000 section 4, SEC-R39). Every invalid variable is collected into one
 * `ConfigError` that names it with its rule and never its value (SEC-R40, AUT-R18). 09-hardening
 * adds the rest of section 1.2 of spec 007 and the timeout budget of SEC-R35.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** `JWT_SECRET`, `JWT_ISSUER` and `JWT_AUDIENCE` (section 1.4 of spec 006). */
export interface JwtConfig {
  /** Used as given, as UTF-8 bytes; never decoded from base64. */
  secret: string;
  issuer: string;
  audience: string;
}

export interface Config {
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  /** The HMAC key of pagination cursors (section 1.5 of spec 001). */
  cursorSecret: string;
  /** The largest amount of one deposit, withdrawal or transfer, in minor units (LED-R23). */
  maxAmountMinor: bigint;
  accountLockTimeoutMs: number;
  idempotencyWaitTimeoutMs: number;
  idempotencyKeyTtlSeconds: number;
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

  /** A variable that must not be set at all, whatever its value. */
  unset(variable: string, rule: string): void {
    if (this.#env[variable] !== undefined) this.#fail(variable, rule);
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

function isPostgresUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // pg turns every query parameter into a connection setting, and sends some, such as `options`
  // or `statement_timeout`, as startup parameters that would override the role's timeouts
  // (SEC-R29), so only these are accepted (section 1.2 of spec 007).
  return (
    (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
    [...url.searchParams.keys()].every((name) => DATABASE_URL_PARAMETERS.has(name))
  );
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
  const config: Config = {
    port: reader.integer('PORT', 1, 65535, 3000),
    logLevel: reader.oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
    databaseUrl: reader.required(
      'DATABASE_URL',
      'a postgres:// or postgresql:// URL whose only query parameters are sslmode, sslrootcert, application_name and connect_timeout',
      isPostgresUrl,
    ),
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
    jwt,
  };
  // pg reads PGOPTIONS when the URL has no `options`, and sends it as the connection's options.
  reader.unset('PGOPTIONS', "unset, because pg would send it as the connection's options");
  reader.finish();
  return config;
}
