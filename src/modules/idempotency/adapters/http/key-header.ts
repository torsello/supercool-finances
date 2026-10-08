import type { FastifyRequest, preHandlerHookHandler, preValidationHookHandler } from 'fastify';
import { MalformedRequest } from '../../../../platform/http/errors.js';
import { fingerprint } from '../../domain/fingerprint.js';
import { parseIdempotencyKey } from '../../domain/idempotency-key.js';

/** What the hooks of a keyed route learned about a request before its handler runs. */
interface KeyedParts {
  /** The body as parsed, before validation can replace `request.body` (ADR-0004). */
  received: unknown;
  fingerprint: string;
  /** The key exactly as sent, once the malformed-request step has parsed it; none without one. */
  key?: string;
}

const parts = new WeakMap<FastifyRequest, KeyedParts>();

/** The hooks a route that takes an `Idempotency-Key` registers, in its own route options. */
export interface KeyHooks {
  preValidation: preValidationHookHandler;
  preHandler: preHandlerHookHandler;
}

/**
 * The hooks of a route that takes a key (plan 000 sections 5 and 6.2, plan 005 section 1):
 * `preValidation` computes the fingerprint from the method, the path as received without the query
 * string, and the body as parsed, before Fastify's validation can replace it (IDM-R05);
 * `preHandler` is the malformed-request step: a key sent twice, empty, above 255 characters or not
 * visible ASCII answers 400, and so does a missing one where the key is required (IDM-R01,
 * IDM-R03). A route that takes no key registers neither, so it never reads the header (SYS-R39).
 * A request without a body is fingerprinted as `null`: it fails validation, which is never stored.
 */
export function keyHooks(options: { required: boolean }): KeyHooks {
  return {
    preValidation: (request, _reply, done) => {
      const received: unknown = request.body ?? null;
      const path = (request.raw.url ?? request.url).split('?')[0] ?? '';
      parts.set(request, { received, fingerprint: fingerprint(request.method, path, received) });
      done();
    },
    preHandler: (request, _reply, done) => {
      const parsed = parseIdempotencyKey(request.headers['idempotency-key']);
      if (parsed.kind === 'malformed' || (parsed.kind === 'missing' && options.required)) {
        done(new MalformedRequest('idempotency-key'));
        return;
      }
      const known = parts.get(request);
      if (known === undefined) {
        done(new Error('the keyed route did not run its preValidation hook'));
        return;
      }
      if (parsed.kind === 'key') known.key = parsed.key;
      done();
    },
  };
}

/** The key and fingerprint of a request that carries a key, after the hooks ran. */
export function keyOf(request: FastifyRequest): { key: string; fingerprint: string } | undefined {
  const known = parts.get(request);
  return known?.key === undefined ? undefined : { key: known.key, fingerprint: known.fingerprint };
}

/** The body of a keyed request as parsed, before validation replaced `request.body`. */
export function receivedBody(request: FastifyRequest): unknown {
  const known = parts.get(request);
  if (known === undefined) throw new Error('the route is not a keyed route');
  return known.received;
}
