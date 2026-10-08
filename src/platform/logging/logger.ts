import type { FastifyRequest, FastifyServerOptions } from 'fastify';
import type { LogLevel } from '../config/config.js';

/** Where log lines go: standard output by default, a capture in tests (plan 000 section 9). */
export interface LogDestination {
  write(line: string): void;
}

/**
 * The request as logged: its method and path, never the query string, which may carry a token
 * (`access_token`) that must never reach a log (AUT-R19).
 */
function requestSerializer(request: FastifyRequest): { method: string; url: string } {
  return { method: request.method, url: request.url.split('?')[0] ?? '' };
}

/**
 * Fastify's pino logger: one JSON object per line with `level`, `time` and `msg`, and `reqId` on
 * every line written while handling a request (SEC-R21, SYS-R22). 09-hardening adds the redaction
 * of SEC-R22.
 */
export function loggerOptions(
  level: LogLevel,
  destination?: LogDestination,
): NonNullable<FastifyServerOptions['logger']> {
  return {
    level,
    ...(destination === undefined ? {} : { stream: destination }),
    serializers: { req: requestSerializer },
  };
}
