import type { FastifyInstance } from 'fastify';
import type { Role } from '../../domain/caller.js';
import { Forbidden } from '../../domain/errors.js';
import { callerOf } from './authenticate.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The roles permitted the route: its entry of `ROUTE_ROLES` (plan 006 section 1). */
    roles?: readonly Role[];
  }
}

/**
 * The role step of SYS-R31 as an `onRequest` hook after authentication (and, from 09-hardening,
 * after the per-user rate limit): the route's `config.roles` against the caller's role, before any
 * id or body is looked at, so every id gets the same 403 (SYS-R04). A route under the hook that
 * declares no roles is a defect, answered 500.
 */
export function registerAuthorization(scope: FastifyInstance): void {
  scope.addHook('onRequest', (request, _reply, done) => {
    const roles = request.routeOptions.config.roles;
    if (roles === undefined) {
      done(new Error(`the route ${request.routeOptions.url ?? ''} declares no roles`));
      return;
    }
    done(roles.includes(callerOf(request).role) ? undefined : new Forbidden());
  });
}
