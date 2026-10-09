import { describe, expect, it } from 'vitest';
import { buildAppFromEnvironment } from '../../../src/app.js';
import {
  ConfigError,
  loadAuthConfig,
  loadConfig,
  parseDecimalInteger,
  type Environment,
} from '../../../src/platform/config/config.js';

/** A valid environment: every required variable set, every other one left to its default. */
const VALID: Environment = {
  DATABASE_URL: 'postgres://scf_app:db-password-1234@127.0.0.1:55432/supercool_test',
  REDIS_URL: 'redis://:redis-password-5678@127.0.0.1:6379',
  JWT_SECRET: 'jwt-secret-for-the-config-unit-tests-000000000000',
  JWT_ISSUER: 'scf-test',
  JWT_AUDIENCE: 'scf-api',
  CURSOR_SECRET: 'cursor-secret-for-the-config-unit-tests-00000000',
};

/**
 * Request and shutdown timeouts long enough for a lock wait of 4999 ms, which the default request
 * timeout cannot hold (SEC-R35), so the environment of those loads stays otherwise valid.
 */
const LONG_REQUESTS = { REQUEST_TIMEOUT_MS: '50000', SHUTDOWN_TIMEOUT_MS: '50000' };

function load(overrides: Record<string, string | undefined>) {
  return loadConfig({ ...VALID, ...overrides });
}

/**
 * The ConfigError a load throws; fails the test when the load succeeds or throws anything else.
 * The composition root's entry point throws the same error, so the app is never built.
 */
