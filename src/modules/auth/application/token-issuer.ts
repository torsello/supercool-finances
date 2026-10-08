import { CompactSign } from 'jose';
import type { Caller } from '../domain/caller.js';
import type { TokenSettings } from './token-verifier.js';

/** The lifetime of an issued token: the longest the verifier accepts (AUT-R05, AUT-R16). */
const LIFETIME_SECONDS = 900;

/**
 * Signs a token the verifier accepts (section 1.2 of spec 006): header `{"alg": "HS256", "typ":
 * "JWT"}`, claims `sub`, `role`, `iat` (`now` rounded down to whole seconds), `exp` = `iat` + 900,
 * `iss` and `aud` as a string, and no `nbf`. `now` is in seconds since the epoch.
 */
export async function issueToken(
  caller: Caller,
  settings: TokenSettings,
  now: number,
): Promise<string> {
  const iat = Math.floor(now);
  const claims = {
    sub: caller.userId.toLowerCase(),
    role: caller.role,
    iat,
    exp: iat + LIFETIME_SECONDS,
    iss: settings.issuer,
    aud: settings.audience,
  };
  return await new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(new TextEncoder().encode(settings.secret));
}
