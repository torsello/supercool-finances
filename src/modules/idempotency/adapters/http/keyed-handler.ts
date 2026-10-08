import type { Socket } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  logFailure,
  problemResponse,
  sendProblem,
  toProblem,
  type BodyExtension,
} from '../../../../platform/http/error-handler.js';
import type { IdempotentRunner, KeyedAnswer } from '../../application/idempotent-runner.js';
import type { KeyedTransactions, Presenter } from '../../application/ports.js';
import { keyHooks, keyOf, receivedBody, type KeyHooks } from './key-header.js';
import { sendAnswer } from './replay.js';

/** The content type of every 201 body, as Fastify's own JSON serializer sends it. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * The hook point of the `extra-response-member` test seam (plan 000 section 8): changes every new
 * response body of a keyed route before it is serialized, never a replay. Only the test app passes
 * it; the production composition root never does.
 */
export interface ResponseBodyHook {
  extend: BodyExtension;
}

/**
 * The hook point of the `destroy-connection-after-commit` test seam (plan 000 section 8): called
 * once a keyed request's database transaction committed, before its response is written. Only the
 * test app passes it.
 */
export interface AfterCommitHook {
  afterCommit(socket: Socket): void;
}

/** The test seams this component attaches, as plan 000 section 8 names them. */
export type KeyedHandlerTestHook = 'extra-response-member' | 'destroy-connection-after-commit';

export interface KeyedHandlerOptions {
  responseBody?: ResponseBodyHook;
  afterCommit?: AfterCommitHook;
}

/** A 201 as a keyed route presents it: its `Location` and its body, before serialization. */
export interface Created {
  location: string;
  body: Record<string, unknown>;
}

/** What a keyed route runs: its keyed transactions, its operation (steps 5 to 8) and its 201. */
export interface KeyedOperation<Operation, Result> {
  transactions: KeyedTransactions<Operation>;
  operation: (tx: Operation) => Promise<Result>;
  created: (result: Result) => Created;
}

/**
 * The keyed handler of the HTTP edge (plan 000 section 5, plan 005 section 1), built once by the
 * composition root: the hooks of a route that takes a key, the presenter the idempotent runner
 * stores responses from, and the answer. Every new response body of a keyed request is built here,
 * the problems the runner rethrows included, so the body hook reaches each of them and never a
 * replay; `attachedTestHooks()` names the seams attached, so SYS-AC24 can assert there are none.
 */
export class KeyedHandler {
  readonly #runner: IdempotentRunner;
  readonly #responseBody: ResponseBodyHook | undefined;
  readonly #afterCommit: AfterCommitHook | undefined;

  constructor(runner: IdempotentRunner, options: KeyedHandlerOptions = {}) {
    this.#runner = runner;
    this.#responseBody = options.responseBody;
    this.#afterCommit = options.afterCommit;
  }

  attachedTestHooks(): KeyedHandlerTestHook[] {
    return [
      ...(this.#responseBody === undefined ? [] : (['extra-response-member'] as const)),
      ...(this.#afterCommit === undefined ? [] : (['destroy-connection-after-commit'] as const)),
    ];
  }

  /** The hooks of a route that takes a key; `required` on movements and reversals (IDM-R01). */
  hooks(options: { required: boolean }): KeyHooks {
    return keyHooks(options);
  }

  /** Whether the request carries a key: account creation runs keyed only with one (IDM-R02). */
  isKeyed(request: FastifyRequest): boolean {
    return keyOf(request) !== undefined;
  }

  /** The body as parsed, for a rule a schema registered with the route cannot check (MOV-R10). */
  receivedBody(request: FastifyRequest): unknown {
    return receivedBody(request);
  }

  /**
   * Runs the request through the idempotent runner (plan 005 section 3) as the caller `userId`
   * and answers: a stored or new response from its exact bytes, or the problem of an error the
   * runner rethrew, which is never stored (IDM-R12, IDM-R13, IDM-R16, IDM-R17). A 500 is logged as
   * the error handler logs it.
   */
  async answer<Operation, Result>(
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    keyed: KeyedOperation<Operation, Result>,
  ): Promise<FastifyReply> {
    const parts = keyOf(request);
    if (parts === undefined) throw new Error('the request carries no Idempotency-Key');
    let answer: KeyedAnswer;
    try {
      answer = await this.#runner.run(
        keyed.transactions,
        { userId, key: parts.key, fingerprint: parts.fingerprint },
        keyed.operation,
        this.#presenter(request, keyed.created),
      );
    } catch (error) {
      const problem = toProblem(error);
      logFailure(request, error, problem);
      return await sendProblem(reply, problemResponse(problem, request.id, this.#extend()));
    }
    if (!answer.replayed) this.#afterCommit?.afterCommit(request.raw.socket);
    return await sendAnswer(request, reply, answer);
  }

  #extend(): BodyExtension | undefined {
    const hook = this.#responseBody;
    return hook === undefined ? undefined : (body) => hook.extend(body);
  }

  /**
   * The presenter of plan 000 section 5: a result as a 201 with its `Location`, an error as its
   * problem from `toProblem`, each body as the exact bytes to store and send. A stored problem
   * keeps only its `Content-Type`: the types section 1.3 of spec 005 stores carry no other header.
   */
  #presenter<Result>(
    request: FastifyRequest,
    created: (result: Result) => Created,
  ): Presenter<Result> {
    const extend = this.#extend();
    return {
      created: (result) => {
        const { location, body } = created(result);
        return {
          status: 201,
          headers: { 'content-type': JSON_CONTENT_TYPE, location },
          body: Buffer.from(JSON.stringify(extend === undefined ? body : extend(body)), 'utf8'),
        };
      },
      problem: (error) => {
        const response = problemResponse(toProblem(error), request.id, extend);
        return {
          status: response.status,
          type: response.type,
          headers: { 'content-type': response.headers['content-type'] },
          body: response.body,
        };
      },
    };
  }
}
