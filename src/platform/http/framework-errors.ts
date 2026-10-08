import { IncomingMessage, maxHeaderSize, STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { handleError, problemResponse, sendProblem, toProblem } from './error-handler.js';
import { MalformedRequest, RouteNotFound } from './errors.js';

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

/**
 * Fastify's `clientErrorHandler`, for a request the HTTP parser refuses before Fastify sees it. It
 * answers 400 `/problems/malformed-request` whatever Node reports (an invalid request line or
 * header, headers above the maximum size, or a request not received in time), the one status spec
 * 000 and plan 000 section 7 give that type. The body comes from `toProblem` and the registry, with
 * an id from the app's request id generator (SYS-R24, SYS-R26). Like Fastify's default, it answers
 * nothing on a reset or destroyed socket and then destroys it.
 */
export function clientErrorHandler(): (
  this: RequestIdSource,
  error: ClientError,
  socket: Socket,
) => void {
  // Fastify calls the handler with the app as `this`, whose `genReqId` is the app's generator.
  return function (this: RequestIdSource, error: ClientError, socket: Socket): void {
    if (error.code === 'ECONNRESET' || socket.destroyed) return;
    const response = problemResponse(
      toProblem(new MalformedRequest('request')),
      this.genReqId(new IncomingMessage(socket)),
    );
    if (socket.writable) {
      const headers = Object.entries(response.headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('');
      socket.write(
        `HTTP/1.1 ${String(response.status)} ${STATUS_CODES[response.status] ?? ''}\r\n` +
          headers +
          `content-length: ${String(response.body.byteLength)}\r\n` +
          'connection: close\r\n\r\n',
      );
      socket.write(response.body);
    }
    socket.destroy(error);
  };
}
