/** The check of section 3 of plan 006 that refused a credential, for the `warn` log line only. */
export type UnauthenticatedReason =
  | 'missing'
  | 'malformed'
  | 'algorithm'
  | 'signature'
  | 'expired'
  | 'not_yet_valid'
  | 'lifetime'
  | 'claims';

/**
 * No credential, or one that failed verification (AUT-R06): 401 `/problems/unauthenticated`, one
 * body and header whatever the reason. The reason is logged, never answered (AUT-R19); the message
 * is fixed and holds neither the token nor a claim.
 */
export class Unauthenticated extends Error {
  override readonly name = 'Unauthenticated';

  constructor(readonly reason: UnauthenticatedReason) {
    super('authentication failed');
  }
}

/**
 * The caller's role is not permitted the operation, whatever ids the request names (SYS-R04,
 * AUT-R10, AUT-R11): 403 `/problems/forbidden`.
 */
export class Forbidden extends Error {
  override readonly name = 'Forbidden';

  constructor() {
    super('the role is not permitted this operation');
  }
}
