import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MalformedRequest, UnsupportedMediaType } from './errors.js';

/** The largest request body the service reads, in bytes (SEC-R10). */
export const BODY_LIMIT_BYTES = 16384;

/** Whether a request carries a body: chunked, or with a `Content-Length` other than 0. */
export function hasBody(request: FastifyRequest): boolean {
  const length = request.headers['content-length'];
  return (
    request.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0')
  );
}

/**
 * `application/json` in any letter case, alone or with the single parameter `charset=utf-8`, so
 * every other charset is refused: the service parses UTF-8 only (SEC-R11).
 */
export function isJsonMediaType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const [mediaType = '', ...parameters] = contentType.split(';');
  if (mediaType.trim().toLowerCase() !== 'application/json') return false;
  if (parameters.length === 0) return true;
  if (parameters.length > 1) return false;
  const [name = '', value = '', ...rest] = (parameters[0] ?? '').split('=');
  return (
    rest.length === 0 &&
    name.trim().toLowerCase() === 'charset' &&
    ['utf-8', '"utf-8"'].includes(value.trim().toLowerCase())
  );
}

/**
 * The media-type and size checks of SEC-R10 to SEC-R12. The media type is checked in a root
 * `preParsing` hook, which runs after every `onRequest` hook (authentication, the per-user rate
 * limit and the role check) and before any byte of the body is read; the size by `bodyLimit`
 * (`BODY_LIMIT_BYTES`, set on the server), which Fastify checks against `Content-Length` before
 * reading and against the bytes received while reading, so a chunked body is limited too. Only
 * the JSON parser reads a body; a request without a body needs no `Content-Type`, and is never
 * refused for the one it has (SEC-AC08). A body whose stream the client already closed is a
 * malformed body.
 */
export function registerBodyLimits(app: FastifyInstance): void {
  app.removeContentTypeParser('text/plain');
  // Fastify runs a parser for any request with a `Content-Type`, an empty body included. Every
  // type but JSON lands here: an empty body is no body, whatever its type; any other body was
  // already refused by the hook below, and is refused here again as a fallback.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    if (body.length === 0) done(null, undefined);
    else done(new UnsupportedMediaType(), undefined);
  });
  app.addHook('preParsing', (request, _reply, payload, done) => {
    if (!hasBody(request)) {
      done(null, payload);
      return;
    }
    if (!isJsonMediaType(request.headers['content-type'])) {
      done(new UnsupportedMediaType());
      return;
    }
    // A client that closed its connection while the `onRequest` hooks waited, for example on the
    // rate-limit round trip to Redis, leaves a destroyed stream that will never emit `end` or
    // `error` again, so Fastify would wait for its body forever. It is answered as a body that
    // could not be read, as when it is cut short while being read (SYS-R25, SYS-R26).
    if (request.raw.destroyed) {
      done(new MalformedRequest('body'));
      return;
    }
    done(null, payload);
  });
}
