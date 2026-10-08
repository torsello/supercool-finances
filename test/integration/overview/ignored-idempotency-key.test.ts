import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, runtimePool } from '../../support/db.js';
import { bearer, createAccount, type AccountJson } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

describe('an Idempotency-Key where none is taken (SYS-R39)', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  async function keyRows(userIds: string[], key: string): Promise<number> {
    const result = await runtimePool().query<{ count: string }>(
      'SELECT count(*) AS count FROM idempotency_keys WHERE user_id = ANY($1::uuid[]) AND key = $2',
      [userIds, key],
    );
    return Number(result.rows[0]?.count);
  }

  it('SYS-AC26 ignores an Idempotency-Key on a read and on a status change, and stores no record', async () => {
    const c1Id = randomUUID();
    const o1Id = randomUUID();
    const c1 = tokenFor(c1Id, 'customer');
    const o1 = tokenFor(o1Id, 'operator');
    const a1 = await createAccount(built.app, c1);
    const url = `/v1/accounts/${a1.id}`;

    const plain = await built.app.inject({ method: 'GET', url, headers: bearer(c1) });
    const keyed = await built.app.inject({
      method: 'GET',
      url,
      headers: { ...bearer(c1), 'idempotency-key': 'k9' },
    });
    expect(keyed.statusCode).toBe(200);
    expect(keyed.json()).toEqual(plain.json());
    expect(keyed.headers['idempotent-replayed']).toBeUndefined();

    for (const attempt of [1, 2]) {
      const freeze = await built.app.inject({
        method: 'POST',
        url: `${url}/freeze`,
        headers: { ...bearer(o1), 'idempotency-key': 'k9' },
      });
      expect(freeze.statusCode, `freeze ${String(attempt)}`).toBe(200);
      expect(freeze.json<AccountJson>().status).toBe('frozen');
      expect(freeze.headers['idempotent-replayed']).toBeUndefined();
    }

    expect(await keyRows([c1Id, o1Id], 'k9')).toBe(0);
  });
});
