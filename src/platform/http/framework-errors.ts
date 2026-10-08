import { IncomingMessage, maxHeaderSize, STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { handleError, problemResponse, sendProblem, toProblem } from './error-handler.js';
import { RouteNotFound } from './errors.js';
import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPES } from './problem.js';

/**
 * The router's longest path parameter: Node's maximum header size, which also bounds the request
 * line, so any id the HTTP server accepts reaches its route. A long id then answers as SYS-R31
 * orders, 401 before anything else and 404 at the lookup (SYS-R42), never a router error.
 */
export const MAX_PARAM_LENGTH = maxHeaderSize;

/**
 * Fastify's `frameworkErrors`, for errors the router raises before a route is chosen: a path that
 * does not decode (`FST_ERR_BAD_URL`) names no route, so it answers the shared not-found problem
 * (SYS-R24, SYS-R32). `FST_ERR_MAX_PARAM_LENGTH` cannot occur below `MAX_PARAM_LENGTH` and answers
 * the same problem as a fallback. Anything else goes to the error handler.
 */
export function handleFrameworkError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error.code === 'FST_ERR_BAD_URL' || error.code === 'FST_ERR_MAX_PARAM_LENGTH') {
    void sendProblem(reply, problemResponse(toProblem(new RouteNotFound()), request.id));
    return;
  }
  void handleError(error, request, reply);
}

/** The app, as Fastify binds it to the client error handler. */
interface RequestIdSource {
  genReqId(request: IncomingMessage): string;
}

/** A connection error as Node's HTTP server reports it. */
interface ClientError extends Error {
  code?: string;
}

/** The status Fastify's default client error handler answers for each error. */
function clientErrorStatus(error: ClientError): 400 | 408 | 431 {
  if (error.code === 'ERR_HTTP_REQUEST_TIMEOUT') return 408;
  if (error.code === 'HPE_HEADER_OVERFLOW') return 431;
  return 400;
}

const CLIENT_ERROR_DETAILS = {
  400: 'The request could not be parsed.',
  408: 'The request was not received in time.',
  431: 'The request headers are too large.',
} as const;

/**
 * Fastify's `clientErrorHandler`, for a request the HTTP parser refuses before Fastify sees it: an
 * `application/problem+json` body with the status Fastify would answer (400, 408 or 431) and an id
 * from the app's request id generator (SYS-R24). The three share `/problems/malformed-request`,
 * the owner's choice on 2026-10-08, so 408 and 431 are that type's only statuses other than 400.
 * Like Fastify's default, it answers nothing on a reset or destroyed socket and then destroys it.
 */
export function clientErrorHandler(): (
  this: RequestIdSource,
  error: ClientError,
  socket: Socket,
) => void {
  // Fastify calls the handler with the app as `this`, whose `genReqId` is the app's generator.
  return function (this: RequestIdSource, error: ClientError, socket: Socket): void {
    if (error.code === 'ECONNRESET' || socket.destroyed) return;
    const status = clientErrorStatus(error);
    const body = JSON.stringify({
      type: '/problems/malformed-request',
      title: PROBLEM_TYPES['/problems/malformed-request'].title,
      status,
      detail: CLIENT_ERROR_DETAILS[status],
      requestId: this.genReqId(new IncomingMessage(socket)),
    });
    if (socket.writable) {
      socket.write(
        `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}\r\n` +
          `Content-Type: ${PROBLEM_CONTENT_TYPE}\r\n` +
          `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
          'Connection: close\r\n\r\n' +
          body,
      );
    }
    socket.destroy(error);
  };
}
