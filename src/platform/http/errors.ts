/**
 * Typed errors of the HTTP edge (plan 000 section 7). Like every typed error, their messages are
 * fixed and never reach a response; `toProblem` maps them.
 */

/** What a malformed request got wrong, named in the problem's `detail` (SYS-R26). */
export type MalformedPart = 'request' | 'body' | 'idempotency-key' | 'cursor';

/**
 * A request the HTTP parser refuses, a body that does not parse as JSON, a missing or malformed
 * `Idempotency-Key`, or an invalid cursor (SYS-R26): 400 `/problems/malformed-request`.
 */
export class MalformedRequest extends Error {
  override readonly name = 'MalformedRequest';

  constructor(readonly part: MalformedPart) {
    super(`malformed request: ${part}`);
  }
}

/**
 * One entry of the `errors` member of a validation error (SYS-R27): a JSON Pointer to the body
 * member, `/` for the whole body, or the name of a query string parameter.
 */
export type ValidationIssue =
  { pointer: string; detail: string } | { parameter: string; detail: string };

/** A request that parses but whose content fails validation (SYS-R27): 422 `/problems/validation-error`. */
export class ValidationFailed extends Error {
  override readonly name = 'ValidationFailed';

  constructor(readonly errors: readonly ValidationIssue[]) {
    super('the request content is not valid');
  }
}

/** A path that is not a defined route (SYS-R32): 404 `/problems/not-found`, the body of every 404. */
export class RouteNotFound extends Error {
  override readonly name = 'RouteNotFound';

  constructor() {
    super('no route');
  }
}

/**
 * A request body above 16384 bytes, by `Content-Length` or by the bytes received (SEC-R10): 413
 * `/problems/payload-too-large`.
 */
export class PayloadTooLarge extends Error {
  override readonly name = 'PayloadTooLarge';

  constructor() {
    super('request body too large');
  }
}

/**
 * A request body whose `Content-Type` is missing or is not `application/json`, alone or with
 * `charset=utf-8` (SEC-R11): 415 `/problems/unsupported-media-type`.
 */
export class UnsupportedMediaType extends Error {
  override readonly name = 'UnsupportedMediaType';

  constructor() {
    super('unsupported request media type');
  }
}

/**
 * An authenticated user above `RATE_LIMIT_USER_MAX` requests in the current window (SEC-R03): 429
 * `/problems/rate-limited`, with the whole seconds left in the window as `Retry-After`.
 */
export class RateLimited extends Error {
  override readonly name = 'RateLimited';

  constructor(readonly retryAfterSeconds: number) {
    super('per-user rate limit exceeded');
  }
}

/**
 * The replica is not ready: the database did not answer in time, a shipped migration is missing,
 * or the process is shutting down (SEC-R24, SEC-R26): 503 `/problems/service-unavailable`, with
 * one body whatever the cause, which only the log names.
 */
export class NotReady extends Error {
  override readonly name = 'NotReady';

  constructor() {
    super('not ready');
  }
}

/**
 * A request that arrived after the replica stopped accepting connections, on a connection kept
 * alive from before (SEC-R25): 503 `/problems/service-unavailable` with `Retry-After: 1`, answered
 * before it reaches the pool, so the client retries on another replica.
 */
export class ShuttingDown extends Error {
  override readonly name = 'ShuttingDown';

  constructor() {
    super('the replica is shutting down');
  }
}
