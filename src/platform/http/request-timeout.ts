import { AsyncLocalStorage } from 'node:async_hooks';
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TrackedWork, WorkTracker } from '../lifecycle/shutdown.js';
import { hasBody, isJsonMediaType } from './body-limits.js';

/** The timers of the deadlines and the shutdown, injected in unit tests (SEC-AC21, SEC-AC25). */
export interface Timers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const SYSTEM_TIMERS: Timers = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** `statement_timeout` of the runtime role, set by the migration `runtime-role-settings`. */
export const STATEMENT_TIMEOUT_MS = 5000;

/**
 * How long a statement still in flight at the deadline may go without a reply before its
 * connection is destroyed: a little above `statement_timeout`, for a reply that never comes, such
 * as after a network cut (plan 007 section 4, ADR-0022).
 */
export const CLIENT_SIDE_LIMIT_MS = STATEMENT_TIMEOUT_MS + 1000;

/**
 * A request still being handled `REQUEST_TIMEOUT_MS` after it was received (SEC-R33): 503.
 * `transactionStarted` tells whether its database transaction had begun, so a movement that never
 * reached the idempotency step is not counted as a failed movement (table 1.4 of spec 007).
 */
export class RequestTimeout extends Error {
  override readonly name = 'RequestTimeout';
  readonly transactionStarted: boolean;

  constructor(options: { transactionStarted?: boolean } = {}) {
    super('request timeout reached');
    this.transactionStarted = options.transactionStarted ?? true;
  }
}

/** The moment a request's time is up: `REQUEST_TIMEOUT_MS` after it was received. */
export class RequestDeadline {
  readonly timers: Timers;
  /** Resolves when the deadline passes; never, if it is cancelled first. */
  readonly whenPassed: Promise<void>;
  #passed = false;
  readonly #timer: unknown;

  constructor(timeoutMs: number, timers: Timers = SYSTEM_TIMERS) {
    this.timers = timers;
    let pass: () => void = () => undefined;
    this.whenPassed = new Promise((resolve) => (pass = resolve));
    this.#timer = timers.setTimeout(() => {
      this.#passed = true;
      pass();
    }, timeoutMs);
  }

  get passed(): boolean {
    return this.#passed;
  }

  /** The request is over before its deadline: the timer is no longer needed. */
  cancel(): void {
    this.timers.clearTimeout(this.#timer);
  }
}

/** A pool connection a request holds, which the shutdown can destroy (SEC-R28). */
export interface HeldConnection {
  destroy(): void;
}

/**
 * What the database code needs of the request it serves: its deadline, and a way to declare the
 * pool connections it holds, so the request stays in flight for the shutdown until they are
 * released, its clean-up after a request-timeout 503 included (SEC-R27).
 */
export interface RunScope {
  readonly deadline: RequestDeadline;
  /** Declares a held connection; the returned function declares it released. */
  hold(connection: HeldConnection): () => void;
}

/**
 * One request in flight (SEC-R27, SEC-R33): its deadline, the pool connections it holds, whether
 * its reply was sent and whether its response is over. It is tracked for the shutdown until its
 * response has closed, its reply was sent and every connection it held is released, in any order:
 * a client that goes away early leaves the request tracked while its handler still runs, and the
 * clean-up after a request-timeout 503 counts as work in flight. At the shutdown deadline its HTTP
 * connection is destroyed and its pool connections too, which rolls back their transactions
 * (SEC-R28).
 */
export class RequestContext implements RunScope, TrackedWork {
  readonly deadline: RequestDeadline;
  readonly #held = new Set<HeldConnection>();
  readonly #destroyConnection: () => void;
  readonly #finish: () => void;
  #responseClosed = false;
  #replySent = false;
  #finished = false;
  #handlerStarted = false;
  #answeredAtDeadline = false;

  constructor(options: {
    deadline: RequestDeadline;
    work: WorkTracker;
    destroyConnection: () => void;
  }) {
    this.deadline = options.deadline;
    this.#destroyConnection = options.destroyConnection;
    this.#finish = options.work.add(this);
  }

  hold(connection: HeldConnection): () => void {
    this.#held.add(connection);
    return () => {
      this.#held.delete(connection);
      this.#finishIfDone();
    };
  }

