import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ROUTE_ROLES,
  rolesFor,
  type RouteKey,
} from '../../../src/modules/auth/application/permissions.js';
import type { Role } from '../../../src/modules/auth/domain/caller.js';

interface MatrixRow {
  number: string;
  endpoint: string;
  customerOwn: string;
  operator: string;
}

/** The rows of the authorization matrix, table 1.3 of spec 006, read from the spec itself. */
function matrixRows(): MatrixRow[] {
  const spec = readFileSync(new URL('../../../specs/006-auth/spec.md', import.meta.url), 'utf8');
  const rows: MatrixRow[] = [];
  for (const line of spec.split('\n')) {
    if (!/^\| M\d\d /.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [number = '', endpoint = '', , customerOwn = '', , operator = ''] = cells;
    const route = /`([A-Z]+ [^`]+)`/.exec(endpoint)?.[1];
    if (route === undefined) throw new Error(`no endpoint in row ${number}`);
    rows.push({ number, endpoint: route, customerOwn, operator });
  }
  return rows;
}

/** A role is permitted a route when its cell of the matrix is anything but 403. */
function permitted(cell: string): boolean {
  return !cell.startsWith('403');
}

/** Table 1.1 of spec 000, one entry per route of table 1.3 of spec 006. */
const TABLE_1_1: Readonly<Record<RouteKey, readonly Role[]>> = {
  'POST /accounts': ['customer'], // Open an account: own accounts; operators no (ACC-R06)
  'GET /accounts': ['customer'], // List accounts: own only; operators no (ACC-R27)
  'GET /accounts/{id}': ['customer', 'operator'], // Read an account
  'GET /accounts/{id}/entries': ['customer', 'operator'], // List an account's history
  'POST /accounts/{id}/freeze': ['operator'],
  'POST /accounts/{id}/unfreeze': ['operator'],
  'POST /accounts/{id}/close': ['operator'],
  'POST /accounts/{id}/deposits': ['operator'], // Deposit: operators only
  'POST /accounts/{id}/withdrawals': ['customer'], // Withdraw: own accounts only
  'POST /accounts/{id}/transfers': ['customer'], // Transfer: out of own accounts
  'GET /transactions/{id}': ['customer', 'operator'], // Read a transaction
  'POST /transactions/{id}/reversals': ['operator'], // Reverse: operators only
};

describe('permissions', () => {
  it('SYS-R03 AUT-R14 gives every route of table 1.3 of spec 006 exactly the roles its cells permit', () => {
    const rows = matrixRows();
    expect(rows).toHaveLength(13);
    const fromMatrix = new Map<string, Role[]>();
    for (const row of rows) {
      const roles: Role[] = [];
      if (permitted(row.customerOwn)) roles.push('customer');
      if (permitted(row.operator)) roles.push('operator');
      // M10 and M11 are one route; both rows must agree.
      const earlier = fromMatrix.get(row.endpoint);
      if (earlier !== undefined) expect(roles, row.number).toEqual(earlier);
      fromMatrix.set(row.endpoint, roles);
    }
    expect(Object.fromEntries(fromMatrix)).toEqual(ROUTE_ROLES);
  });

  it('SYS-R03 AUT-R10 AUT-R11 gives every route the roles of table 1.1 of spec 000', () => {
    expect(ROUTE_ROLES).toEqual(TABLE_1_1);
    for (const [route, roles] of Object.entries(TABLE_1_1)) {
      expect(rolesFor(route as RouteKey)).toEqual(roles);
    }
  });

  it('AUT-R10 permits no customer a deposit, freeze, unfreeze, close or reversal, and AUT-R11 no operator a creation, list, withdrawal or transfer', () => {
    const operatorOnly: RouteKey[] = [
      'POST /accounts/{id}/deposits',
      'POST /accounts/{id}/freeze',
      'POST /accounts/{id}/unfreeze',
      'POST /accounts/{id}/close',
      'POST /transactions/{id}/reversals',
    ];
    const customerOnly: RouteKey[] = [
      'POST /accounts',
      'GET /accounts',
      'POST /accounts/{id}/withdrawals',
      'POST /accounts/{id}/transfers',
    ];
    for (const route of operatorOnly) expect(rolesFor(route)).not.toContain('customer');
    for (const route of customerOnly) expect(rolesFor(route)).not.toContain('operator');
  });
});
