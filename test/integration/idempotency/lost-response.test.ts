import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { balanceOf, closePools } from '../../support/db.js';
import { createAccount, deposit, type MovementJson } from '../../support/http.js';
import { buildTestApp } from '../../support/test-app.js';
import { tokenFor } from '../../support/tokens.js';
import { auditsOn, keyRowOf, transactionsOn } from './support.js';

describe('a response lost after the commit', () => {
  afterAll(async () => {
    await closePools();
  });

  it('IDM-AC21 a withdrawal whose connection is destroyed after the commit is replayed on retry and executes once', async () => {
    const c1 = randomUUID();
    const c1Token = tokenFor(c1, 'customer');
    const testApp = buildTestApp();
    try {
      const a1 = await createAccount(testApp.app, c1Token, 'EUR');
      await deposit(testApp.app, tokenFor(randomUUID(), 'operator'), a1.id, '1000');
      const address = await testApp.app.listen({ host: '127.0.0.1', port: 0 });
      const send = () =>
        fetch(`${address}/v1/accounts/${a1.id}/withdrawals`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${c1Token}`,
            'idempotency-key': 'k1',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ amount: '100', currency: 'EUR' }),
        });

      testApp.connection.enable();
      await expect(send()).rejects.toThrow();
      testApp.connection.disable();
      // The connection was lost after the commit: the outcome is stored.
      expect((await keyRowOf(c1, 'k1'))?.status).toBe(201);

      const retry = await send();
      expect(retry.status).toBe(201);
      expect(retry.headers.get('idempotent-replayed')).toBe('true');
      expect(((await retry.json()) as MovementJson).balance).toBe('900');

      expect(await balanceOf(a1.id)).toBe('900');
      expect((await transactionsOn(a1.id))['withdrawal']).toBe(1);
      expect((await auditsOn(a1.id))['withdrawal']).toBe(1);
    } finally {
      testApp.connection.disable();
      await testApp.app.close();
    }
  });
});
