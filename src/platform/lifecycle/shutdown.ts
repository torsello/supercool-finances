import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Timers } from '../http/request-timeout.js';

/**
 * Work the shutdown waits for: a request in flight, with the clean-up of its database work after
 * a request-timeout 503 (SEC-R27). At the shutdown deadline its connection is destroyed and its
 * database transaction rolled back (SEC-R28).
 */
export interface TrackedWork {
  destroyConnection(): void;
  rollBack(): void;
}

/** The work in flight in this process, for the shutdown coordinator. */
export class WorkTracker {
  readonly #works = new Set<TrackedWork>();
  #waiters: (() => void)[] = [];

  /** Starts tracking `work`; the returned function ends it. */
  add(work: TrackedWork): () => void {
    this.#works.add(work);
    return () => {
      this.#works.delete(work);
      if (this.#works.size === 0) {
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const resolve of waiters) resolve();
      }
    };
  }

  get size(): number {
    return this.#works.size;
  }

  /** Resolves once no work is in flight. */
  async idle(): Promise<void> {
    if (this.#works.size === 0) return;
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  /** Destroys the connection of every work in flight and rolls back its transaction (SEC-R28). */
  abortAll(): void {
    const works = [...this.#works];
    for (const work of works) work.destroyConnection();
    for (const work of works) work.rollBack();
  }
}

export interface ShutdownLogger {
  info(message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface ShutdownDependencies {
  timers: Timers;
  /** `SHUTDOWN_DRAIN_DELAY_MS`: how long the replica keeps serving once readiness is 503. */
  drainDelayMs: number;
  /** `SHUTDOWN_TIMEOUT_MS`: how long the requests in flight may take once accepting stops. */
  timeoutMs: number;
  work: { idle(): Promise<void>; abortAll(): void; readonly size: number };
  readiness: { stop(): void };
  server: { stopAccepting(): void; closeIdleConnections(): void };
  /** Closed in this order once the work is over: the pool, the readiness connection, Redis. */
  resources: readonly (readonly [name: string, close: () => Promise<void>])[];
  logger: ShutdownLogger;
}

/**
 * The shutdown of SEC-R25 to SEC-R28 (section 1.8 of spec 007), on an injected clock: readiness
 * answers 503 at once; after `drainDelayMs` the server stops accepting connections and closes the
 * idle ones; the requests in flight, with their clean-ups after a request-timeout 503, may run
 * until `timeoutMs` later; then the pool, the readiness connection and Redis close in that order,
 * and the exit code is 0. At the deadline the work still in flight has its connections destroyed
 * and its transactions rolled back, and the exit code is 1.
 */
export class ShutdownCoordinator {
  readonly #deps: ShutdownDependencies;
  #running: Promise<number> | undefined;

  constructor(dependencies: ShutdownDependencies) {
    this.#deps = dependencies;
  }

  /** Runs the shutdown once; a second signal gets the same outcome. Resolves to the exit code. */
  async shutdown(signal: string): Promise<number> {
    this.#running ??= this.#run(signal);
    return await this.#running;
  }

  async #run(signal: string): Promise<number> {
    const { timers, logger } = this.#deps;
    this.#deps.readiness.stop();
    logger.info(`shutting down on ${signal}: readiness answers 503`);
    await this.#sleep(this.#deps.drainDelayMs);
    this.#deps.server.stopAccepting();
    this.#deps.server.closeIdleConnections();
    logger.info('stopped accepting connections');

    let timer: unknown;
    const deadline = new Promise<false>((resolve) => {
      timer = timers.setTimeout(() => {
        resolve(false);
      }, this.#deps.timeoutMs);
    });
    const finished = await Promise.race([this.#deps.work.idle().then(() => true), deadline]);
    timers.clearTimeout(timer);
    if (!finished) {
      logger.warn(
        { inFlight: this.#deps.work.size },
        'shutdown timeout reached: destroying the work still in flight',
      );
      this.#deps.work.abortAll();
    }

    for (const [name, close] of this.#deps.resources) {
      try {
        await close();
      } catch (error) {
        logger.warn({ resource: name, err: error }, 'failed to close a resource');
      }
    }
    logger.info(finished ? 'shutdown complete' : 'shutdown complete, work was cut off');
    return finished ? 0 : 1;
  }

  async #sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#deps.timers.setTimeout(resolve, ms);
    });
  }
}

/** Whether the replica has stopped accepting connections, set once by the shutdown. */
export class ClosingGate {
  #closing = false;

  close(): void {
    this.#closing = true;
  }

  get closing(): boolean {
    return this.#closing;
  }
}

/**
 * What a replica does once it stops accepting connections (SEC-R25): a connection kept alive from
 * before may still carry requests, so every response from then on carries `Connection: close`, and
 * a request that arrives on such a connection is answered at once by `answer`, a 503 before it
 * reaches the pool, except on the `exempt` routes, such as `/health/live`, which answers 200 while
 * the process runs (SEC-R26).
 */
export function registerClosingGate(
  app: FastifyInstance,
  gate: ClosingGate,
  options: {
    exempt: readonly string[];
    answer: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  },
): void {
  app.addHook('onRequest', (request, reply, done) => {
    const route = request.routeOptions.url;
    if (!gate.closing || (route !== undefined && options.exempt.includes(route))) {
      done();
      return;
    }
    void reply.header('connection', 'close');
    void options.answer(request, reply);
  });
  app.addHook('onSend', (_request, reply, payload, done) => {
    if (gate.closing) void reply.header('connection', 'close');
    done(null, payload);
  });
}
