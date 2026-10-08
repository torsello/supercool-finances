import { defineConfig } from 'vitest/config';
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
    ],
  },
});
