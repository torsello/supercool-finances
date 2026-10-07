import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

const domainBoundary =
  'Domain code never imports infrastructure (AGENTS.md, hexagonal architecture): use a port.';
const noFloats = 'Money is integer minor units; never parse floats.';
const forbiddenInDomain = [
  'fastify',
  'kysely',
  'pg',
  'ioredis',
  'node-pg-migrate',
  'jose',
  'close-with-grace',
  '@prometheus-io/client',
];

export default defineConfig(
  globalIgnores(['dist/', 'coverage/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],
      'no-restricted-globals': ['error', { name: 'parseFloat', message: noFloats }],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: noFloats },
      ],
    },
  },
  {
    files: ['src/modules/*/domain/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: forbiddenInDomain.map((name) => ({ name, message: domainBoundary })),
          patterns: [
            {
              group: [...forbiddenInDomain.map((name) => `${name}/*`), '@fastify/*'],
              message: domainBoundary,
            },
            {
              // Any specifier with an adapters/ or platform/ segment, relative paths included.
              regex: '(^|/)(adapters|platform)(/|$)',
              message: domainBoundary,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
