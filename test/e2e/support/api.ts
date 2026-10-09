import { randomUUID } from 'node:crypto';
import { bearer, expectStatus, jsonOf, send, type E2eResponse } from './http.js';
import { freshUser, type User } from './tokens.js';
import { BASE_URL } from './urls.js';

/** The account representation (section 1.3 of spec 001). */
export interface AccountJson {
  id: string;
  currency: string;
  status: string;
  balance: string;
  createdAt: string;
  updatedAt: string;
  ownerId?: string;
}

/** A movement's answer (section 1.2 of spec 003). */
export interface MovementJson {
  id: string;
  kind: string;
  amount: string;
  currency: string;
  balance?: string;
}

/** Where a request goes: the load balancer unless a replica's own URL is given. */
export interface Target {
  base?: string;
}

function url(path: string, target: Target): string {
  return `${target.base ?? BASE_URL}${path}`;
}

export async function createAccount(
  token: string,
  currency = 'EUR',
  target: Target = {},
): Promise<AccountJson> {
  const response = await send({
    method: 'POST',
    url: url('/v1/accounts', target),
    headers: bearer(token),
    body: { currency },
  });
  return jsonOf(expectStatus(response, 201)) as AccountJson;
}

export interface MovementOptions extends Target {
  key?: string;
  currency?: string;
  headers?: Record<string, string>;
}

function keyed(token: string, options: MovementOptions): Record<string, string> {
  return { ...bearer(token), 'idempotency-key': options.key ?? randomUUID(), ...options.headers };
}

export async function deposit(
  token: string,
  accountId: string,
  amount: string,
  options: MovementOptions = {},
): Promise<E2eResponse> {
  return await send({
    method: 'POST',
    url: url(`/v1/accounts/${accountId}/deposits`, options),
    headers: keyed(token, options),
    body: { amount, currency: options.currency ?? 'EUR' },
  });
}

export async function withdraw(
  token: string,
  accountId: string,
  amount: string,
  options: MovementOptions = {},
): Promise<E2eResponse> {
  return await send({
    method: 'POST',
    url: url(`/v1/accounts/${accountId}/withdrawals`, options),
    headers: keyed(token, options),
    body: { amount, currency: options.currency ?? 'EUR' },
  });
}

export async function transfer(
  token: string,
  sourceId: string,
  destinationAccountId: string,
  amount: string,
  options: MovementOptions = {},
): Promise<E2eResponse> {
  return await send({
    method: 'POST',
    url: url(`/v1/accounts/${sourceId}/transfers`, options),
    headers: keyed(token, options),
    body: { destinationAccountId, amount, currency: options.currency ?? 'EUR' },
  });
}

export async function getAccount(
  token: string,
  accountId: string,
  target: Target & { headers?: Record<string, string> } = {},
): Promise<E2eResponse> {
  return await send({
    url: url(`/v1/accounts/${accountId}`, target),
    headers: { ...bearer(token), ...target.headers },
  });
}

/** The balance of an account, read by its owner or an operator. */
export async function balanceOf(token: string, accountId: string): Promise<string> {
  return (jsonOf(expectStatus(await getAccount(token, accountId), 200)) as AccountJson).balance;
}

/** Deposits as an operator and fails unless the deposit answers 201. */
export async function fund(
  operatorToken: string,
  accountId: string,
  amount: string,
): Promise<void> {
  expectStatus(await deposit(operatorToken, accountId, amount), 201);
}

/** A fresh customer with one EUR account per amount in `balances`, funded by `operator`. */
export async function customerWithAccounts(
  operator: User,
  balances: readonly string[],
): Promise<{ user: User; accounts: AccountJson[] }> {
  const user = await freshUser('customer');
  const accounts: AccountJson[] = [];
  for (const balance of balances) {
    const account = await createAccount(user.token);
    if (balance !== '0') await fund(operator.token, account.id, balance);
    accounts.push(account);
  }
  return { user, accounts };
}
