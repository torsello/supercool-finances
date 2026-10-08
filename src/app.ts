import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ACCOUNT_OPERATION_DOCS } from './modules/accounts/adapters/http/openapi.js';
import { accountRoutes } from './modules/accounts/adapters/http/routes.js';
import { CursorCodec } from './modules/accounts/adapters/http/cursor.js';
import {
  KyselyAccountQueries,
  KyselyAccountRepository,
  KyselyAccountTransactions,
} from './modules/accounts/adapters/persistence/kysely-accounts.js';
import { callerOf, registerAuthentication } from './modules/auth/adapters/http/authenticate.js';
import { registerAuthorization } from './modules/auth/adapters/http/authorize.js';
import {
  KeyedHandler,
  type AfterCommitHook,
  type KeyedHandlerTestHook,
  type ResponseBodyHook,
} from './modules/idempotency/adapters/http/keyed-handler.js';
import { KyselyKeyedTransactions } from './modules/idempotency/adapters/persistence/kysely-key-store.js';
import { IdempotentRunner } from './modules/idempotency/index.js';
import { KyselyLedgerWriter } from './modules/ledger/adapters/persistence/kysely-ledger.js';
import { MOVEMENT_OPERATION_DOCS } from './modules/movements/adapters/http/openapi.js';
import { movementRoutes } from './modules/movements/adapters/http/routes.js';
import {
  KyselyTransactionQueries,
  movementTransactionOn,
  type MovementDependencies,
} from './modules/movements/adapters/persistence/kysely-movements.js';
import {
  Reversals,
  type MovementTransaction,
  type ReversalTestHook,
  type SkipExistingReversalCheck,
} from './modules/movements/index.js';
import { loadConfig, type Config, type Environment } from './platform/config/config.js';
import { createDatabase, createPool } from './platform/db/database.js';
import { TransactionRunner } from './platform/db/transaction-runner.js';
import {
  UnitOfWorkRunner,
  type UnitOfWorkFaults,
  type UnitOfWorkTestHook,
} from './platform/db/unit-of-work.js';
import {
  clientErrorHandler,
  handleFrameworkError,
  MAX_PARAM_LENGTH,
} from './platform/http/framework-errors.js';
import { BODY_LIMIT_BYTES, registerBodyLimits } from './platform/http/body-limits.js';
import { registerCors } from './platform/http/cors.js';
import { DOCS_PREFIX, registerDocs } from './platform/http/docs.js';
import { registerRateLimitStore, registerUserRateLimit } from './platform/http/rate-limit.js';
import { registerRequestId, requestIdOf } from './platform/http/request-id.js';
import { registerRoutes, type RouteModule } from './platform/http/routes.js';
import { registerSecurityHeaders } from './platform/http/security-headers.js';
import { trustProxy } from './platform/http/trust-proxy.js';
import { UuidV7Generator } from './platform/ids/uuid-v7.js';
import { loggerOptions, type LogDestination } from './platform/logging/logger.js';
import { Metrics, MetricsServer, registerRequestMetrics } from './platform/metrics/metrics.js';
import {
  connectRedis,
  createRedis,
  disconnectRedis,
  RedisAvailability,
} from './platform/redis/redis.js';

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
  /** `extra-response-member`: the keyed handler's hook on every new response body. */
  responseBody?: ResponseBodyHook;
  /** `destroy-connection-after-commit`: the keyed handler's hook after a commit. */
  afterCommit?: AfterCommitHook;
  /** `skip-existing-reversal-check`: the reversal use case's hook (plan 004 section 1). */
  skipExistingReversalCheck?: SkipExistingReversalCheck;
}

/** The name of a test seam of SYS-R37. */
export type TestSeamName =
  UnitOfWorkTestHook | 'throwing-route' | ReversalTestHook | KeyedHandlerTestHook;

