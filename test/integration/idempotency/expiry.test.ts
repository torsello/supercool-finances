import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProductionApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { createAccount, deposit, withdraw } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { expireKeyRow, keyRowOf, transactionsOn } from './support.js';

describe('key expiry', () => {
  afterAll(async () => {
    await closePools();
  });

  it('IDM-AC22 a key expires after the default TTL of 86400 seconds and can then be reused by another request', async () => {
    const { app } = buildProductionApp();
    try {
      const c1 = randomUUID();
      const c1Token = tokenFor(c1, 'customer');
      const a1 = await createAccount(app, c1Token, 'EUR');
      await deposit(app, tokenFor(randomUUID(), 'operator'), a1.id, '1000');
      expect((await withdraw(app, c1Token, a1.id, '100', { key: 'k1' })).statusCode).toBe(201);
      expect(await balanceOf(a1.id)).toBe('900');

      const first = await keyRowOf(c1, 'k1');
      expect(first?.ttl_seconds).toBe('86400');
      await expireKeyRow(c1, 'k1');

      const second = await withdraw(app, c1Token, a1.id, '200', { key: 'k1' });
      expect(second.statusCode).toBe(201);
      expect(second.headers['idempotent-replayed']).toBeUndefined();
      expect(await balanceOf(a1.id)).toBe('700');
      expect((await transactionsOn(a1.id))['withdrawal']).toBe(2);

      const replaced = await keyRowOf(c1, 'k1');
      expect(replaced?.fingerprint).not.toBe(first?.fingerprint);
      expect(replaced?.status).toBe(201);
      expect(replaced?.body?.equals(second.rawPayload)).toBe(true);
      expect(replaced?.created_at).not.toBe(first?.created_at);
      expect(replaced?.ttl_seconds).toBe('86400');
    } finally {
      await app.close();
    }
  });

  it('IDM-AC23 a key expires after the configured IDEMPOTENCY_KEY_TTL_SECONDS', async () => {
    const { app } = buildProductionApp({ env: { IDEMPOTENCY_KEY_TTL_SECONDS: '3600' } });
    try {
      const c1 = randomUUID();
      const c1Token = tokenFor(c1, 'customer');
      const a1 = await createAccount(app, c1Token, 'EUR');
      await deposit(app, tokenFor(randomUUID(), 'operator'), a1.id, '1000');
      expect((await withdraw(app, c1Token, a1.id, '100', { key: 'k1' })).statusCode).toBe(201);
      expect((await keyRowOf(c1, 'k1'))?.ttl_seconds).toBe('3600');
    } finally {
      await app.close();
    }
  });
});
