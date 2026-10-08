import { describe, expect, it } from 'vitest';
import { buildAppFromEnvironment } from '../../../src/app.js';
import {
  ConfigError,
  loadAuthConfig,
  loadConfig,
  parseDecimalInteger,
  type Environment,
} from '../../../src/platform/config/config.js';

/** A valid environment for every variable the loader reads in 08-api. */
const VALID: Environment = {
  DATABASE_URL: 'postgres://scf_app:db-password-1234@127.0.0.1:55432/supercool_test',
  JWT_SECRET: 'jwt-secret-for-the-config-unit-tests-000000000000',
  JWT_ISSUER: 'scf-test',
  JWT_AUDIENCE: 'scf-api',
  CURSOR_SECRET: 'cursor-secret-for-the-config-unit-tests-00000000',
};

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
  it('SEC-R39 loads the defaults of PORT, LOG_LEVEL and the timeouts, and the given values', () => {
    const config = load({});
    expect(config).toEqual({
      port: 3000,
      logLevel: 'info',
      databaseUrl: VALID['DATABASE_URL'],
      cursorSecret: VALID['CURSOR_SECRET'],
      maxAmountMinor: 100000000000n,
      accountLockTimeoutMs: 2000,
      idempotencyWaitTimeoutMs: 2000,
      idempotencyKeyTtlSeconds: 86400,
      jwt: { secret: VALID['JWT_SECRET'], issuer: 'scf-test', audience: 'scf-api' },
    });
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
    expect(load({ ACCOUNT_LOCK_TIMEOUT_MS: '4999' }).accountLockTimeoutMs).toBe(4999);
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
    expect(load({ IDEMPOTENCY_WAIT_TIMEOUT_MS: '4999' }).idempotencyWaitTimeoutMs).toBe(4999);
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
