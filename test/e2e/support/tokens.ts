import { randomUUID } from 'node:crypto';
import { issueToken } from '../../../src/modules/auth/application/token-issuer.js';
import type { TokenSettings } from '../../../src/modules/auth/application/token-verifier.js';
import { readCompose } from '../../support/deployment.js';

/**
 * The stack's token settings, the demo values of `compose.yaml` (section 1.4 of spec 008), which
 * the e2e suite reads from that file rather than from the environment or `.env`.
 */
export function stackJwt(): TokenSettings {
  const environment = readCompose().service('api-1').environment;
  const value = (name: string): string => {
    const found = environment[name];
    if (found === undefined || found === '') throw new Error(`compose.yaml sets no ${name}`);
    return found;
  };
  return {
    secret: value('JWT_SECRET'),
    issuer: value('JWT_ISSUER'),
    audience: value('JWT_AUDIENCE'),
  };
}

/**
 * A token the stack accepts, signed by the code of `npm run token` (section 1.2 of spec 006) in
 * this process, which is much faster than a tools container per token. The ACs of spec 008, whose
 * tokens are minted in the tools service, use `toolsTokens` of the stack support instead.
 */
export async function tokenFor(sub: string, role: 'customer' | 'operator'): Promise<string> {
  return await issueToken({ userId: sub, role }, stackJwt(), Date.now() / 1000);
}

/** A fresh user: a new subject, owning nothing, and a token for it. */
export interface User {
  id: string;
  role: 'customer' | 'operator';
  token: string;
}

export async function freshUser(role: 'customer' | 'operator'): Promise<User> {
  const id = randomUUID();
  return { id, role, token: await tokenFor(id, role) };
}
