import cors, { type FastifyCorsOptions } from '@fastify/cors';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * CORS for the exact origins of `CORS_ORIGINS` only (SEC-R17): a request or preflight whose
 * `Origin` equals one of them gets it in `Access-Control-Allow-Origin` with `Vary: Origin`; a
 * preflight is allowed `GET` and `POST` with the headers below; responses expose the headers a
 * client reads; credentials are never allowed, since tokens travel in `Authorization`. Any other
 * origin gets no `Access-Control-*` header at all, and its preflight falls through to the
 * not-found handler, as does an `OPTIONS` without `Access-Control-Request-Method`, which is not a
 * preflight, so it gets the not-found problem rather than a plain-text 400. With `CORS_ORIGINS`
 * empty nothing is registered, so no response carries an
 * `Access-Control-*` header and a preflight answers as a path that is not a route (SEC-R16).
 */
export function registerCors(app: FastifyInstance, origins: readonly string[]): void {
  if (origins.length === 0) return;
  const allowed = new Set(origins);
  const options = (origin: string | false): FastifyCorsOptions => ({
    origin,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Location', 'Retry-After', 'Idempotent-Replayed'],
    credentials: false,
  });
  void app.register(cors, {
    delegator: (request: FastifyRequest, callback) => {
      const { origin } = request.headers;
      const notPreflight =
        request.method === 'OPTIONS' &&
        request.headers['access-control-request-method'] === undefined;
      callback(
        null,
        options(origin !== undefined && allowed.has(origin) && !notPreflight ? origin : false),
      );
    },
  });
}
