import { buildApp, type AppOptions } from '../../src/app.js';
import { loadConfig, type Config, type Environment } from '../../src/platform/config/config.js';
import { requireEnv } from './env.js';
import { LogCapture } from './logs.js';
import { K, TEST_AUDIENCE, TEST_ISSUER } from './tokens.js';

/** The test value of `CURSOR_SECRET`: 48 bytes, different from K. */
export const TEST_CURSOR_SECRET = 'test-only-cursor-secret-for-unit-and-integration';

/**
 * The environment every test app runs with (section 3 of spec 006): the test token settings, the
 * test cursor secret and the shared test database, with `overrides` on top. A variable set to
 * `undefined` in `overrides` is unset.
 */
export function testEnvironment(overrides: Environment = {}): Environment {
  return {
    DATABASE_URL: requireEnv('TEST_DATABASE_URL'),
    JWT_SECRET: K,
    JWT_ISSUER: TEST_ISSUER,
    JWT_AUDIENCE: TEST_AUDIENCE,
    CURSOR_SECRET: TEST_CURSOR_SECRET,
    LOG_LEVEL: 'info',
    ...overrides,
  };
}

/** The configuration of a test app, through the service's own loader. */
export function testConfig(overrides: Environment = {}): Config {
  return loadConfig(testEnvironment(overrides));
}

export interface BuiltApp {
  app: ReturnType<typeof buildApp>;
  logs: LogCapture;
}

/**
 * The production app, built by the composition root with the test configuration and without test
 * seams, its log output captured. The caller closes it.
 */
export function buildProductionApp(
  options: { env?: Environment; app?: Omit<AppOptions, 'logStream' | 'seams'> } = {},
): BuiltApp {
  const logs = new LogCapture();
  const app = buildApp(testConfig(options.env), { ...options.app, logStream: logs.stream });
  return { app, logs };
}
