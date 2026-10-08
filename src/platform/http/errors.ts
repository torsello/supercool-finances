/**
 * Typed errors of the HTTP edge (plan 000 section 7). Like every typed error, their messages are
 * fixed and never reach a response; `toProblem` maps them.
 */

/** What a malformed request got wrong, named in the problem's `detail` (SYS-R26). */
export type MalformedPart = 'body' | 'idempotency-key' | 'cursor';

/**
 * A body that does not parse as JSON, a missing or malformed `Idempotency-Key`, or an invalid
 * cursor (SYS-R26): 400 `/problems/malformed-request`.
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
