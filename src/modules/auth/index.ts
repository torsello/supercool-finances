// The auth module's public API (plan 000 section 2): the caller, the typed errors, the token
// verifier and issuer, and the role per route. The composition root imports the HTTP hooks
// directly.
export { isRole, ROLES, type Caller, type Role } from './domain/caller.js';
export { Forbidden, Unauthenticated, type UnauthenticatedReason } from './domain/errors.js';
export { verifyToken, type TokenSettings } from './application/token-verifier.js';
export { issueToken } from './application/token-issuer.js';
export { ROUTE_ROLES, rolesFor, type RouteKey } from './application/permissions.js';
