import Fastify from 'fastify';
import type pg from 'pg';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
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
import { acquiringPool, createDatabase, createPool } from './platform/db/database.js';
import { findMigrationsDir, shippedMigrations } from './platform/db/migrations-dir.js';
import { TransactionRunner } from './platform/db/transaction-runner.js';
import { Readiness, registerHealth } from './platform/health/health.js';
import {
  UnitOfWorkRunner,
  type UnitOfWorkFaults,
  type UnitOfWorkTestHook,
} from './platform/db/unit-of-work.js';
import {
  logFailure,
  problemResponse,
  sendProblem,
  toProblem,
} from './platform/http/error-handler.js';
import { ShuttingDown } from './platform/http/errors.js';
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
import {
  currentRequestContext,
  registerRequestContext,
  RequestTimeout,
  SYSTEM_TIMERS,
} from './platform/http/request-timeout.js';
import { registerRoutes, type RouteModule } from './platform/http/routes.js';
import { registerSecurityHeaders } from './platform/http/security-headers.js';
import { trustProxy } from './platform/http/trust-proxy.js';
import { UuidV7Generator } from './platform/ids/uuid-v7.js';
import {
  ClosingGate,
  registerClosingGate,
  ShutdownCoordinator,
  WorkTracker,
} from './platform/lifecycle/shutdown.js';
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
    /** The readiness check and its connection, stopped by the shutdown (SEC-R24, SEC-R26). */
    readiness: Readiness;
    /** The requests in flight and their clean-ups, which the shutdown waits for (SEC-R27). */
    work: WorkTracker;
    /** The request pool, closed by the shutdown after the work in flight (SEC-R27, SEC-R28). */
    closeDatabase(): Promise<void>;
    /** The Redis connection, closed by the shutdown last (SEC-R27, SEC-R28). */
    closeRedis(): Promise<void>;
    /** Set when the shutdown stops accepting connections (SEC-R25). */
    closingGate: ClosingGate;
    /** The request pool, so a test can read a setting on its connections (SEC-AC23). */
    pool: pg.Pool;
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

/**
 * The keep-alive timeout of the service's connections: longer than the load balancer's upstream
 * keep-alive (60 s), so the service never closes a connection the load balancer is about to reuse
 * (SEC-R34).
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

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
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    trustProxy: trustProxy(config.trustedProxyCidrs),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // First, so every request has its deadline and is tracked for the shutdown (SEC-R27, SEC-R33).
  const work = new WorkTracker();
  app.decorate('work', work);
  registerRequestContext(app, {
    timeoutMs: config.requestTimeoutMs,
    work,
    // Logged at warn with its cause, like every 503 (SEC-R33).
    answer: async (request, reply) => {
      const error = new RequestTimeout();
      const problem = toProblem(error);
      logFailure(request, error, problem);
      return await sendProblem(reply, problemResponse(problem, request.id));
    },
  });
  registerRequestId(app);
  registerSecurityHeaders(app, { docsPrefix: DOCS_PREFIX, apiPrefix: API_PREFIX });
  registerCors(app, config.corsOrigins);
  const closingGate = new ClosingGate();
  app.decorate('closingGate', closingGate);
  registerClosingGate(app, closingGate, {
    exempt: ['/health/live'],
    answer: async (request, reply) => {
      const error = new ShuttingDown();
      const problem = toProblem(error);
      logFailure(request, error, problem);
      return await sendProblem(reply, problemResponse(problem, request.id));
    },
  });
  registerBodyLimits(app);

  // At most DB_POOL_MAX request connections, plus the readiness connection (SEC-R36).
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    connectionTimeoutMillis: config.dbPoolAcquireTimeoutMs,
    logger: app.log,
  });
  // Its own connection, outside the request pool, checked against the migrations the code ships
  // (SEC-R24); a build without them fails here, before the app is built.
  const readiness = new Readiness({
    databaseUrl: config.databaseUrl,
    migrations: shippedMigrations(findMigrationsDir()),
    logger: app.log,
  });
  app.decorate('readiness', readiness);
  app.decorate('pool', pool);
  const metrics = new Metrics({ pool });
  const requestPool = acquiringPool(pool, metrics);
  const db = createDatabase(requestPool, currentRequestContext);
  app.decorate('closeDatabase', async () => {
    await db.destroy();
  });
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
  app.decorate('closeRedis', async () => {
    disconnectRedis(redis);
    await Promise.resolve();
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
    await readiness.close();
    await db.destroy();
  });
  const ids = new UuidV7Generator();
  const unitOfWork = new UnitOfWorkRunner(
    new TransactionRunner({
      pool: requestPool,
      observer: metrics,
      scope: currentRequestContext,
    }),
    {
      ...(options.seams?.unitOfWorkFaults === undefined
        ? {}
        : { faults: options.seams.unitOfWorkFaults }),
    },
  );

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

  registerHealth(app, readiness);

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
 * The shutdown of a listening app (section 1.8 of spec 007): readiness answers 503 at once; after
 * `SHUTDOWN_DRAIN_DELAY_MS` both servers stop accepting connections and idle ones close; the
 * requests in flight and their clean-ups get `SHUTDOWN_TIMEOUT_MS`; then the request pool, the
 * readiness connection and Redis close in that order (SEC-R25 to SEC-R28).
 */
export function createShutdown(
  app: ReturnType<typeof buildApp>,
  config: Pick<Config, 'shutdownDrainDelayMs' | 'shutdownTimeoutMs'>,
): ShutdownCoordinator {
  return new ShutdownCoordinator({
    timers: SYSTEM_TIMERS,
    drainDelayMs: config.shutdownDrainDelayMs,
    timeoutMs: config.shutdownTimeoutMs,
    work: app.work,
    readiness: app.readiness,
    server: {
      stopAccepting: () => {
        app.closingGate.close();
        app.server.close();
        void app.metricsServer.close();
      },
      closeIdleConnections: () => {
        app.server.closeIdleConnections();
      },
    },
    resources: [
      ['pool', () => app.closeDatabase()],
      ['readiness connection', () => app.readiness.close()],
      ['redis', () => app.closeRedis()],
    ],
    logger: {
      info: (message) => {
        app.log.info(message);
      },
      warn: (fields, message) => {
        app.log.warn(fields, message);
      },
    },
  });
}

/**
 * Loads the configuration from `env` and builds the app; an invalid configuration throws its
 * `ConfigError` before anything is built or connected (SEC-R39, AUT-R18).
 */
export function buildAppFromEnvironment(env: Environment, options: AppOptions = {}) {
  return buildApp(loadConfig(env), options);
}
