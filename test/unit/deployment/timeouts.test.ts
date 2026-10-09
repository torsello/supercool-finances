import { describe, expect, it } from 'vitest';
import { KEEP_ALIVE_TIMEOUT_MS } from '../../../src/app.js';
import { ConfigError, loadConfig, type Environment } from '../../../src/platform/config/config.js';
import {
  checkRequestTimeouts,
  findDirectives,
  nginxTimeMs,
  onlyArgument,
  parseCompose,
  readCompose,
  readNginxTemplate,
  readRepositoryFile,
} from '../../support/deployment.js';
import { shippedMigrations } from '../../support/migrations.js';

const VALID: Environment = {
  DATABASE_URL: 'postgres://scf_app:db-password-1234@127.0.0.1:55432/supercool_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_SECRET: 'jwt-secret-for-the-timeout-unit-tests-00000000000',
  JWT_ISSUER: 'scf-test',
  JWT_AUDIENCE: 'scf-api',
  CURSOR_SECRET: 'cursor-secret-for-the-timeout-unit-tests-0000000',
};

/** The message of the ConfigError a load throws. */
function refusal(overrides: Environment): string {
  try {
    loadConfig({ ...VALID, ...overrides });
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error(`the load with ${JSON.stringify(overrides)} succeeded`);
}

/** A runtime role setting of the migration that sets them, in milliseconds. */
function roleSettingMs(sql: string, name: string): number {
  const match = new RegExp(
    `SET ${name} = %L',\\s*current_database\\(\\), '([0-9]+(?:ms|s|min))'`,
  ).exec(sql);
  if (match?.[1] === undefined) throw new Error(`${name} is not set on the runtime role`);
  const value = match[1];
  if (value.endsWith('min')) return Number(value.slice(0, -3)) * 60_000;
  return nginxTimeMs(value);
}

describe('the timeout layers', () => {
  it('SEC-AC26 lock waits < statement_timeout < REQUEST_TIMEOUT_MS < the load balancer, keep-alive above it, and the loader refuses a broken budget', () => {
    const defaults = loadConfig(VALID);
    const settings = shippedMigrations().filter((name) => name.endsWith('_runtime-role-settings'));
    expect(settings).toHaveLength(1);
    const sql = readRepositoryFile(`migrations/${settings[0] ?? ''}.sql`);
    const statementTimeoutMs = roleSettingMs(sql, 'statement_timeout');
    const template = readNginxTemplate();
    const proxyReadTimeoutMs = nginxTimeMs(onlyArgument(template, 'proxy_read_timeout'));
    const [upstream] = findDirectives(template, 'upstream');
    const upstreamKeepAlive = upstream?.block?.find((d) => d.name === 'keepalive_timeout');

    expect(defaults.accountLockTimeoutMs).toBe(2000);
    expect(defaults.idempotencyWaitTimeoutMs).toBe(2000);
    expect(statementTimeoutMs).toBe(5000);
    expect(defaults.requestTimeoutMs).toBe(25000);
    expect(proxyReadTimeoutMs).toBe(30_000);
    expect(defaults.accountLockTimeoutMs).toBeLessThan(statementTimeoutMs);
    expect(defaults.idempotencyWaitTimeoutMs).toBeLessThan(statementTimeoutMs);
    expect(statementTimeoutMs).toBeLessThan(defaults.requestTimeoutMs);
    expect(defaults.requestTimeoutMs).toBeLessThan(proxyReadTimeoutMs);
    expect(KEEP_ALIVE_TIMEOUT_MS).toBe(65_000);
    expect(nginxTimeMs(upstreamKeepAlive?.args[0] ?? '')).toBe(60_000);
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(nginxTimeMs(upstreamKeepAlive?.args[0] ?? ''));
    expect(roleSettingMs(sql, 'idle_in_transaction_session_timeout')).toBe(10_000);

    expect(refusal({ REQUEST_TIMEOUT_MS: '20130' })).toContain('REQUEST_TIMEOUT_MS');
    expect(
      loadConfig({ ...VALID, REQUEST_TIMEOUT_MS: '20131', SHUTDOWN_TIMEOUT_MS: '20131' }),
    ).toMatchObject({ requestTimeoutMs: 20131, shutdownTimeoutMs: 20131 });
    const shutdown = refusal({ SHUTDOWN_TIMEOUT_MS: '24999' });
    expect(shutdown).toContain('SHUTDOWN_TIMEOUT_MS');
    expect(shutdown).toContain('REQUEST_TIMEOUT_MS');
    const lock = refusal({ ACCOUNT_LOCK_TIMEOUT_MS: '3000' });
    expect(lock).toContain('REQUEST_TIMEOUT_MS');
    expect(lock).toContain('ACCOUNT_LOCK_TIMEOUT_MS');
    const redis = refusal({ REDIS_COMMAND_TIMEOUT_MS: '5000' });
    expect(redis).toContain('REQUEST_TIMEOUT_MS');
    expect(redis).toContain('REDIS_COMMAND_TIMEOUT_MS');
    for (const variable of ['ACCOUNT_LOCK_TIMEOUT_MS', 'IDEMPOTENCY_WAIT_TIMEOUT_MS']) {
      const message = refusal({ [variable]: '5000' });
      expect(message).toContain(`${variable} must be`);
      expect(message).toContain('from 1 to 4999');
    }
    expect(
      loadConfig({
        ...VALID,
        ACCOUNT_LOCK_TIMEOUT_MS: '4999',
        IDEMPOTENCY_WAIT_TIMEOUT_MS: '4999',
        REQUEST_TIMEOUT_MS: '50000',
        SHUTDOWN_TIMEOUT_MS: '50000',
      }),
    ).toMatchObject({ accountLockTimeoutMs: 4999, idempotencyWaitTimeoutMs: 4999 });
  });

  it("SEC-AC36 every deployment keeps REQUEST_TIMEOUT_MS below the load balancer's upstream timeout, and the check fails on a copy that raises it to 30000", () => {
    const checks = checkRequestTimeouts(readCompose(), readNginxTemplate());

    expect(checks).toEqual([
      { replica: 'api-1', requestTimeoutMs: 25000, loadBalancerTimeoutMs: 30_000, problems: [] },
      { replica: 'api-2', requestTimeoutMs: 25000, loadBalancerTimeoutMs: 30_000, problems: [] },
    ]);

    const anchor = 'x-service-environment: &service-environment\n';
    const original = readRepositoryFile('compose.yaml');
    expect(original).toContain(anchor);
    const copy = original.replace(anchor, `${anchor}  REQUEST_TIMEOUT_MS: '30000'\n`);
    const broken = checkRequestTimeouts(parseCompose(copy), readNginxTemplate());

    expect(broken.map((check) => check.requestTimeoutMs)).toEqual([30000, 30000]);
    for (const check of broken) {
      expect(check.problems).toHaveLength(1);
      expect(check.problems[0]).toContain('REQUEST_TIMEOUT_MS');
    }
  });
});
