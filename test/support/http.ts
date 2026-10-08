import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type { BuiltApp } from './app.js';

/** The `Authorization` header of a bearer token. */
export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export type ProblemBody = Record<string, unknown> & {
  type: string;
  title: string;
  status: number;
  detail: string;
  requestId: string;
};

/** The problem details body of a response, after checking its content type (SYS-R24). */
export function problemOf(response: LightMyRequestResponse): ProblemBody {
  const contentType = response.headers['content-type'];
  if (contentType !== 'application/problem+json') {
    throw new Error(`expected application/problem+json, got ${String(contentType)}`);
  }
  return response.json<ProblemBody>();
}

/** A problem body without its `requestId`, to compare bodies that may differ only there. */
export function withoutRequestId(body: ProblemBody): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([name]) => name !== 'requestId'));
}

/** An app as the test support builds it. */
type App = BuiltApp['app'];

/** The account representation as the API answers it (section 1.3 of spec 001). */
export interface AccountJson {
  id: string;
  currency: string;
  status: string;
  balance: string;
  createdAt: string;
  updatedAt: string;
  ownerId?: string;
}

/** Creates an account through the API as the holder of `token`, without Idempotency-Key. */
export async function createAccount(
  app: App,
  token: string,
  currency = 'EUR',
): Promise<AccountJson> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: bearer(token),
    payload: { currency },
  });
  if (response.statusCode !== 201) {
    throw new Error(`account creation answered ${String(response.statusCode)}: ${response.body}`);
  }
  return response.json<AccountJson>();
}

/** Freezes, unfreezes or closes an account through the API. */
export async function changeStatus(
  app: App,
  token: string,
  accountId: string,
  action: 'freeze' | 'unfreeze' | 'close',
): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'POST',
    url: `/v1/accounts/${accountId}/${action}`,
    headers: bearer(token),
  });
}

/** A fresh `Idempotency-Key`, unique to one request. */
export function freshKey(): string {
  return randomUUID();
}

/** Headers of a keyed request: the bearer token and the key, fresh unless given. */
function keyed(token: string, key: string | undefined): Record<string, string> {
  return { ...bearer(token), 'idempotency-key': key ?? freshKey() };
}

export interface MovementOptions {
  currency?: string;
  key?: string;
}

/** Deposits `amount` into an account through the API, with a fresh Idempotency-Key. */
export async function deposit(
  app: App,
  token: string,
  accountId: string,
  amount: string,
  options: MovementOptions = {},
): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'POST',
    url: `/v1/accounts/${accountId}/deposits`,
    headers: keyed(token, options.key),
    payload: { amount, currency: options.currency ?? 'EUR' },
  });
}

/** Withdraws `amount` from an account through the API, with a fresh Idempotency-Key. */
export async function withdraw(
  app: App,
  token: string,
  accountId: string,
  amount: string,
  options: MovementOptions = {},
): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'POST',
    url: `/v1/accounts/${accountId}/withdrawals`,
    headers: keyed(token, options.key),
    payload: { amount, currency: options.currency ?? 'EUR' },
  });
}

/** Transfers `amount` between accounts through the API, with a fresh Idempotency-Key. */
export async function transfer(
  app: App,
  token: string,
  sourceId: string,
  destinationAccountId: string,
  amount: string,
  options: MovementOptions = {},
): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'POST',
    url: `/v1/accounts/${sourceId}/transfers`,
    headers: keyed(token, options.key),
    payload: { destinationAccountId, amount, currency: options.currency ?? 'EUR' },
  });
}

/** Reverses a transaction through the API, with a fresh Idempotency-Key. */
export async function reverse(
  app: App,
  token: string,
  transactionId: string,
  options: { reason?: string; key?: string } = {},
): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'POST',
    url: `/v1/transactions/${transactionId}/reversals`,
    headers: keyed(token, options.key),
    payload: { reason: options.reason ?? 'Operator correction' },
  });
}

/** The movement response of section 1.2 of spec 003. */
export interface MovementJson {
  id: string;
  kind: string;
  amount: string;
  currency: string;
  createdAt: string;
  accountId?: string;
  balance?: string;
}

/** The transaction representation of section 1.3 of spec 003. */
export interface TransactionJson {
  id: string;
  kind: string;
  amount: string;
  currency: string;
  createdAt: string;
  reversedTransactionId?: string;
  entries: { accountId: string; amount: string }[];
}
