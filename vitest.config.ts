import { defineConfig } from 'vitest/config';
import { E2eSequencer } from './test/e2e/support/sequencer.js';
import { TEST_GUARDS } from './vitest.shared.js';

// Local runs read .env; CI passes real environment variables instead and has no .env file.
try {
  process.loadEnvFile('.env');
} catch (error) {
  // Only a missing .env is expected; a malformed or unreadable one must surface.
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

export default defineConfig({
  test: {
    // The e2e files run in the order of plan 008 section 5; the other projects keep Vitest's own.
    sequence: { sequencer: E2eSequencer },
    // The e2e global teardown removes the stack, which takes longer than the default 10 s.
    teardownTimeout: 300_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          ...TEST_GUARDS,
          include: ['test/unit/**/*.test.ts', 'src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          ...TEST_GUARDS,
          globalSetup: ['test/integration/global-setup.ts'],
          include: ['test/integration/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'e2e',
          ...TEST_GUARDS,
          // Against the Docker Compose stack, which the suite starts and stops itself under the
          // project scf-e2e (plan 008 section 5): one file at a time, since they share it.
          globalSetup: ['test/e2e/support/global-setup.ts'],
          include: ['test/e2e/**/*.test.ts'],
          fileParallelism: false,
          // Loose bounds: Docker may run inside a VM, where a build or a restart takes minutes.
          testTimeout: 600_000,
          hookTimeout: 1_200_000,
        },
      },
    ],
  },
});
