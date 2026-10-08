import { defineConfig } from 'vitest/config';
import { TEST_GUARDS } from '../../../vitest.shared.js';

// Runs the sample tests with the same guards as the real projects, for
// test/unit/test-guards.test.ts.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['samples.test.ts'],
    ...TEST_GUARDS,
  },
});
