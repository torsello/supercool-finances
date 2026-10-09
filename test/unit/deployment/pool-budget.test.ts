import { describe, expect, it } from 'vitest';
import { poolBudget, readCompose } from '../../support/deployment.js';

describe('the connection budget', () => {
  it('SEC-AC29 every deployment keeps replicas × (DB_POOL_MAX + 1) + 10 below max_connections − superuser_reserved_connections: 2 × 11 + 10 = 32 < 97 for compose.yaml', () => {
    const budget = poolBudget(readCompose());

    expect(budget).toEqual({
      replicas: 2,
      dbPoolMax: 10,
      maxConnections: 100,
      superuserReservedConnections: 3,
      needed: 32,
      available: 97,
    });
    expect(budget.needed).toBeLessThan(budget.available);
  });
});
