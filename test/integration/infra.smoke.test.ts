import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Run "npm run env:sync" and "npm run infra:up", or export ${name}.`,
    );
  }
  return value;
}

describe('local infrastructure', () => {
  let pool: pg.Pool | undefined;
  let redis: Redis | undefined;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: requireEnv('TEST_DATABASE_URL'), max: 2 });
    redis = new Redis(requireEnv('REDIS_URL'), { maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    await pool?.end();
    await redis?.quit();
  });

  function db(): pg.Pool {
    if (pool === undefined) throw new Error('Postgres pool was not created');
    return pool;
  }

  it('runs PostgreSQL 16 or newer', async () => {
    const result = await db().query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );

    expect(Number.parseInt(result.rows[0]?.version ?? '0', 10)).toBeGreaterThanOrEqual(160000);
  });

  it('returns bigint columns as exact strings', async () => {
    const result = await db().query<{ value: unknown }>('SELECT 9007199254740993::bigint AS value');

    expect(result.rows[0]?.value).toBe('9007199254740993');
  });

  it('answers Redis PING with PONG', async () => {
    if (redis === undefined) throw new Error('Redis client was not created');

    expect(await redis.ping()).toBe('PONG');
  });
});
