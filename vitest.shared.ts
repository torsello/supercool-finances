import { fileURLToPath } from 'node:url';

/**
 * Guards shared by every Vitest project and by the fixture that proves them
 * (test/unit/test-guards.test.ts). npm run trace counts a passing test as proof of the AC it
 * names, so a test that asserts nothing, or that is marked fails, must never pass.
 */
export const TEST_GUARDS = {
  setupFiles: [fileURLToPath(new URL('./test/setup/forbid-fails.ts', import.meta.url))],
  expect: { requireAssertions: true },
};
