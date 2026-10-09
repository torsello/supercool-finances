import type { FastifyRequest, FastifyServerOptions } from 'fastify';
import type { LogLevel } from '../config/config.js';

/** Where log lines go: standard output by default, a capture in tests (plan 000 section 9). */
export interface LogDestination {
  write(line: string): void;
}

/** What replaces a redacted value, where the field is kept (SEC-R22). */
export const REDACTED = '[Redacted]';

/** The request headers whose values never reach a log: credentials and keys (SEC-R22). */
const REDACTED_HEADERS = ['authorization', 'cookie', 'idempotency-key'] as const;

/**
 * The request as logged: its method, its path without the query string, which may carry a token
 * (`access_token`) or any other value that must never reach a log (SEC-R46, AUT-R19), the client
 * address of SEC-R18 and the headers, of which `REDACTED_HEADERS` are redacted.
 */
function requestSerializer(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url.split('?')[0] ?? '',
    remoteAddress: request.ip,
    headers: { ...request.headers },
  };
}

/**
 * The forms a secret can take inside a JSON string value of a log line: as it is and
 * percent-encoded as in a URL, each written with the escapes of a JSON string.
 */
function formsOf(secret: string): string[] {
  return [secret, encodeURIComponent(secret)].map((form) => JSON.stringify(form).slice(1, -1));
}

/** The password of a URL, as written in it and decoded; none when it has none or is not a URL. */
function urlPasswords(value: string): string[] {
  try {
    const { password } = new URL(value);
    return password === '' ? [] : [password, decodeURIComponent(password)];
  } catch {
    return [];
  }
}

/** The secret values of the configuration, which no log line may hold (SEC-R22). */
export interface LogSecrets {
  jwtSecret: string;
  cursorSecret: string;
  databaseUrl: string;
  redisUrl: string;
}

/** A JSON string token, and the colon that makes it a key. */
const STRING_TOKEN = /"(?:[^"\\]|\\.)*"(\s*:)?/g;

/**
 * Replaces in a log line every form of `JWT_SECRET`, `CURSOR_SECRET` and the passwords of
 * `DATABASE_URL` and `REDIS_URL` with `[Redacted]`, wherever a string value holds them, such as an
 * error a driver built from its connection settings (SEC-R22). Keys and numbers are never touched,
 * so the line stays valid JSON even for a password such as "30" (SEC-R21). Longer values first,
 * so a secret that contains another is replaced whole.
 */
export function secretScrubber(secrets: LogSecrets): (line: string) => string {
  const values = [
    secrets.jwtSecret,
    secrets.cursorSecret,
    ...urlPasswords(secrets.databaseUrl),
    ...urlPasswords(secrets.redisUrl),
  ]
    .filter((value) => value !== '')
    .flatMap(formsOf);
  const unique = [...new Set(values)].sort((a, b) => b.length - a.length);
  if (unique.length === 0) return (line) => line;
  return (line) =>
    line.replace(STRING_TOKEN, (token, colon: string | undefined) =>
      colon === undefined
        ? unique.reduce((text, value) => text.replaceAll(value, REDACTED), token)
        : token,
    );
}

/** Standard output, written to as given. */
const STDOUT: LogDestination = {
  write(line) {
    process.stdout.write(line);
  },
};

export interface LoggerSettings {
  level: LogLevel;
  secrets: LogSecrets;
  /** Standard output when not given. */
  destination?: LogDestination;
}

/**
 * Fastify's pino logger: one JSON object per line with `level`, `time` and `msg`, and `reqId` on
 * every line written while handling a request (SEC-R21, SYS-R22). The `authorization`, `cookie`
 * and `idempotency-key` headers of the request line are `[Redacted]`, and every line goes through
 * the secret scrubber on its way to the destination (SEC-R22).
 */
export function loggerOptions(
  settings: LoggerSettings,
): NonNullable<FastifyServerOptions['logger']> {
  const destination = settings.destination ?? STDOUT;
  const scrub = secretScrubber(settings.secrets);
  return {
    level: settings.level,
    stream: {
      write(line: string) {
        destination.write(scrub(line));
      },
    },
    serializers: { req: requestSerializer },
    redact: {
      paths: REDACTED_HEADERS.map((name) => `req.headers["${name}"]`),
      censor: REDACTED,
    },
  };
}

/** pino's level of a line that ends the process. */
const FATAL = 60;

/**
 * Writes why the service could not start as one JSON log line, before any logger exists: the
 * error's name and message, which never hold a value (SEC-R40), and, for a configuration error,
 * every invalid variable with its rule. Any other error is written by name only, since its message
 * may hold a value the configuration did not validate.
 */
export function writeStartupFailure(error: unknown, destination: LogDestination = STDOUT): void {
  const problems =
    typeof error === 'object' && error !== null && 'problems' in error ? error.problems : undefined;
  const line = {
    level: FATAL,
    time: Date.now(),
    msg: problems === undefined ? 'startup failed' : 'invalid configuration',
    ...(problems === undefined
      ? { err: { type: error instanceof Error ? error.name : typeof error } }
      : { error: error instanceof Error ? error.message : 'invalid configuration', problems }),
  };
  destination.write(`${JSON.stringify(line)}\n`);
}
