import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MalformedRequest } from '../../../../platform/http/errors.js';
import { parseUuid } from '../../../../platform/http/schemas/ids.js';
import { toValidationFailed, validateRequest } from '../../../../platform/http/validation.js';
import { callerOf, Forbidden, rolesFor, type RouteKey } from '../../../auth/index.js';
import type { KeyedHandler, KeyedTransactions } from '../../../idempotency/index.js';
import type { StatusAction } from '../../domain/account.js';
import { changeAccountStatus } from '../../application/change-account-status.js';
import { createAccount } from '../../application/create-account.js';
import { listAccounts, listHistory, readAccount } from '../../application/account-queries.js';
import type { Position } from '../../application/keyset.js';
import type {
  AccountQueries,
  AccountRepository,
  AccountTransactions,
  IdGenerator,
} from '../../application/ports.js';
import type { CursorCodec, CursorScope } from './cursor.js';
import { accountBody, entryBody, operatorAccountBody, pageBody, readBody } from './presenters.js';
import {
  accountPage,
  accountRepresentation,
  createAccountBody,
  DEFAULT_LIMIT,
  entryPage,
  listQuery,
  noQuery,
  operatorAccountRepresentation,
  statusChangeBody,
} from './schemas.js';

export interface AccountRoutesDeps {
  /** Inserts accounts created without an Idempotency-Key, each in its own statement. */
  repository: AccountRepository;
  /** Account creation with an Idempotency-Key: the key step, never retried (plan 001 section 3.1). */
  keyed: KeyedHandler;
  keyedTransactions: KeyedTransactions<{ accounts: AccountRepository }>;
  ids: IdGenerator;
  queries: AccountQueries;
  transactions: AccountTransactions;
  cursors: CursorCodec;
  accountLockTimeoutMs: number;
}

/** A path id stays a plain string: one that is not a UUID answers 404 at the lookup (SYS-R42). */
const idParams = z.object({ id: z.string() });

const STATUS_ROUTES: readonly [StatusAction, RouteKey][] = [
  ['freeze', 'POST /accounts/{id}/freeze'],
  ['unfreeze', 'POST /accounts/{id}/unfreeze'],
  ['close', 'POST /accounts/{id}/close'],
];

/**
 * The malformed-request step of a list (ACC-R23): the cursor of the raw query string, if any,
 * decoded and checked for this list, caller and account before validation runs (plan 000
 * section 5). A repeated `cursor` parameter is malformed too.
 */
function cursorPosition(
  cursors: CursorCodec,
  query: unknown,
  scope: CursorScope,
): Position | undefined {
  const cursor = (query as { cursor?: unknown } | undefined)?.cursor;
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string') throw new MalformedRequest('cursor');
  return cursors.decode(cursor, scope);
}

/**
 * The seven routes of section 1.1 of spec 001 under `/v1`, each with its roles for the role check
 * (plan 001 section 1). Every route registers its schemas with `attachValidation`, so a schema
 * error is answered at the validation step of SYS-R31, after the malformed-request step (ADR-0004).
 * Only account creation takes an `Idempotency-Key`, which is optional there (IDM-R02); the other
 * routes never read the header (SYS-R39).
 */
export function accountRoutes(deps: AccountRoutesDeps): (scope: FastifyInstance) => void {
  return (scope) => {
    const app = scope.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/accounts',
      {
        schema: {
          body: createAccountBody,
          querystring: noQuery,
          response: { 201: accountRepresentation },
        },
        attachValidation: true,
        config: { roles: rolesFor('POST /accounts') },
        ...deps.keyed.hooks({ required: false }),
      },
      async (request, reply) => {
        const caller = callerOf(request);
        // With a key, validation runs inside the key step, after the savepoint (IDM-R06, IDM-R16).
        const create = async (accounts: AccountRepository) => {
          validateRequest(request);
          return await createAccount(
            { accounts, ids: deps.ids },
            { ownerId: caller.userId, currency: request.body.currency },
          );
        };
        if (deps.keyed.isKeyed(request)) {
          return await deps.keyed.answer(request, reply, caller.userId, {
            transactions: deps.keyedTransactions,
            operation: async (tx) => await create(tx.accounts),
            created: (account) => ({
              location: `/v1/accounts/${account.id}`,
              body: accountBody(account),
            }),
          });
        }
        const account = await create(deps.repository);
        return await reply
          .code(201)
          .header('location', `/v1/accounts/${account.id}`)
          .send(accountBody(account));
      },
    );

    app.get(
      '/accounts',
      {
        schema: { querystring: listQuery, response: { 200: accountPage } },
        attachValidation: true,
        config: { roles: rolesFor('GET /accounts') },
      },
      async (request) => {
        const caller = callerOf(request);
        const scope: CursorScope = { list: 'accounts', userId: caller.userId };
        const after = cursorPosition(deps.cursors, request.query, scope);
        if (request.validationError !== undefined) {
          throw toValidationFailed(request.validationError);
        }
        const page = await listAccounts(deps.queries, caller.userId, {
          limit: request.query.limit ?? DEFAULT_LIMIT,
          ...(after === undefined ? {} : { after }),
        });
        return pageBody(
          page.items.map(accountBody),
          page.next === undefined ? undefined : deps.cursors.encode(scope, page.next),
        );
      },
    );

    app.get(
      '/accounts/:id',
      {
        schema: {
          params: idParams,
          querystring: noQuery,
          response: { 200: z.union([operatorAccountRepresentation, accountRepresentation]) },
        },
        attachValidation: true,
        config: { roles: rolesFor('GET /accounts/{id}') },
      },
      async (request) => {
        if (request.validationError !== undefined) {
          throw toValidationFailed(request.validationError);
        }
        return readBody(await readAccount(deps.queries, callerOf(request), request.params.id));
      },
    );

    app.get(
      '/accounts/:id/entries',
      {
        schema: { params: idParams, querystring: listQuery, response: { 200: entryPage } },
        attachValidation: true,
        config: { roles: rolesFor('GET /accounts/{id}/entries') },
      },
      async (request) => {
        const caller = callerOf(request);
        const accountId = parseUuid(request.params.id) ?? request.params.id;
        const scope: CursorScope = { list: 'entries', userId: caller.userId, accountId };
        const after = cursorPosition(deps.cursors, request.query, scope);
        if (request.validationError !== undefined) {
          throw toValidationFailed(request.validationError);
        }
        const page = await listHistory(deps.queries, caller, request.params.id, {
          limit: request.query.limit ?? DEFAULT_LIMIT,
          ...(after === undefined ? {} : { after }),
        });
        return pageBody(
          page.items.map(entryBody),
          page.next === undefined ? undefined : deps.cursors.encode(scope, page.next),
        );
      },
    );

    for (const [action, route] of STATUS_ROUTES) {
      app.post(
        `/accounts/:id/${action}`,
        {
          schema: {
            params: idParams,
            querystring: noQuery,
            body: statusChangeBody,
            response: { 200: operatorAccountRepresentation },
          },
          attachValidation: true,
          config: { roles: rolesFor(route) },
        },
        async (request) => {
          const caller = callerOf(request);
          // The role check already refused customers; this keeps the audit record's role exact.
          if (caller.role !== 'operator') throw new Forbidden();
          validateRequest(request);
          const account = await changeAccountStatus(
            { transactions: deps.transactions, accountLockTimeoutMs: deps.accountLockTimeoutMs },
            {
              accountId: request.params.id,
              action,
              actor: { id: caller.userId, role: caller.role },
              requestId: request.id,
            },
          );
          return operatorAccountBody(account);
        },
      );
    }
  };
}
