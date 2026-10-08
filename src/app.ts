import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { accountRoutes } from './modules/accounts/adapters/http/routes.js';
import { CursorCodec } from './modules/accounts/adapters/http/cursor.js';
import {
  KyselyAccountQueries,
  KyselyAccountRepository,
  KyselyAccountTransactions,
} from './modules/accounts/adapters/persistence/kysely-accounts.js';
import { registerAuthentication } from './modules/auth/adapters/http/authenticate.js';
import { registerAuthorization } from './modules/auth/adapters/http/authorize.js';
import { loadConfig, type Config, type Environment } from './platform/config/config.js';
import { createDatabase, createPool } from './platform/db/database.js';
import { TransactionRunner } from './platform/db/transaction-runner.js';
import { UnitOfWorkRunner, type UnitOfWorkFaults } from './platform/db/unit-of-work.js';
import {
  clientErrorHandler,
  handleFrameworkError,
  MAX_PARAM_LENGTH,
} from './platform/http/framework-errors.js';
import { registerRoutes, type RouteModule } from './platform/http/routes.js';
import { UuidV7Generator } from './platform/ids/uuid-v7.js';
import { loggerOptions, type LogDestination } from './platform/logging/logger.js';

export type { RouteModule } from './platform/http/routes.js';

/**
 * The hook points of the test seams of SYS-R37. Only the test app sets them, from its one list in
 * `test/support/test-app.ts`; the production app never does (plan 000 section 8). Each 08-api step
 * that builds a component with a hook point adds it here.
 */
export interface TestSeams {
  /** `unit-of-work-faults`: the unit of work's fault hook (plan 000 section 8). */
  unitOfWorkFaults?: UnitOfWorkFaults;
  /** `throwing-route`: a route registered under `/v1` with the module routes. */
  throwingRoute?: RouteModule;
}

export interface AppOptions {
  /** Where log lines go instead of standard output; tests capture them. */
  logStream?: LogDestination;
  /** The clock of token verification, in milliseconds since the epoch. */
  clock?: () => number;
  /** Set only by the test app. */
  seams?: TestSeams;
}

const liveResponse = z.object({ status: z.literal('ok') });

/**
 * The composition root (plan 000 section 2, ADR-0003): builds the app from a parsed configuration,
 * so an invalid one never builds an app, and wires the adapters. Module routes are served under
 * `/v1` behind authentication and the role check (SYS-R31, SYS-R43); the health check is outside
 * it and never reads credentials (AUT-R20).
 */
export function buildApp(config: Config, options: AppOptions = {}) {
  const app = Fastify({
    logger: loggerOptions(config.logLevel, options.logStream),
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
    frameworkErrors: handleFrameworkError,
    clientErrorHandler: clientErrorHandler(),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const pool = createPool({ connectionString: config.databaseUrl, logger: app.log });
  const db = createDatabase(pool);
  app.addHook('onClose', async () => {
    await db.destroy();
  });
  const ids = new UuidV7Generator();
  const unitOfWork = new UnitOfWorkRunner(new TransactionRunner({ pool }), {
    ...(options.seams?.unitOfWorkFaults === undefined
      ? {}
      : { faults: options.seams.unitOfWorkFaults }),
  });

  app.get(
    '/health/live',
    { schema: { response: { 200: liveResponse } } },
    () => ({ status: 'ok' }) as const,
  );

  const modules: RouteModule[] = [
    accountRoutes({
      repository: new KyselyAccountRepository(db),
      ids,
      queries: new KyselyAccountQueries(db),
      transactions: new KyselyAccountTransactions(unitOfWork, ids),
      cursors: new CursorCodec(config.cursorSecret),
      accountLockTimeoutMs: config.accountLockTimeoutMs,
    }),
  ];
  if (options.seams?.throwingRoute !== undefined) modules.push(options.seams.throwingRoute);

  registerRoutes(app, {
    protect: (scope) => {
      registerAuthentication(scope, config.jwt, options.clock);
      registerAuthorization(scope);
    },
    modules,
  });

  return app;
}

/**
 * Loads the configuration from `env` and builds the app; an invalid configuration throws its
 * `ConfigError` before anything is built or connected (SEC-R39, AUT-R18).
 */
export function buildAppFromEnvironment(env: Environment, options: AppOptions = {}) {
  return buildApp(loadConfig(env), options);
}
