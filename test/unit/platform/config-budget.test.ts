import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, type Environment } from '../../../src/platform/config/config.js';

const VALID: Environment = {
  DATABASE_URL: 'postgres://scf_app:db-password-1234@127.0.0.1:55432/supercool_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_SECRET: 'jwt-secret-for-the-config-unit-tests-000000000000',
  JWT_ISSUER: 'scf-test',
  JWT_AUDIENCE: 'scf-api',
  CURSOR_SECRET: 'cursor-secret-for-the-config-unit-tests-00000000',
};

/** Every variable of the request-timeout budget of SEC-R35. */
const BUDGET_VARIABLES = [
  'REQUEST_TIMEOUT_MS',
  'DB_POOL_ACQUIRE_TIMEOUT_MS',
  'REDIS_COMMAND_TIMEOUT_MS',
  'IDEMPOTENCY_WAIT_TIMEOUT_MS',
  'ACCOUNT_LOCK_TIMEOUT_MS',
] as const;

function failure(overrides: Environment): ConfigError {
  try {
    loadConfig({ ...VALID, ...overrides });
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error(`the load with ${JSON.stringify(overrides)} succeeded`);
}

describe('the timeout budget', () => {
  it('SEC-R35 refuses REQUEST_TIMEOUT_MS 20130 with the defaults and accepts 20131, naming every variable of the sum', () => {
    const error = failure({ REQUEST_TIMEOUT_MS: '20130' });
    expect(error.problems.map((problem) => problem.variable)).toEqual(['REQUEST_TIMEOUT_MS']);
    for (const variable of BUDGET_VARIABLES) expect(error.message).toContain(variable);
    // The values are never printed, the sum included (SEC-R40).
    expect(error.message).not.toContain('20130');

    expect(loadConfig({ ...VALID, REQUEST_TIMEOUT_MS: '20131' }).requestTimeoutMs).toBe(20131);
    expect(
      loadConfig({ ...VALID, REQUEST_TIMEOUT_MS: '20131', SHUTDOWN_TIMEOUT_MS: '20131' }),
    ).toMatchObject({ requestTimeoutMs: 20131, shutdownTimeoutMs: 20131 });
  });

  it('SEC-R35 refuses a sum raised by any of its variables, naming them all', () => {
    for (const overrides of [
      { ACCOUNT_LOCK_TIMEOUT_MS: '3000' },
      { IDEMPOTENCY_WAIT_TIMEOUT_MS: '4000' },
      { REDIS_COMMAND_TIMEOUT_MS: '5000' },
      { DB_POOL_ACQUIRE_TIMEOUT_MS: '6870' },
    ]) {
      const error = failure(overrides);
      expect(
        error.problems.map((problem) => problem.variable),
        JSON.stringify(overrides),
      ).toEqual(['REQUEST_TIMEOUT_MS']);
      for (const variable of BUDGET_VARIABLES) expect(error.message).toContain(variable);
    }
    expect(
      loadConfig({ ...VALID, DB_POOL_ACQUIRE_TIMEOUT_MS: '6869' }).dbPoolAcquireTimeoutMs,
    ).toBe(6869);
    expect(
      loadConfig({
        ...VALID,
        ACCOUNT_LOCK_TIMEOUT_MS: '4999',
        IDEMPOTENCY_WAIT_TIMEOUT_MS: '4999',
        REQUEST_TIMEOUT_MS: '50000',
        SHUTDOWN_TIMEOUT_MS: '50000',
      }).requestTimeoutMs,
    ).toBe(50000);
  });

  it('SEC-R35 refuses SHUTDOWN_TIMEOUT_MS below REQUEST_TIMEOUT_MS, naming both', () => {
    const error = failure({ SHUTDOWN_TIMEOUT_MS: '24999' });
    expect(error.problems.map((problem) => problem.variable)).toEqual(['SHUTDOWN_TIMEOUT_MS']);
    expect(error.message).toContain('SHUTDOWN_TIMEOUT_MS');
    expect(error.message).toContain('REQUEST_TIMEOUT_MS');
    expect(error.message).not.toContain('24999');
    expect(loadConfig({ ...VALID, SHUTDOWN_TIMEOUT_MS: '25000' }).shutdownTimeoutMs).toBe(25000);
  });

  it('SEC-R35 reports both budgets in one error, and leaves the budget to the range rule when a variable of it is invalid', () => {
    const both = failure({ REQUEST_TIMEOUT_MS: '20000', SHUTDOWN_TIMEOUT_MS: '19999' });
    expect(both.problems.map((problem) => problem.variable)).toEqual([
      'REQUEST_TIMEOUT_MS',
      'SHUTDOWN_TIMEOUT_MS',
    ]);
    const range = failure({ ACCOUNT_LOCK_TIMEOUT_MS: '5000' });
    expect(range.problems.map((problem) => problem.variable)).toEqual(['ACCOUNT_LOCK_TIMEOUT_MS']);
    expect(range.message).toContain('from 1 to 4999');
  });

  it('SEC-R35 SEC-R40 checks SHUTDOWN_TIMEOUT_MS against REQUEST_TIMEOUT_MS whenever both are valid, even with another budget variable invalid', () => {
    const error = failure({ ACCOUNT_LOCK_TIMEOUT_MS: '5000', SHUTDOWN_TIMEOUT_MS: '1000' });
    expect(error.problems.map((problem) => problem.variable)).toEqual([
      'ACCOUNT_LOCK_TIMEOUT_MS',
      'SHUTDOWN_TIMEOUT_MS',
    ]);
    expect(error.message).toContain('SHUTDOWN_TIMEOUT_MS must be not less than REQUEST_TIMEOUT_MS');
    // With REQUEST_TIMEOUT_MS itself invalid, the comparison is not made.
    const invalidRequest = failure({ REQUEST_TIMEOUT_MS: '0', SHUTDOWN_TIMEOUT_MS: '1000' });
    expect(invalidRequest.problems.map((problem) => problem.variable)).toEqual([
      'REQUEST_TIMEOUT_MS',
    ]);
  });
});
