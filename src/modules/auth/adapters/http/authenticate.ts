import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyToken, type TokenSettings } from '../../application/token-verifier.js';
import type { Caller } from '../../domain/caller.js';
import { Unauthenticated } from '../../domain/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The verified caller, set by the authentication hook; `null` before it runs. */
    caller: Caller | null;
  }
}

/**
 * One Bearer credential: the scheme in any letter case (RFC 7235), one space, and three base64url
 * segments, any of which may be empty for the verifier to refuse with its own reason.
 */
const BEARER = /^bearer ([A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*)$/i;

/**
 * The token of the `Authorization` header, the only place credentials are read from (AUT-R01,
 * AUT-R08): never the query string, the body, a cookie or another header.
 */
function credentialOf(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (header === undefined) throw new Unauthenticated('missing');
  const token = BEARER.exec(header)?.[1];
  if (token === undefined) throw new Unauthenticated('malformed');
  return token;
}

/**
 * The authentication step of SYS-R31 as an `onRequest` hook on every route of `scope` (plan 006
 * section 3). It runs before the body is read, so a request without a valid token answers 401
 * whatever its body (SYS-AC23). A rejection logs one `warn` line with the reason and the request's
 * `reqId`, never the token or a claim (AUT-R19), and the error handler answers the one 401 of
 * section 1.5 of spec 006. `clock` is in milliseconds since the epoch.
 */
export function registerAuthentication(
  scope: FastifyInstance,
  settings: TokenSettings,
  clock: () => number = Date.now,
): void {
  scope.decorateRequest('caller', null);
  scope.addHook('onRequest', async (request) => {
    try {
      request.caller = await verifyToken(credentialOf(request), settings, clock() / 1000);
    } catch (error) {
      if (error instanceof Unauthenticated) {
        request.log.warn({ reason: error.reason }, 'authentication failed');
      }
      throw error;
    }
  });
}

/** The caller of a request that passed authentication; a route without the hook is a defect. */
export function callerOf(request: FastifyRequest): Caller {
  if (request.caller === null) throw new Error('the request has no authenticated caller');
  return request.caller;
}
