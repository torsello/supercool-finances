import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import {
  bearer,
  changeStatus,
  createAccount,
  deposit,
  problemOf,
  withdraw,
  type MovementJson,
} from '../../support/http.js';
import { buildTestApp } from '../../support/test-app.js';
import { tokenFor } from '../../support/tokens.js';
import { auditsOn, keyRowOf, transactionsOn } from './support.js';

describe('replays of a completed request', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('IDM-AC07 a completed request is replayed unchanged, with the current X-Request-Id, also with a query string, and executes once', async () => {
    const c1 = randomUUID();
    const c2 = randomUUID();
    const c1Token = tokenFor(c1, 'customer');
    const o1Token = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1Token, 'EUR');
    await deposit(built.app, o1Token, a1.id, '5000');
    const send = (requestId: string, query = '') =>
      built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals${query}`,
        headers: { ...bearer(c1Token), 'idempotency-key': 'k1', 'x-request-id': requestId },
        payload: { amount: '1200', currency: 'EUR' },
      });

    const first = await send('r1');
    expect(first.statusCode).toBe(201);
    expect(first.json<MovementJson>().balance).toBe('3800');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const stored = await keyRowOf(c1, 'k1');

    expect((await deposit(built.app, o1Token, a1.id, '1000')).statusCode).toBe(201);

    const replays = [await send('r2'), await send('r3', `?ownerId=${c2}`)];
    for (const [index, replay] of replays.entries()) {
      const name = `replay ${String(index + 1)}`;
      expect(replay.statusCode, name).toBe(201);
      expect(replay.headers.location, name).toBe(first.headers.location);
      expect(replay.headers['content-type'], name).toBe(first.headers['content-type']);
      expect(replay.rawPayload.equals(first.rawPayload), name).toBe(true);
      expect(replay.json<MovementJson>().balance, name).toBe('3800');
      expect(replay.headers['idempotent-replayed'], name).toBe('true');
    }
    expect(replays[0]?.headers['x-request-id']).toBe('r2');
    expect(replays[1]?.headers['x-request-id']).toBe('r3');

    expect(await balanceOf(a1.id)).toBe('4800');
    expect((await transactionsOn(a1.id))['withdrawal']).toBe(1);
    expect((await auditsOn(a1.id))['withdrawal']).toBe(1);
    expect(await keyRowOf(c1, 'k1')).toEqual(stored);
  });

  it('IDM-AC08 a replay ignores the configuration, the account state and the code version of the replica that answers it', async () => {
    const c1Token = tokenFor(randomUUID(), 'customer');
    const o1Token = tokenFor(randomUUID(), 'operator');
    const first = buildTestApp();
    let response;
    let a1Id: string;
    try {
      await first.app.ready();
      const a1 = await createAccount(first.app, c1Token, 'EUR');
      a1Id = a1.id;
      await deposit(first.app, o1Token, a1.id, '1000');
      response = await withdraw(first.app, c1Token, a1.id, '500', { key: 'k1' });
      expect(response.statusCode).toBe(201);
      expect((await changeStatus(first.app, o1Token, a1.id, 'freeze')).statusCode).toBe(200);
    } finally {
      await first.app.close();
    }

    // The restarted test app, standing for a replica of another version.
    const restarted = buildTestApp({ env: { MAX_AMOUNT_MINOR: '100' } });
    try {
      await restarted.app.ready();
      restarted.responseBody.add('apiVersion', 2);

      const replay = await withdraw(restarted.app, c1Token, a1Id, '500', { key: 'k1' });
      expect(replay.statusCode).toBe(201);
      expect(replay.rawPayload.equals(response.rawPayload)).toBe(true);
      expect(replay.json()).not.toHaveProperty('apiVersion');
      expect(replay.headers['idempotent-replayed']).toBe('true');

      const k2 = await withdraw(restarted.app, c1Token, a1Id, '500', { key: 'k2' });
      expect(k2.statusCode).toBe(422);
      const problem = problemOf(k2);
      expect(problem.type).toBe('/problems/validation-error');
      expect(problem['apiVersion']).toBe(2);
    } finally {
      await restarted.app.close();
    }

    expect(await balanceOf(a1Id)).toBe('500');
    expect((await transactionsOn(a1Id))['withdrawal']).toBe(1);
  });
});
