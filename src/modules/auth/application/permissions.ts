import type { Role } from '../domain/caller.js';

/**
 * The role per operation of table 1.1 of spec 000, one entry per route of table 1.3 of spec 006
 * (SYS-R03, AUT-R10, AUT-R11). Paths are written as the specs write them, without `/v1`. Each route
 * passes its entry as `config.roles`, which the role check reads before any id or body is looked at
 * (SYS-R04).
 */
export const ROUTE_ROLES = {
  'POST /accounts': ['customer'],
  'GET /accounts': ['customer'],
  'GET /accounts/{id}': ['customer', 'operator'],
  'GET /accounts/{id}/entries': ['customer', 'operator'],
  'POST /accounts/{id}/freeze': ['operator'],
  'POST /accounts/{id}/unfreeze': ['operator'],
  'POST /accounts/{id}/close': ['operator'],
  'POST /accounts/{id}/deposits': ['operator'],
  'POST /accounts/{id}/withdrawals': ['customer'],
  'POST /accounts/{id}/transfers': ['customer'],
  'GET /transactions/{id}': ['customer', 'operator'],
  'POST /transactions/{id}/reversals': ['operator'],
} as const satisfies Readonly<Record<string, readonly Role[]>>;

export type RouteKey = keyof typeof ROUTE_ROLES;

export function rolesFor(route: RouteKey): readonly Role[] {
  return ROUTE_ROLES[route];
}
