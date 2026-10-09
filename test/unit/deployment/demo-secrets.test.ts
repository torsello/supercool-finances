import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEMO_SECRETS,
  loadConfig,
  type Environment,
} from '../../../src/platform/config/config.js';
import { readCompose } from '../../support/deployment.js';

/** The demo values of `compose.yaml`, read from every service that sets them. */
function composeDemoValue(variable: 'JWT_SECRET' | 'CURSOR_SECRET'): string {
  const values = new Set(
    readCompose()
      .services.map((service) => service.rawEnvironment[variable])
      .filter((value) => value !== undefined),
  );
  expect(values.size, `${variable} has one value in compose.yaml`).toBe(1);
  const [value] = values;
  if (value === undefined) throw new Error(`compose.yaml sets no ${variable}`);
  return value;
}

const BASE: Environment = {
  DATABASE_URL: 'postgres://scf_app:db-password-1234@127.0.0.1:55432/supercool_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_ISSUER: 'scf-test',
  JWT_AUDIENCE: 'scf-api',
};

/** Two other 48-byte values. */
const OTHER_JWT_SECRET = 'other-jwt-secret-of-48-bytes-for-production-0000';
const OTHER_CURSOR_SECRET = 'other-cursor-secret-of-48-bytes-for-production00';

function failure(env: Environment): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('the load succeeded');
}

describe('the demo secrets', () => {
  it('DEP-AC05 the demo JWT_SECRET and CURSOR_SECRET of compose.yaml, each its own or the other, are refused in production, by name and never by value, and accepted in development', () => {
    const jwtDemo = composeDemoValue('JWT_SECRET');
    const cursorDemo = composeDemoValue('CURSOR_SECRET');
    // The loader's list is the values of compose.yaml.
    expect(DEMO_SECRETS).toEqual({ JWT_SECRET: jwtDemo, CURSOR_SECRET: cursorDemo });
    expect(Buffer.byteLength(OTHER_JWT_SECRET)).toBe(48);
    expect(Buffer.byteLength(OTHER_CURSOR_SECRET)).toBe(48);

    const jwt = failure({
      ...BASE,
      NODE_ENV: 'production',
      JWT_SECRET: jwtDemo,
      CURSOR_SECRET: OTHER_CURSOR_SECRET,
    });
    expect(jwt.problems.map((problem) => problem.variable)).toEqual(['JWT_SECRET']);
    expect(jwt.message).toContain('JWT_SECRET');

    const cursor = failure({
      ...BASE,
      NODE_ENV: 'production',
      JWT_SECRET: OTHER_JWT_SECRET,
      CURSOR_SECRET: cursorDemo,
    });
    expect(cursor.problems.map((problem) => problem.variable)).toEqual(['CURSOR_SECRET']);
    expect(cursor.message).toContain('CURSOR_SECRET');

    // Each variable is refused with either demo value, the other's included.
    const swappedJwt = failure({
      ...BASE,
      NODE_ENV: 'production',
      JWT_SECRET: cursorDemo,
      CURSOR_SECRET: OTHER_CURSOR_SECRET,
    });
    expect(swappedJwt.problems.map((problem) => problem.variable)).toEqual(['JWT_SECRET']);
    const swappedCursor = failure({
      ...BASE,
      NODE_ENV: 'production',
      JWT_SECRET: OTHER_JWT_SECRET,
      CURSOR_SECRET: jwtDemo,
    });
    expect(swappedCursor.problems.map((problem) => problem.variable)).toEqual(['CURSOR_SECRET']);
    const swappedBoth = failure({
      ...BASE,
      NODE_ENV: 'production',
      JWT_SECRET: cursorDemo,
      CURSOR_SECRET: jwtDemo,
    });
    expect(swappedBoth.problems.map((problem) => problem.variable)).toEqual([
      'JWT_SECRET',
      'CURSOR_SECRET',
    ]);

    for (const error of [jwt, cursor, swappedJwt, swappedCursor, swappedBoth]) {
      expect(error.message).not.toContain(jwtDemo);
      expect(error.message).not.toContain(cursorDemo);
      expect(JSON.stringify(error.problems)).not.toContain(jwtDemo);
      expect(JSON.stringify(error.problems)).not.toContain(cursorDemo);
    }

    expect(
      loadConfig({
        ...BASE,
        NODE_ENV: 'development',
        JWT_SECRET: jwtDemo,
        CURSOR_SECRET: cursorDemo,
      }).jwt.secret,
    ).toBe(jwtDemo);
    expect(
      loadConfig({
        ...BASE,
        NODE_ENV: 'production',
        JWT_SECRET: OTHER_JWT_SECRET,
        CURSOR_SECRET: OTHER_CURSOR_SECRET,
      }).cursorSecret,
    ).toBe(OTHER_CURSOR_SECRET);
  });
});
