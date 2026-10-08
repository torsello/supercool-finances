import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

const domainBoundary =
  'Domain code never imports infrastructure (AGENTS.md, hexagonal architecture): use a port.';
const applicationBoundary =
  'Application code never imports infrastructure or adapters (ADR-0010): declare a port.';
const moduleBoundary = 'Import another module only through its index.ts (ADR-0010).';
const noFloats = 'Money is integer minor units; never parse floats.';
const noNumbers =
  'Domain and application code keep amounts as bigint: never convert to number (ADR-0006).';
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
const forbiddenInApplication = ['fastify', 'kysely', 'pg', 'ioredis'];

/** Packages and their subpaths, for no-restricted-imports. */
function packages(names, message) {
  return {
    paths: names.map((name) => ({ name, message })),
    patterns: [{ group: [...names.map((name) => `${name}/*`), '@fastify/*'], message }],
  };
}

/** The modules of AGENTS.md section 6. Another directory under src/modules/ gets the same rules. */
const MODULES = ['accounts', 'ledger', 'movements', 'idempotency', 'auth'];

/**
 * Another module's layers, reached by climbing out of this one (`../../ledger/domain/...`) or
 * through `modules/` (`../../../modules/ledger/domain/...`). The module named `own`, whose files
 * the rule applies to, may reach its own layers either way. A module's index.ts is its public API
 * and stays importable.
 */
function otherModuleInternals(own) {
  const notOwn = own === undefined ? '' : `(?!${own}/)`;
  return [
    {
      regex: `^(\\.\\./)+${notOwn}[^./][^/]*/(domain|application|adapters)(/|$)`,
      message: moduleBoundary,
    },
    {
      regex: `(^|/)modules/${notOwn}[^/]+/(domain|application|adapters)(/|$)`,
      message: moduleBoundary,
    },
  ];
}

/**
 * What use cases may import from `platform/`, as paths under it. The application layer declares
 * ports, and adapters implement them with the platform; the only exception is the typed errors of
 * `db/errors.js`, which import nothing, so the idempotent runner can end a request with
 * `IdempotencyWaitTimeout` when its key-wait deadline has passed (plan 005 section 3).
 */
const PLATFORM_FOR_APPLICATION = ['db/errors.js'];
const platformInApplication = {
  regex: `(^|/)platform/${PLATFORM_FOR_APPLICATION.map((path) => `(?!${path.replaceAll('.', '\\.')}$)`).join('')}`,
  message: applicationBoundary,
};

const domainImports = packages(forbiddenInDomain, domainBoundary);
const applicationImports = packages(forbiddenInApplication, applicationBoundary);

const floatGlobals = [{ name: 'parseFloat', message: noFloats }];
const floatProperties = [{ object: 'Number', property: 'parseFloat', message: noFloats }];

/**
 * The import rules of one module's layers (ADR-0003, ADR-0010); `own` undefined gives the rules of
 * any module, without the exception for its own layers.
 */
function moduleImportRules(own) {
  const root = `src/modules/${own ?? '*'}`;
  return [
    {
      files: [`${root}/domain/**`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: domainImports.paths,
            patterns: [
              ...domainImports.patterns,
              {
                // Any specifier with an adapters/ or platform/ segment, relative paths included.
                regex: '(^|/)(adapters|platform)(/|$)',
                message: domainBoundary,
              },
              ...otherModuleInternals(own),
            ],
          },
        ],
      },
    },
    {
      files: [`${root}/application/**`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: applicationImports.paths,
            patterns: [
              ...applicationImports.patterns,
              { regex: '(^|/)adapters(/|$)', message: applicationBoundary },
              platformInApplication,
              ...otherModuleInternals(own),
            ],
          },
        ],
      },
    },
    {
      files: [`${root}/adapters/**`],
      rules: {
        'no-restricted-imports': ['error', { patterns: otherModuleInternals(own) }],
      },
    },
  ];
}

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
      'no-restricted-globals': ['error', ...floatGlobals],
      'no-restricted-properties': ['error', ...floatProperties],
    },
  },
  {
    // ADR-0006: no conversion to number where money rules live.
    files: ['src/modules/*/domain/**', 'src/modules/*/application/**'],
    rules: {
      'no-restricted-globals': ['error', ...floatGlobals, { name: 'parseInt', message: noNumbers }],
      'no-restricted-properties': [
        'error',
        ...floatProperties,
        { object: 'Number', property: 'parseInt', message: noNumbers },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.name='Number']", message: noNumbers },
        { selector: "NewExpression[callee.name='Number']", message: noNumbers },
        { selector: "CallExpression > Identifier.arguments[name='Number']", message: noNumbers },
        { selector: "UnaryExpression[operator='+']", message: noNumbers },
        { selector: "VariableDeclarator > Identifier.init[name='Number']", message: noNumbers },
      ],
    },
  },
  ...moduleImportRules(undefined),
  ...MODULES.flatMap(moduleImportRules),
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
