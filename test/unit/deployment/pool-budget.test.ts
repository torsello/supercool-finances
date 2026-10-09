import { describe, expect, it } from 'vitest';
import {
  poolBudget,
  readCompose,
  readRepositoryFile,
  readTerraform,
  terraformPoolBudget,
} from '../../support/deployment.js';

const VARIABLES = 'infra/terraform/variables.tf';

describe('the connection budget', () => {
  it("SEC-AC29 every deployment keeps replicas × (DB_POOL_MAX + 1) + 10 below max_connections − superuser_reserved_connections: 2 × 11 + 10 = 32 < 97 for compose.yaml, 12 × 11 + 10 = 142 < 197 for infra/terraform, a deployment's surge included", () => {
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

    // AWS: a rollout at the autoscaling maximum, 6 tasks × deployment_maximum_percent 200 / 100,
    // the api container's DB_POOL_MAX and the RDS parameter group's max_connections of 200.
    const aws = terraformPoolBudget(readTerraform());

    expect(aws).toEqual({
      replicas: 12,
      dbPoolMax: 10,
      maxConnections: 200,
      superuserReservedConnections: 3,
      needed: 142,
      available: 197,
    });
    expect(aws.needed).toBeLessThan(aws.available);

    // The values are read from the Terraform, not assumed: a copy whose rollouts surge to 300%
    // and a copy whose parameter group sets max_connections 100 both break the budget.
    const variables = readRepositoryFile(VARIABLES);
    const surge = /(variable "deployment_maximum_percent" \{[^}]*default\s*=\s*)200\b/;
    expect(variables).toMatch(surge);
    const wider = terraformPoolBudget(
      readTerraform({ [VARIABLES]: variables.replace(surge, '$1300') }),
    );
    expect(wider).toMatchObject({ replicas: 18, needed: 208, available: 197 });
    expect(wider.needed).not.toBeLessThan(wider.available);

    const maxConnections = /(variable "db_max_connections" \{[^}]*default\s*=\s*)200\b/;
    expect(variables).toMatch(maxConnections);
    const smaller = terraformPoolBudget(
      readTerraform({ [VARIABLES]: variables.replace(maxConnections, '$1100') }),
    );
    expect(smaller).toMatchObject({ maxConnections: 100, needed: 142, available: 97 });
    expect(smaller.needed).not.toBeLessThan(smaller.available);
  });
});
