import { defineConfig } from 'vitest/config';

// Runs the sample tests with the real setup file, for test/unit/forbid-fails.test.ts.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['samples.test.ts'],
    setupFiles: ['../../setup/forbid-fails.ts'],
  },
});