/** The seams attached to each component with a hook point (plan 000 section 8). */
export interface AttachedTestHooks {
  unitOfWork: UnitOfWorkTestHook[];
  reversals: ReversalTestHook[];
  responseHandling: KeyedHandlerTestHook[];
  connectionHandling: KeyedHandlerTestHook[];
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The names of the test seams `buildApp` attached: none in the production app (SYS-R37). */
    testSeams: readonly TestSeamName[];
    /** The seams attached to each component with a hook point, read from the components. */
    attachedTestHooks(): AttachedTestHooks;
    /** The metrics of section 1.4 of spec 007. */
    metrics: Metrics;
    /** The server of `/metrics` on `METRICS_PORT`, started by `listen` (SEC-R41). */
    metricsServer: MetricsServer;
  }
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

/** Every API route is served under this prefix (SYS-R43). */
const API_PREFIX = '/v1';

/**
 * The composition root (plan 000 section 2, ADR-0003): builds the app from a parsed configuration,
 * so an invalid one never builds an app, and wires the adapters. Every response carries the
 * security headers of spec 007 and, for configured origins only, CORS headers; bodies are limited
 * to JSON of 16384 bytes. Module routes are served under `/v1` behind authentication, the per-user
 * rate limit and the role check (SYS-R31, SYS-R43, section 1.3 of spec 007); the health check is
 * outside it and never reads credentials (AUT-R20). Nothing listens until `listen` is called.
 */
