export const ROLES = ['customer', 'operator'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The identity of a request: the token's `sub` in canonical lowercase and its role, taken from a
 * verified token and from nowhere else. It is the only identity every use case receives (AUT-R07).
 */
export interface Caller {
  userId: string;
  role: Role;
}

export function isRole(value: unknown): value is Role {
  return ROLES.some((role) => role === value);
}
