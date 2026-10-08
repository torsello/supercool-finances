import type { FastifyInstance } from 'fastify';
import { problemResponse, sendProblem, toProblem, handleError } from './error-handler.js';
import { RouteNotFound } from './errors.js';

/** Registers the routes of one module on the `/v1` scope. */
export type RouteModule = (scope: FastifyInstance) => void | Promise<void>;

export interface RoutesOptions {
  /**
   * Adds the `onRequest` hooks of every `/v1` route, in the order of SYS-R31: authentication, the
   * per-user rate limit (09-hardening), then the role check (plan 000 section 5).
   */
  protect: (scope: FastifyInstance) => void;
  modules: readonly RouteModule[];
}

/**
 * The request pipeline of plan 000 section 5: the error handler, the not-found handler, and every
 * module's routes under `/v1` (SYS-R43) behind the hooks of `protect`. The not-found handler lives
 * on the root scope, outside those hooks, so an unknown path answers 404 before any credential is
 * read, with or without one (SYS-R31, SYS-R32); the root `onRequest` hook answers it before the body
 * is parsed.
 */
export function registerRoutes(app: FastifyInstance, options: RoutesOptions): void {
  app.setErrorHandler(handleError);
  // Fastify parses the body of an unknown path before its not-found handler runs, so a body that
  // does not parse or has another media type would fail first. This root hook answers the route
  // step at `onRequest`, before any body or credential is read (SYS-R31, SYS-R32).
  app.addHook('onRequest', (request, reply, done) => {
    if (!request.is404) {
      done();
      return;
    }
    void sendProblem(reply, problemResponse(toProblem(new RouteNotFound()), request.id));
  });
  app.setNotFoundHandler(async (request, reply) => {
    await sendProblem(reply, problemResponse(toProblem(new RouteNotFound()), request.id));
  });
  void app.register(
    async (scope) => {
      options.protect(scope);
      for (const module of options.modules) {
        await scope.register(async (routes) => {
          await module(routes);
        });
      }
    },
    { prefix: '/v1' },
  );
}
