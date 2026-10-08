import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { UuidV7Generator } from '../ids/uuid-v7.js';

/** The request header and the response header of the correlation id (SYS-R21). */
export const REQUEST_ID_HEADER = 'x-request-id';

/** A client's value kept as the correlation id: 1 to 128 characters of `A-Z a-z 0-9 . _ : -`. */
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const ids = new UuidV7Generator();

/**
 * Fastify's `genReqId` (SYS-R21): the client's `X-Request-Id` when it is made only of the allowed
 * characters, so it cannot inject into a log line, and a fresh UUIDv7 otherwise. Fastify puts the
 * id on the request's logger child as `reqId` (SYS-R22).
 */
export function requestIdOf(request: IncomingMessage): string {
  const value = request.headers[REQUEST_ID_HEADER];
  return typeof value === 'string' && CLIENT_REQUEST_ID.test(value) ? value : ids.next();
}

/** Sets the correlation id on a response's `X-Request-Id` header. */
export function setRequestIdHeader(reply: FastifyReply, requestId: string): void {
  void reply.header(REQUEST_ID_HEADER, requestId);
}

/**
 * Returns the correlation id on every response (SYS-R21): a root `onRequest` hook, registered
 * before any other, so even answers given at the route step carry it.
 */
export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    setRequestIdHeader(reply, request.id);
    done();
  });
}