export function buildApp(config: Config, options: AppOptions = {}) {
  const app = Fastify({
    logger: loggerOptions({
      level: config.logLevel,
      secrets: {
        jwtSecret: config.jwt.secret,
        cursorSecret: config.cursorSecret,
        databaseUrl: config.databaseUrl,
        redisUrl: config.redisUrl,
      },
      ...(options.logStream === undefined ? {} : { destination: options.logStream }),
    }),
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
    requestIdHeader: false,
    genReqId: requestIdOf,
    frameworkErrors: handleFrameworkError,
    clientErrorHandler: clientErrorHandler(),
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: trustProxy(config.trustedProxyCidrs),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerRequestId(app);
  registerSecurityHeaders(app, { docsPrefix: DOCS_PREFIX, apiPrefix: API_PREFIX });
  registerCors(app, config.corsOrigins);
  registerBodyLimits(app);

  const pool = createPool({ connectionString: config.databaseUrl, logger: app.log });
  const db = createDatabase(pool);
  const metrics = new Metrics({ pool });
  const metricsServer = new MetricsServer(metrics);
  app.decorate('metrics', metrics);
  app.decorate('metricsServer', metricsServer);
  registerRequestMetrics(app, metrics);

  // Redis holds nothing but the per-user counters (SEC-R07): the service starts and serves while
  // it is down, and the limit fails open (SEC-R06).
  const redis = createRedis({
    url: config.redisUrl,
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  const redisAvailability = new RedisAvailability(app.log);
  redisAvailability.watch(redis);
  registerRateLimitStore(app, {
    redis,
    max: config.rateLimitUserMax,
    windowSeconds: config.rateLimitUserWindowSeconds,
    userOf: (request) => callerOf(request).userId,
  });
  app.addHook('onReady', async () => {
    await connectRedis(redis, config.redisCommandTimeoutMs);
  });

  app.addHook('onClose', async () => {
    await metricsServer.close();
    disconnectRedis(redis);
    await db.destroy();
  });
  const ids = new UuidV7Generator();
  const unitOfWork = new UnitOfWorkRunner(new TransactionRunner({ pool, observer: metrics }), {
    ...(options.seams?.unitOfWorkFaults === undefined
      ? {}
      : { faults: options.seams.unitOfWorkFaults }),
  });

  const keyed = new KeyedHandler(
    new IdempotentRunner({
      waitTimeoutMs: config.idempotencyWaitTimeoutMs,
      keyTtlSeconds: config.idempotencyKeyTtlSeconds,
    }),
    {
      ...(options.seams?.responseBody === undefined
        ? {}
        : { responseBody: options.seams.responseBody }),
      ...(options.seams?.afterCommit === undefined
        ? {}
        : { afterCommit: options.seams.afterCommit }),
      observer: {
        answered: (kind, outcome) => {
          metrics.keyed(kind, outcome);
        },
      },
    },
  );

  app.get(
    '/health/live',
    { schema: { response: { 200: liveResponse } } },
    () => ({ status: 'ok' }) as const,
  );

  const reversals = new Reversals({
    ...(options.seams?.skipExistingReversalCheck === undefined
      ? {}
      : { skipExistingReversalCheck: options.seams.skipExistingReversalCheck }),
  });

  const movementDependencies: MovementDependencies = {
    ids,
    ledger: (uow) => new KyselyLedgerWriter(uow, ids),
  };

  const modules: RouteModule[] = [
    accountRoutes({
      repository: new KyselyAccountRepository(db),
      keyed,
      // Account creation with a key is never retried (plan 000 section 6.1).
      keyedTransactions: new KyselyKeyedTransactions(unitOfWork, {
        retry: 'none',
        operation: (uow) => ({ accounts: new KyselyAccountRepository(uow.db) }),
      }),
      ids,
      queries: new KyselyAccountQueries(db),
      transactions: new KyselyAccountTransactions(unitOfWork, ids),
      cursors: new CursorCodec(config.cursorSecret),
      accountLockTimeoutMs: config.accountLockTimeoutMs,
    }),
    movementRoutes({
      keyed,
      transactions: new KyselyKeyedTransactions<MovementTransaction>(unitOfWork, {
        retry: 'movement',
        operation: (uow) => movementTransactionOn(uow, movementDependencies),
      }),
      queries: new KyselyTransactionQueries(db),
      reversals,
      settings: { accountLockTimeoutMs: config.accountLockTimeoutMs },
      maxAmountMinor: config.maxAmountMinor,
    }),
  ];
  if (options.seams?.throwingRoute !== undefined) modules.push(options.seams.throwingRoute);

  const attachedTestHooks = (): AttachedTestHooks => {
    const keyedHooks = keyed.attachedTestHooks();
    return {
      unitOfWork: unitOfWork.attachedTestHooks(),
      reversals: reversals.attachedTestHooks(),
      responseHandling: keyedHooks.filter((hook) => hook === 'extra-response-member'),
      connectionHandling: keyedHooks.filter((hook) => hook === 'destroy-connection-after-commit'),
    };
  };
  const hooks = attachedTestHooks();
  const testSeams: TestSeamName[] = [
    ...hooks.unitOfWork,
    ...(options.seams?.throwingRoute === undefined ? [] : (['throwing-route'] as const)),
    ...hooks.reversals,
    ...hooks.responseHandling,
    ...hooks.connectionHandling,
  ];
  app.decorate('testSeams', testSeams);
  app.decorate('attachedTestHooks', attachedTestHooks);

  registerDocs(app, {
    operations: { ...ACCOUNT_OPERATION_DOCS, ...MOVEMENT_OPERATION_DOCS },
    idempotencyKeyTtlSeconds: config.idempotencyKeyTtlSeconds,
  });
  registerRoutes(app, {
    protect: (scope) => {
      registerAuthentication(scope, config.jwt, options.clock);
      registerUserRateLimit(scope, { availability: redisAvailability, observer: metrics });
      registerAuthorization(scope);
    },
    modules,
  });

  return app;
}

/**
 * Starts serving: the API on `PORT` and the metrics on `METRICS_PORT`, a second server the load
 * balancer never routes to (SEC-R41, SEC-R43).
 */
export async function listen(
  app: ReturnType<typeof buildApp>,
  config: Pick<Config, 'port' | 'metricsPort'>,
  host = '0.0.0.0',
): Promise<void> {
  await app.listen({ port: config.port, host });
  await app.metricsServer.listen(config.metricsPort, host);
}

/**
 * Loads the configuration from `env` and builds the app; an invalid configuration throws its
 * `ConfigError` before anything is built or connected (SEC-R39, AUT-R18).
 */
export function buildAppFromEnvironment(env: Environment, options: AppOptions = {}) {
  return buildApp(loadConfig(env), options);
}