  /** The response was sent or the client went away. */
  responseClosed(): void {
    this.#responseClosed = true;
    this.#finishIfDone();
  }

  /**
   * The reply was sent: by the handler once it settled, or by a hook or the deadline before any
   * handler ran, which then never runs (Fastify stops a request whose reply is sent).
   */
  replySent(): void {
    this.#replySent = true;
    this.#finishIfDone();
  }

  /** The route handler is about to run: from now on the database code answers at the deadline. */
  handlerStarting(): void {
    this.#handlerStarted = true;
  }

  get handlerStarted(): boolean {
    return this.#handlerStarted;
  }

  /** The deadline answered before the handler started; the request's body is no longer read. */
  answeredAtDeadline(): void {
    this.#answeredAtDeadline = true;
  }

  get wasAnsweredAtDeadline(): boolean {
    return this.#answeredAtDeadline;
  }

  destroyConnection(): void {
    this.#destroyConnection();
  }

  rollBack(): void {
    for (const connection of [...this.#held]) connection.destroy();
  }

  #finishIfDone(): void {
    if (this.#finished || !this.#responseClosed || !this.#replySent || this.#held.size > 0) {
      return;
    }
    this.#finished = true;
    this.deadline.cancel();
    this.#finish();
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The request's context, set by the first `onRequest` hook. */
    requestContext: RequestContext | null;
  }
}

const contexts = new AsyncLocalStorage<RequestContext>();

/** The context of the request whose code is running, if any. */
export function currentRequestContext(): RequestContext | undefined {
  return contexts.getStore();
}

/** Sends the 503 of a request whose deadline passed before its handler started. */
export type DeadlineAnswer = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * The body as the parser reads it: the request's own stream, until the request was answered at
 * its deadline. From then on an error of that stream, such as the client going away, is no longer
 * passed on, so the parser never fails a request that was already answered, and the body that
 * never arrives is simply never parsed.
 */
function guardedBody(payload: NodeJS.ReadableStream, context: RequestContext): PassThrough {
  const body = new PassThrough();
  // Nothing may read the body, when the media type or the size is refused first.
  body.on('error', () => undefined);
  payload.on('error', (error: Error) => {
    if (!context.wasAnsweredAtDeadline) body.destroy(error);
  });
  payload.pipe(body);
  return body;
}

/**
 * Starts the deadline of every request when it is received (SEC-R33) and tracks the request for
 * the shutdown (SEC-R27): a root `onRequest` hook, registered first, that runs the rest of the
 * request inside its context, so the transaction runner and the read pool find its deadline.
 * Once the handler has started, the 503 at the deadline is answered by the database code the
 * handler waits on. Before that, while the body is still arriving for instance, `answer` sends it
 * at the deadline with `Connection: close`; Fastify then runs no further step of the request, so
 * the handler never runs and exactly one answer is sent. A request stops being tracked once its
 * response has closed and its reply was sent.
 */
export function registerRequestContext(
  app: FastifyInstance,
  options: { timeoutMs: number; work: WorkTracker; answer: DeadlineAnswer; timers?: Timers },
): void {
  app.decorateRequest('requestContext', null);
  app.addHook('onRequest', (request, reply, done) => {
    const context = new RequestContext({
      deadline: new RequestDeadline(options.timeoutMs, options.timers),
      work: options.work,
      destroyConnection: () => request.raw.socket.destroy(),
    });
    request.requestContext = context;
    reply.raw.once('close', () => {
      context.responseClosed();
    });
    void context.deadline.whenPassed.then(async () => {
      if (context.handlerStarted || reply.sent) return;
      context.answeredAtDeadline();
      void reply.header('connection', 'close');
      await options.answer(request, reply);
    });
    contexts.run(context, done);
  });
  // Only a body the parser will read: one refused for its media type is never wrapped, so the
  // server can discard it.
  app.addHook('preParsing', (request, _reply, payload, done) => {
    const context = request.requestContext;
    const parsed = hasBody(request) && isJsonMediaType(request.headers['content-type']);
    done(null, context === null || !parsed ? payload : guardedBody(payload, context));
  });
  app.addHook('preHandler', (request, _reply, done) => {
    request.requestContext?.handlerStarting();
    done();
  });
  app.addHook('onSend', (request, _reply, payload, done) => {
    request.requestContext?.replySent();
    done(null, payload);
  });
}
