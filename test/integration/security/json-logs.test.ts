import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp, SPEC_007_DEFAULTS } from '../../support/app.js';
import { closePools } from '../../support/db.js';
import { bearer, createAccount, deposit, freshKey } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

describe('JSON logs', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp({ env: SPEC_007_DEFAULTS });
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('SEC-AC16 every log line is a JSON object with level, time and msg, and every line of a request carries its reqId', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);

    const requests = [
      {
        reqId: 'log-1',
        send: async () =>
          await built.app.inject({
            method: 'POST',
            url: `/v1/accounts/${a1.id}/withdrawals`,
            headers: { ...bearer(c1), 'idempotency-key': freshKey(), 'x-request-id': 'log-1' },
            payload: { amount: '100', currency: 'EUR' },
          }),
      },
      {
        reqId: 'log-2',
        send: async () =>
          await built.app.inject({
            method: 'GET',
            url: `/v1/accounts/${randomUUID()}`,
            headers: { ...bearer(c1), 'x-request-id': 'log-2' },
          }),
      },
    ];

    // Every line captured since startup: the app's start, the setup and both requests.
    const captured = built.logs.lines();
    for (const { reqId, send } of requests) {
      built.logs.clear();
      await send();
      // Everything captured was written between receiving and answering this request.
      const lines = built.logs.lines();
      captured.push(...lines);
      for (const line of lines) expect(line.reqId, JSON.stringify(line)).toBe(reqId);
      expect(lines.length, reqId).toBeGreaterThanOrEqual(2);
    }

    expect(captured.length).toBeGreaterThan(4);
    for (const line of captured) {
      expect(line).toEqual(
        expect.objectContaining({
          level: expect.any(Number) as unknown,
          time: expect.any(Number) as unknown,
          msg: expect.any(String) as unknown,
        }),
      );
    }
  });
});
