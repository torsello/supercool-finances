import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { toValidationFailed, validateRequest } from '../../../../platform/http/validation.js';
import { callerOf, Forbidden, rolesFor } from '../../../auth/index.js';
import type { KeyedHandler, KeyedTransactions } from '../../../idempotency/index.js';
import {
  deposit,
  getTransaction,
  transfer,
  withdraw,
  type MovementSettings,
  type MovementTransaction,
  type Reversals,
  type TransactionQueries,
} from '../../index.js';
import {
  accountMovementBody,
  depositBody,
  reversalBody as reversalResponse,
  transactionBody,
  transactionLocation,
} from './presenters.js';
import { MOVEMENT_ROUTE_DOCS } from './openapi.js';
import {
  accountMovementRepresentation,
  depositRepresentation,
  idParams,
  movementBody,
  noQuery,
  reversalBody,
  reversalRepresentation,
  transactionRepresentation,
  transferBody,
} from './schemas.js';

export interface MovementRoutesDeps {
  /** Runs every movement and reversal through the key step (plan 005). */
  keyed: KeyedHandler;
  /** Keyed transactions with the movement ports, retried on 40P01 and 40001 (SYS-R18). */
  transactions: KeyedTransactions<MovementTransaction>;
  queries: TransactionQueries;
  reversals: Reversals;
  settings: MovementSettings;
  /** `MAX_AMOUNT_MINOR` (LED-R23). */
  maxAmountMinor: bigint;
}

/** The caller of an operator route; the role check already refused customers (SYS-R04). */
function operatorOf(request: FastifyRequest): { id: string; role: 'operator' } {
  const caller = callerOf(request);
  if (caller.role !== 'operator') throw new Forbidden();
  return { id: caller.userId, role: caller.role };
}

/** The caller of a customer route; the role check already refused operators (SYS-R04). */
function customerOf(request: FastifyRequest): { id: string; role: 'customer' } {
  const caller = callerOf(request);
  if (caller.role !== 'customer') throw new Forbidden();
  return { id: caller.userId, role: caller.role };
}

/**
 * The routes of section 1.1 of spec 003 and section 1.1 of spec 004 under `/v1`, each with its
 * roles for the role check. Movements and reversals require an `Idempotency-Key` and run in the
 * keyed handler (plan 005): the key step, then validation, then the use case, all in one database
 * transaction (plan 000 section 6.2). Every route registers its schemas with `attachValidation`,
 * so a schema error is answered at the validation step, after the key step (ADR-0004, ADR-0009).
 */
export function movementRoutes(deps: MovementRoutesDeps): (scope: FastifyInstance) => void {
  const amountBody = movementBody(deps.maxAmountMinor);
  const required = deps.keyed.hooks({ required: true });

  return (scope) => {
    const app = scope.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/accounts/:id/deposits',
      {
        schema: {
          ...MOVEMENT_ROUTE_DOCS['POST /accounts/{id}/deposits'],
          params: idParams,
          querystring: noQuery,
          body: amountBody,
          response: { 201: depositRepresentation },
        },
        attachValidation: true,
        config: { roles: rolesFor('POST /accounts/{id}/deposits') },
        ...required,
      },
      async (request, reply) => {
        const actor = operatorOf(request);
        return await deps.keyed.answer(request, reply, actor.id, {
          transactions: deps.transactions,
          operation: async (tx) => {
            validateRequest(request);
            return await deposit(tx, deps.settings, {
              accountId: request.params.id,
              amount: request.body.amount,
              currency: request.body.currency,
              actor,
              requestId: request.id,
            });
          },
          created: (result) => ({
            location: transactionLocation(result.transactionId),
            body: depositBody(result),
          }),
        });
      },
    );

    app.post(
      '/accounts/:id/withdrawals',
      {
        schema: {
          ...MOVEMENT_ROUTE_DOCS['POST /accounts/{id}/withdrawals'],
          params: idParams,
          querystring: noQuery,
          body: amountBody,
          response: { 201: accountMovementRepresentation },
        },
        attachValidation: true,
        config: { roles: rolesFor('POST /accounts/{id}/withdrawals') },
        ...required,
      },
      async (request, reply) => {
        const actor = customerOf(request);
        return await deps.keyed.answer(request, reply, actor.id, {
          transactions: deps.transactions,
          operation: async (tx) => {
            validateRequest(request);
            return await withdraw(tx, deps.settings, {
              accountId: request.params.id,
              amount: request.body.amount,
              currency: request.body.currency,
              actor,
              requestId: request.id,
            });
          },
          created: (result) => ({
            location: transactionLocation(result.transactionId),
            body: accountMovementBody(result),
          }),
        });
      },
    );

    app.post(
      '/accounts/:id/transfers',
      {
        schema: {
          ...MOVEMENT_ROUTE_DOCS['POST /accounts/{id}/transfers'],
          params: idParams,
          querystring: noQuery,
          body: transferBody(deps.maxAmountMinor),
          response: { 201: accountMovementRepresentation },
        },
        attachValidation: true,
        config: { roles: rolesFor('POST /accounts/{id}/transfers') },
        ...required,
      },
      async (request, reply) => {
        const actor = customerOf(request);
        return await deps.keyed.answer(request, reply, actor.id, {
          transactions: deps.transactions,
          operation: async (tx) => {
            // The registered schema cannot see the path, so the body as received is validated
            // again with the source, which the destination must differ from (MOV-R10).
            const body = validateRequest(request, {
              schema: transferBody(deps.maxAmountMinor, request.params.id),
              received: deps.keyed.receivedBody(request),
            });
            return await transfer(tx, deps.settings, {
              accountId: request.params.id,
              destinationAccountId: body.destinationAccountId,
              amount: body.amount,
              currency: body.currency,
              actor,
              requestId: request.id,
            });
          },
          created: (result) => ({
            location: transactionLocation(result.transactionId),
            body: accountMovementBody(result),
          }),
        });
      },
    );

    app.get(
      '/transactions/:id',
      {
        schema: {
          ...MOVEMENT_ROUTE_DOCS['GET /transactions/{id}'],
          params: idParams,
          querystring: noQuery,
          response: { 200: transactionRepresentation },
        },
        attachValidation: true,
        config: { roles: rolesFor('GET /transactions/{id}') },
      },
      async (request) => {
        if (request.validationError !== undefined) {
          throw toValidationFailed(request.validationError);
        }
        return transactionBody(
          await getTransaction(deps.queries, callerOf(request), request.params.id),
        );
      },
    );

    app.post(
      '/transactions/:id/reversals',
      {
        schema: {
          ...MOVEMENT_ROUTE_DOCS['POST /transactions/{id}/reversals'],
          params: idParams,
          querystring: noQuery,
          body: reversalBody,
          response: { 201: reversalRepresentation },
        },
        attachValidation: true,
        config: { roles: rolesFor('POST /transactions/{id}/reversals') },
        ...required,
      },
      async (request, reply) => {
        const actor = operatorOf(request);
        return await deps.keyed.answer(request, reply, actor.id, {
          transactions: deps.transactions,
          operation: async (tx) => {
            validateRequest(request);
            return await deps.reversals.reverse(tx, deps.settings, {
              transactionId: request.params.id,
              reason: request.body.reason,
              actor,
              requestId: request.id,
            });
          },
          created: (result) => ({
            location: transactionLocation(result.transactionId),
            body: reversalResponse(result),
          }),
        });
      },
    );
  };
}