function failure(overrides: Record<string, string | undefined>): ConfigError {
  expect(() => buildAppFromEnvironment({ ...VALID, ...overrides })).toThrow(ConfigError);
  try {
    load(overrides);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error(`the load with ${JSON.stringify(Object.keys(overrides))} succeeded`);
}

/** The values every integer variable refuses, whatever its range. */
const NOT_DECIMAL = [
  '-1',
  '+5',
  '0500',
  '1e3',
  '10.5',
  '1,000',
  '1_000',
  'abc',
  '',
  ' 500',
  '500 ',
];

describe('the shared integer rule', () => {
  it('SEC-R39 reads a string of decimal digits without sign or leading zero, as a bigint', () => {
    expect(parseDecimalInteger('0')).toBe(0n);
    expect(parseDecimalInteger('1')).toBe(1n);
    expect(parseDecimalInteger('9223372036854775807')).toBe(9223372036854775807n);
    expect(parseDecimalInteger('99999999999999999999999')).toBe(99999999999999999999999n);
  });

  it('SEC-R39 refuses a sign, a leading zero, an exponent, a separator, spaces and an empty string', () => {
    for (const value of [...NOT_DECIMAL, '00', '0x10', '1 000', '\t5', '5\n', '٣']) {
      expect(parseDecimalInteger(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('SEC-R40 lists every invalid variable by name, with its rule and without its value', () => {
    const error = failure({
      MAX_AMOUNT_MINOR: '0500',
      ACCOUNT_LOCK_TIMEOUT_MS: '7777',
      JWT_ISSUER: '',
      PORT: '65536',
    });
    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      'ACCOUNT_LOCK_TIMEOUT_MS',
      'JWT_ISSUER',
      'MAX_AMOUNT_MINOR',
      'PORT',
    ]);
    for (const { variable, rule } of error.problems) {
      expect(error.message).toContain(variable);
      expect(error.message).toContain(rule);
    }
    expect(error.message).not.toContain('0500');
    expect(error.message).not.toContain('7777');
    expect(error.message).not.toContain('65536');
  });
});

describe('the configuration loader', () => {
  it('SEC-R39 loads the given values of PORT and LOG_LEVEL', () => {
    expect(load({ PORT: '8080', LOG_LEVEL: 'trace' })).toMatchObject({
      port: 8080,
      logLevel: 'trace',
    });
  });

  it('SEC-R39 refuses PORT outside 1 to 65535, an unknown LOG_LEVEL, and a DATABASE_URL that is unset, not postgres or has options', () => {
    for (const [variable, value] of [
      ['PORT', '0'],
      ['PORT', '65536'],
      ['PORT', '3000.0'],
      ['LOG_LEVEL', 'verbose'],
      ['LOG_LEVEL', 'INFO'],
      ['DATABASE_URL', undefined],
      ['DATABASE_URL', 'mysql://x'],
      ['DATABASE_URL', 'not a url'],
      ['DATABASE_URL', 'postgres://u:p@h/db?options=-c%20statement_timeout%3D0'],
    ] as const) {
      const error = failure({ [variable]: value });
      expect(error.problems.map((problem) => problem.variable)).toEqual([variable]);
    }
    expect(load({ DATABASE_URL: 'postgresql://u:p@h:5432/db?sslmode=require' }).databaseUrl).toBe(
      'postgresql://u:p@h:5432/db?sslmode=require',
    );
  });

  it('SEC-R39 accepts in DATABASE_URL only the query parameters sslmode, sslrootcert, application_name and connect_timeout', () => {
    const accepted =
      'postgres://u:p@h:5432/db?sslmode=verify-full&sslrootcert=%2Fcerts%2Frds.pem&application_name=scf&connect_timeout=5';
    expect(load({ DATABASE_URL: accepted }).databaseUrl).toBe(accepted);
    for (const query of [
      'statement_timeout=0',
      'idle_in_transaction_session_timeout=0',
      'lock_timeout=0',
      'options=-c%20statement_timeout%3D0',
      'sslmode=require&statement_timeout=0',
      'SSLMODE=require',
      'ssl=true',
      'host=other',
    ]) {
      const url = `postgres://u:db-pw-7781@h/db?${query}`;
      const error = failure({ DATABASE_URL: url });
      expect(
        error.problems.map((problem) => problem.variable),
        query,
      ).toEqual(['DATABASE_URL']);
      expect(error.message, query).toContain(
        'sslmode, sslrootcert, application_name and connect_timeout',
      );
      expect(error.message, query).not.toContain('db-pw-7781');
      expect(error.message, query).not.toContain(query);
    }
  });

  it('SEC-R39 refuses a set PGOPTIONS by name, never with its value', () => {
    for (const value of ['-c statement_timeout=0', '']) {
      const error = failure({ PGOPTIONS: value });
      expect(error.problems.map((problem) => problem.variable)).toEqual(['PGOPTIONS']);
      expect(error.message).toContain('PGOPTIONS');
      if (value !== '') expect(error.message).not.toContain(value);
    }
    expect(load({ PGOPTIONS: undefined }).databaseUrl).toBe(VALID['DATABASE_URL']);
  });

  it('SEC-R39 refuses a CURSOR_SECRET unset, shorter than 32 bytes or equal to JWT_SECRET, without its value', () => {
    for (const value of [undefined, 'c'.repeat(31), VALID['JWT_SECRET']]) {
      const error = failure({ CURSOR_SECRET: value });
      expect(error.problems.map((problem) => problem.variable)).toEqual(['CURSOR_SECRET']);
      expect(error.message).not.toContain(VALID['JWT_SECRET']);
      if (value !== undefined) expect(error.message).not.toContain(value);
    }
    expect(load({ CURSOR_SECRET: 'c'.repeat(32) }).cursorSecret).toBe('c'.repeat(32));
  });

  it('LED-AC20 loads MAX_AMOUNT_MINOR unset, "500" and the bigint maximum, and refuses every other value by name', () => {
    expect(load({ MAX_AMOUNT_MINOR: undefined }).maxAmountMinor).toBe(100000000000n);
    expect(load({ MAX_AMOUNT_MINOR: '500' }).maxAmountMinor).toBe(500n);
    expect(load({ MAX_AMOUNT_MINOR: '9223372036854775807' }).maxAmountMinor).toBe(
      9223372036854775807n,
    );
    for (const value of [
      '0',
      '-1',
      '+5',
      '0500',
      '1e9',
      '10.5',
      'abc',
      '',
      ' 500',
      '9223372036854775808',
    ]) {
      const error = failure({ MAX_AMOUNT_MINOR: value });
      expect(error.message, JSON.stringify(value)).toContain('MAX_AMOUNT_MINOR');
      expect(error.problems.map((problem) => problem.variable)).toEqual(['MAX_AMOUNT_MINOR']);
    }
  });

  it('MOV-AC20 loads ACCOUNT_LOCK_TIMEOUT_MS unset, "1" and "4999", and refuses every other value by name', () => {
    expect(load({ ACCOUNT_LOCK_TIMEOUT_MS: undefined }).accountLockTimeoutMs).toBe(2000);
    expect(load({ ACCOUNT_LOCK_TIMEOUT_MS: '1' }).accountLockTimeoutMs).toBe(1);
    expect(load({ ACCOUNT_LOCK_TIMEOUT_MS: '4999', ...LONG_REQUESTS }).accountLockTimeoutMs).toBe(
      4999,
    );
    for (const value of [
      '0',
      '5000',
      '-1',
      '+5',
      '0500',
      '1e3',
      '10.5',
      'abc',
      '',
      ' 500',
      '2000ms',
    ]) {
      const error = failure({ ACCOUNT_LOCK_TIMEOUT_MS: value });
      expect(error.message, JSON.stringify(value)).toContain('ACCOUNT_LOCK_TIMEOUT_MS');
      expect(error.problems.map((problem) => problem.variable)).toEqual([
        'ACCOUNT_LOCK_TIMEOUT_MS',
      ]);
    }
  });

  it('IDM-AC25 loads the idempotency wait and TTL at their defaults and bounds, and refuses every other value by name', () => {
    expect(load({}).idempotencyWaitTimeoutMs).toBe(2000);
    expect(load({ IDEMPOTENCY_WAIT_TIMEOUT_MS: '1' }).idempotencyWaitTimeoutMs).toBe(1);
    expect(
      load({ IDEMPOTENCY_WAIT_TIMEOUT_MS: '4999', ...LONG_REQUESTS }).idempotencyWaitTimeoutMs,
    ).toBe(4999);
    expect(load({}).idempotencyKeyTtlSeconds).toBe(86400);
    expect(load({ IDEMPOTENCY_KEY_TTL_SECONDS: '3600' }).idempotencyKeyTtlSeconds).toBe(3600);
    expect(load({ IDEMPOTENCY_KEY_TTL_SECONDS: '2592000' }).idempotencyKeyTtlSeconds).toBe(2592000);
    const invalid = ['0', '-1', '+5', '0500', '1e3', '10.5', 'abc', '', ' 500'];
    for (const [variable, values] of [
      ['IDEMPOTENCY_WAIT_TIMEOUT_MS', [...invalid, '5000']],
      ['IDEMPOTENCY_KEY_TTL_SECONDS', [...invalid, '2592001', '3599']],
    ] as const) {
      for (const value of values) {
        const error = failure({ [variable]: value });
        expect(error.message, `${variable}=${JSON.stringify(value)}`).toContain(variable);
        expect(error.problems.map((problem) => problem.variable)).toEqual([variable]);
      }
    }
  });

  it('AUT-AC15 refuses a weak or missing JWT_SECRET, JWT_ISSUER or JWT_AUDIENCE, naming the variable and never the secret', () => {
    // 15 two-byte characters and one ASCII character: 16 characters, 31 bytes in UTF-8.
    const s31 = `${'é'.repeat(15)}a`;
    // 16 two-byte characters: 32 bytes in UTF-8.
    const s32 = 'é'.repeat(16);
    expect(Buffer.byteLength(s31, 'utf8')).toBe(31);
    expect(Buffer.byteLength(s32, 'utf8')).toBe(32);

    expect(load({ JWT_SECRET: s32 }).jwt.secret).toBe(s32);
    for (const [variable, value] of [
      ['JWT_SECRET', undefined],
      ['JWT_SECRET', 'change-me'],
      ['JWT_SECRET', s31],
      ['JWT_ISSUER', undefined],
      ['JWT_ISSUER', ''],
      ['JWT_AUDIENCE', undefined],
      ['JWT_AUDIENCE', ''],
    ] as const) {
      const error = failure({ [variable]: value });
      expect(error.problems.map((problem) => problem.variable)).toEqual([variable]);
      expect(error.message).toContain(variable);
      expect(error.message).not.toContain('change-me');
      expect(error.message).not.toContain(s31);
    }
  });

  it('AUT-R18 loads the auth section alone, without a database or cursor setting', () => {
    const env = {
      JWT_SECRET: VALID['JWT_SECRET'],
      JWT_ISSUER: 'scf-test',
      JWT_AUDIENCE: 'scf-api',
    };
    expect(loadAuthConfig(env)).toEqual({
      secret: VALID['JWT_SECRET'],
      issuer: 'scf-test',
      audience: 'scf-api',
    });
    expect(() => loadAuthConfig({ ...env, JWT_SECRET: 'change-me' })).toThrow(ConfigError);
  });
});

describe('the configuration of spec 007', () => {
  /** The values of the secrets, which no error may contain. */
  const SECRETS = [
    VALID['DATABASE_URL'],
    'db-password-1234',
    VALID['REDIS_URL'],
    'redis-password-5678',
    VALID['CURSOR_SECRET'],
    VALID['JWT_SECRET'],
  ] as const;

  it('SEC-AC30 loads the defaults of section 1.2, refuses each invalid variable by name with its rule, lists every invalid variable in one error and never holds a secret', () => {
    expect(load({})).toEqual({
      nodeEnv: 'development',
      port: 3000,
      metricsPort: 9464,
      logLevel: 'info',
      databaseUrl: VALID['DATABASE_URL'],
      redisUrl: VALID['REDIS_URL'],
      cursorSecret: VALID['CURSOR_SECRET'],
      maxAmountMinor: 100000000000n,
      accountLockTimeoutMs: 2000,
      idempotencyWaitTimeoutMs: 2000,
      idempotencyKeyTtlSeconds: 86400,
      dbPoolMax: 10,
      dbPoolAcquireTimeoutMs: 2000,
      redisCommandTimeoutMs: 100,
      requestTimeoutMs: 25000,
      shutdownDrainDelayMs: 2000,
      shutdownTimeoutMs: 30000,
      rateLimitUserMax: 300,
      rateLimitUserWindowSeconds: 10,
      trustedProxyCidrs: [],
      corsOrigins: [],
      replicaId: undefined,
      migrationDatabaseUrl: undefined,
      jwt: { secret: VALID['JWT_SECRET'], issuer: 'scf-test', audience: 'scf-api' },
    });

    const cases: [Record<string, string | undefined>, string, string][] = [
      [{ PORT: '0' }, 'PORT', 'from 1 to 65535'],
      [{ PORT: '65536' }, 'PORT', 'from 1 to 65535'],
      [{ METRICS_PORT: '3000' }, 'METRICS_PORT', 'different from PORT'],
      [{ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL', 'one of fatal, error, warn, info, debug, trace'],
      [{ NODE_ENV: 'staging' }, 'NODE_ENV', 'one of development, test, production'],
      [{ DATABASE_URL: undefined }, 'DATABASE_URL', 'a postgres:// or postgresql:// URL'],
      [{ DATABASE_URL: 'mysql://x' }, 'DATABASE_URL', 'a postgres:// or postgresql:// URL'],
      [
        { DATABASE_URL: `${VALID['DATABASE_URL'] ?? ''}?options=-c%20statement_timeout%3D0` },
        'DATABASE_URL',
        'whose only query parameters are sslmode, sslrootcert, application_name and connect_timeout',
      ],
      [
        { DATABASE_URL: `${VALID['DATABASE_URL'] ?? ''}?statement_timeout=0` },
        'DATABASE_URL',
        'whose only query parameters are sslmode, sslrootcert, application_name and connect_timeout',
      ],
      [{ PGOPTIONS: '-c statement_timeout=0' }, 'PGOPTIONS', 'unset'],
      [{ REDIS_URL: 'http://x' }, 'REDIS_URL', 'a redis:// or rediss:// URL'],
      [{ CURSOR_SECRET: 'c'.repeat(31) }, 'CURSOR_SECRET', 'at least 32 bytes in UTF-8'],
      [{ CURSOR_SECRET: VALID['JWT_SECRET'] }, 'CURSOR_SECRET', 'different from JWT_SECRET'],
      [{ DB_POOL_MAX: '0' }, 'DB_POOL_MAX', 'from 1 to 100'],
      [{ DB_POOL_MAX: '101' }, 'DB_POOL_MAX', 'from 1 to 100'],
      [{ RATE_LIMIT_USER_MAX: '0' }, 'RATE_LIMIT_USER_MAX', 'from 1 to 1000000'],
      [{ RATE_LIMIT_USER_WINDOW_S: '3601' }, 'RATE_LIMIT_USER_WINDOW_S', 'from 1 to 3600'],
      [
        { TRUSTED_PROXY_CIDRS: '10.0.0.0/33' },
        'TRUSTED_PROXY_CIDRS',
        'comma-separated IPv4 or IPv6 CIDR blocks, or empty',
      ],
      [{ CORS_ORIGINS: '*' }, 'CORS_ORIGINS', 'comma-separated origins'],
      [
        { NODE_ENV: 'production', CORS_ORIGINS: 'http://app.example' },
        'CORS_ORIGINS',
        'http:// only when NODE_ENV is not production',
      ],
      [{ REPLICA_ID: '' }, 'REPLICA_ID', '1 to 64 characters of A-Z a-z 0-9 . _ -'],
      [{ REPLICA_ID: 'a'.repeat(65) }, 'REPLICA_ID', '1 to 64 characters of A-Z a-z 0-9 . _ -'],
      [{ REPLICA_ID: 'api 1' }, 'REPLICA_ID', '1 to 64 characters of A-Z a-z 0-9 . _ -'],
      [{ REPLICA_ID: 'api/1' }, 'REPLICA_ID', '1 to 64 characters of A-Z a-z 0-9 . _ -'],
      [
        { MIGRATION_DATABASE_URL: 'mysql://x' },
        'MIGRATION_DATABASE_URL',
        'a postgres:// or postgresql:// URL',
      ],
    ];
    for (const [overrides, variable, rule] of cases) {
      const label = JSON.stringify(overrides);
      const error = failure(overrides);
      expect(
        error.problems.map((problem) => problem.variable),
        label,
      ).toEqual([variable]);
      expect(error.message, label).toContain(variable);
      expect(error.message, label).toContain(rule);
      for (const secret of SECRETS) expect(error.message, label).not.toContain(secret);
    }

    const migrationUrl = 'postgres://scf_owner:owner-pw-4321@127.0.0.1:55432/supercool_test';
    expect(load({ REPLICA_ID: 'api-1', MIGRATION_DATABASE_URL: undefined })).toMatchObject({
      replicaId: 'api-1',
      migrationDatabaseUrl: undefined,
    });
    expect(load({ MIGRATION_DATABASE_URL: migrationUrl }).migrationDatabaseUrl).toBe(migrationUrl);

    const both = failure({ PORT: '0', DB_POOL_MAX: 'abc' });
    expect(both.problems.map((problem) => problem.variable).sort()).toEqual([
      'DB_POOL_MAX',
      'PORT',
    ]);
    expect(both.message).toContain('PORT must be');
    expect(both.message).toContain('DB_POOL_MAX must be');
    for (const secret of SECRETS) expect(both.message).not.toContain(secret);
  });

  it('SEC-R39 SEC-R40 compares METRICS_PORT with PORT also at its default, so PORT 9464 alone is refused naming METRICS_PORT', () => {
    const error = failure({ PORT: '9464', METRICS_PORT: undefined });
    expect(error.problems.map((problem) => problem.variable)).toEqual(['METRICS_PORT']);
    expect(error.message).toContain('METRICS_PORT must be');
    expect(error.message).toContain('different from PORT');
    expect(load({ PORT: '9464', METRICS_PORT: '9100' })).toMatchObject({
      port: 9464,
      metricsPort: 9100,
    });
    // An invalid PORT is reported once, by its own rule, not as a clash with METRICS_PORT.
    expect(failure({ PORT: 'abc' }).problems.map((problem) => problem.variable)).toEqual(['PORT']);
  });

  it('SEC-R39 reads the lists of TRUSTED_PROXY_CIDRS and CORS_ORIGINS, and the values of every other variable of section 1.2', () => {
    expect(
      load({
        NODE_ENV: 'production',
        PORT: '8080',
        METRICS_PORT: '9100',
        DB_POOL_MAX: '100',
        DB_POOL_ACQUIRE_TIMEOUT_MS: '60000',
        REDIS_COMMAND_TIMEOUT_MS: '5000',
        REQUEST_TIMEOUT_MS: '120000',
        SHUTDOWN_DRAIN_DELAY_MS: '0',
        SHUTDOWN_TIMEOUT_MS: '120000',
        RATE_LIMIT_USER_MAX: '1000000',
        RATE_LIMIT_USER_WINDOW_S: '3600',
        TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 172.16.0.0/12,fd00::/8,192.168.1.9/32',
        CORS_ORIGINS: 'https://app.example,https://admin.example:8443',
        REDIS_URL: 'rediss://cache.example:6380',
        DATABASE_URL: 'postgresql://u:p@h/db',
      }),
    ).toMatchObject({
      nodeEnv: 'production',
      port: 8080,
      metricsPort: 9100,
      dbPoolMax: 100,
      dbPoolAcquireTimeoutMs: 60000,
      redisCommandTimeoutMs: 5000,
      requestTimeoutMs: 120000,
      shutdownDrainDelayMs: 0,
      shutdownTimeoutMs: 120000,
      rateLimitUserMax: 1000000,
      rateLimitUserWindowSeconds: 3600,
      trustedProxyCidrs: ['10.0.0.0/8', '172.16.0.0/12', 'fd00::/8', '192.168.1.9/32'],
      corsOrigins: ['https://app.example', 'https://admin.example:8443'],
      redisUrl: 'rediss://cache.example:6380',
    });
    expect(load({ TRUSTED_PROXY_CIDRS: '', CORS_ORIGINS: '' })).toMatchObject({
      trustedProxyCidrs: [],
      corsOrigins: [],
    });
    expect(load({ CORS_ORIGINS: 'http://localhost:5173' }).corsOrigins).toEqual([
      'http://localhost:5173',
    ]);
    for (const value of ['10.0.0.0', '10.0.0.0/', '10.0.0.0/08', '10.0.0/8', 'fd00::/129', 'x/8']) {
      expect(failure({ TRUSTED_PROXY_CIDRS: value }).problems[0]?.variable, value).toBe(
        'TRUSTED_PROXY_CIDRS',
      );
    }
    for (const value of [
      'https://app.example/',
      'https://app.example/path',
      'https://user@app.example',
      'https://App.example',
      'ftp://app.example',
      'https://app.example,*',
      'app.example',
    ]) {
      expect(failure({ CORS_ORIGINS: value }).problems[0]?.variable, value).toBe('CORS_ORIGINS');
    }
    for (const [variable, value] of [
      ['DB_POOL_ACQUIRE_TIMEOUT_MS', '60001'],
      ['REDIS_COMMAND_TIMEOUT_MS', '0'],
      ['REQUEST_TIMEOUT_MS', '120001'],
      ['SHUTDOWN_DRAIN_DELAY_MS', '60001'],
      ['SHUTDOWN_TIMEOUT_MS', '120001'],
      ['REDIS_URL', undefined],
    ] as const) {
      expect(failure({ [variable]: value }).problems[0]?.variable, variable).toBe(variable);
    }
  });
});
