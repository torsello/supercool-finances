import { defineConfig } from 'vitest/config';

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
          setupFiles: ['test/setup/forbid-fails.ts'],
          include: ['test/unit/**/*.test.ts', 'src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          setupFiles: ['test/setup/forbid-fails.ts'],
          include: ['test/integration/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
