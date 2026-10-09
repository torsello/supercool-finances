import { fileURLToPath } from 'node:url';
import { sqlstateOf } from '../db/sqlstate.js';
import { REDACTED } from '../logging/logger.js';
import { routeOf, type RoutedRequest } from '../metrics/metrics.js';

/**
 * The event of an error report, built from the allowlist of section 1.10 of spec 007, never by
 * removing fields from a richer one: nothing of the request but its method, its route template and
 * its correlation id, and nothing of the error but its name, its scrubbed message, its SQLSTATE
 * and its stack frames (SEC-R50, SEC-R53).
 */
export interface ReportEvent {
  event_id: string;
  /** Seconds since the epoch. */
  timestamp: number;
  platform: 'node';
  level: 'error';
  environment: string;
  release: string;
  tags: EventTags;
  exception: { values: [ExceptionValue] };
}

/** The top-level members of an event, which SEC-AC43 checks are exactly these. */
export const EVENT_MEMBERS = [
  'event_id',
  'timestamp',
  'platform',
  'level',
  'environment',
  'release',
  'tags',
  'exception',
] as const satisfies readonly (keyof ReportEvent)[];

export interface EventTags {
  requestId: string;
  route: string;
  method: string;
  replicaId: string;
  sqlstate?: string;
}

export interface ExceptionValue {
  type: string;
  value: string;
  stacktrace: { frames: StackFrame[] };
}

/** A frame without its source line or variables. */
export interface StackFrame {
  function: string;
  filename: string;
  lineno: number;
  colno: number;
}

/**
 * The part of a request a report reads: the correlation id, the method and the route, and the
 * headers only to scrub the request's own token and key from the message. A Fastify request is one.
 */
export interface ReportedRequest extends RoutedRequest {
  readonly id: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface EventSettings {
  /** `NODE_ENV`. */
  environment: string;
  /** The `version` of `package.json`. */
  release: string;
  /** `REPLICA_ID`, or the host name when it is unset (DEP-R14). */
  replicaId: string;
  /** The secret values of the configuration, replaced with `[Redacted]` in the message. */
  secrets: readonly string[];
  /** The application's folder, which frame paths are made relative to. */
  appRoot: string;
  eventId: string;
  timestamp: number;
}

const JWT_SHAPED = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const DIGITS = /[0-9]+/g;

function headerValue(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** The request's own bearer token and `Idempotency-Key`, whole and as the token alone. */
function requestValues(request: ReportedRequest): string[] {
  const authorization = headerValue(request.headers['authorization']);
  return [
    ...authorization,
    ...authorization.map((value) => value.replace(/^Bearer\s+/i, '')),
    ...headerValue(request.headers['idempotency-key']),
  ];
}

/**
 * The message as section 1.10 of spec 007 orders its scrub: each secret and the request's own
 * token and key become `[Redacted]`, longer values first so one that contains another is replaced
 * whole; then each JWT-shaped token becomes `<token>`, each UUID `<uuid>` and each run of digits
 * `<n>`, so no amount, id, token or secret is sent (SEC-R53).
 */
export function scrubMessage(message: string, values: readonly string[]): string {
  const exact = [...new Set(values.filter((value) => value !== ''))].sort(
    (a, b) => b.length - a.length,
  );
  return exact
    .reduce((text, value) => text.replaceAll(value, REDACTED), message)
    .replace(JWT_SHAPED, '<token>')
    .replace(UUID, '<uuid>')
    .replace(DIGITS, '<n>');
}

const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/** A frame's file inside the application, relative to it; any other path as it is. */
function filenameOf(location: string, appRoot: string): string {
  const path = location.startsWith('file://') ? fileURLToPath(location) : location;
  const root = appRoot.endsWith('/') ? appRoot : `${appRoot}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

/**
 * The frames of a V8 stack, oldest first as the Sentry format orders them, each with only its
 * function, file, line and column. The first line, which holds the message, is never read.
 */
function framesOf(stack: string | undefined, appRoot: string): StackFrame[] {
  if (stack === undefined) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n').slice(1)) {
    const match = FRAME.exec(line);
    if (match === null) continue;
    const [, name, location, lineno, colno] = match;
    if (location === undefined || lineno === undefined || colno === undefined) continue;
    frames.push({
      function: name ?? '?',
      filename: filenameOf(location, appRoot),
      lineno: Number(lineno),
      colno: Number(colno),
    });
  }
  return frames.reverse();
}

/**
 * The error's class, such as `DatabaseError`, whose `name` `pg` leaves as `error`; the `name` of a
 * plain `Error`.
 */
function typeOf(error: Error): string {
  const name = error.constructor.name;
  return name === '' || name === 'Error' ? error.name : name;
}

/** The event of the error `error` raised while handling `request` (section 1.10 of spec 007). */
export function buildEvent(
  error: unknown,
  request: ReportedRequest,
  settings: EventSettings,
): ReportEvent {
  const sqlstate = sqlstateOf(error);
  const isError = error instanceof Error;
  return {
    event_id: settings.eventId,
    timestamp: settings.timestamp,
    platform: 'node',
    level: 'error',
    environment: settings.environment,
    release: settings.release,
    tags: {
      requestId: request.id,
      route: routeOf(request),
      method: request.method,
      replicaId: settings.replicaId,
      ...(sqlstate === undefined ? {} : { sqlstate }),
    },
    exception: {
      values: [
        {
          type: isError ? typeOf(error) : typeof error,
          value: isError
            ? scrubMessage(error.message, [...settings.secrets, ...requestValues(request)])
            : '',
          stacktrace: { frames: framesOf(isError ? error.stack : undefined, settings.appRoot) },
        },
      ],
    },
  };
}
