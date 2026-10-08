import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createAccount } from '../../../src/modules/accounts/index.js';
import { KyselyAccountRepository } from '../../../src/modules/accounts/adapters/persistence/kysely-accounts.js';
import { createDatabase } from '../../../src/platform/db/database.js';
import { UuidV7Generator } from '../../../src/platform/ids/uuid-v7.js';
import { closePools, runtimePool } from '../../support/db.js';

const MICROSECOND_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

describe('create account use case', () => {
  // The Kysely instance shares the helpers' pool, which closePools() ends.
  const deps = {
    accounts: new KyselyAccountRepository(createDatabase(runtimePool())),
    ids: new UuidV7Generator(),
  };

  afterAll(async () => {
    await closePools();
  });

  async function storedAccounts(ownerId: string) {
    const result = await runtimePool().query<{
      id: string;
      kind: string;
      currency: string;
      status: string;
      balance: string;
    }>(`SELECT id, kind, currency, status, balance FROM accounts WHERE owner_id = $1 ORDER BY id`, [
      ownerId,
    ]);
    return result.rows;
  }

  it('ACC-R01 creates an active customer account with balance 0, owned by the caller, in the currency asked for', async () => {
    const ownerId = randomUUID();
    const account = await createAccount(deps, { ownerId, currency: 'EUR' });
    expect(account).toMatchObject({ ownerId, currency: 'EUR', status: 'active', balance: 0n });
    expect(account.createdAt).toMatch(MICROSECOND_TIMESTAMP);
    expect(account.updatedAt).toBe(account.createdAt);
    expect(await storedAccounts(ownerId)).toEqual([
      { id: account.id, kind: 'customer', currency: 'EUR', status: 'active', balance: '0' },
    ]);
  });

  it('ACC-R02 ACC-R04 creates a new account for every request, several in one currency for one customer', async () => {
    const ownerId = randomUUID();
    const created = [
      await createAccount(deps, { ownerId, currency: 'EUR' }),
      await createAccount(deps, { ownerId, currency: 'EUR' }),
      await createAccount(deps, { ownerId, currency: 'JPY' }),
    ];
    expect(new Set(created.map((account) => account.id)).size).toBe(3);
    const stored = await storedAccounts(ownerId);
    expect(stored.map((row) => row.currency).sort()).toEqual(['EUR', 'EUR', 'JPY']);
    expect(stored.every((row) => row.status === 'active' && row.balance === '0')).toBe(true);
  });

  it('ACC-R01 gives accounts UUIDv7 ids that increase in creation order', async () => {
    const ownerId = randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await createAccount(deps, { ownerId, currency: 'USD' })).id);
    }
    expect(
      ids.every((id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
      ),
    ).toBe(true);
    expect(ids.toSorted()).toEqual(ids);
  });
});
