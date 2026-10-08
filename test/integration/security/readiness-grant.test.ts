import { afterAll, describe, expect, it } from 'vitest';
import { closePools, rejection, runtimePool } from '../../support/db.js';
import { shippedMigrations } from '../../support/migrations.js';

describe('readiness grant', () => {
  afterAll(async () => {
    await closePools();
  });

  it('SEC-R24 scf_app reads the applied migration names and cannot write them', async () => {
    const applied = await runtimePool().query<{ name: string }>(
      'SELECT name FROM pgmigrations ORDER BY run_on, id',
    );
    expect(applied.rows.map((row) => row.name)).toEqual(shippedMigrations());

    const app = await runtimePool().connect();
    try {
      const codes: string[] = [];
      for (const statement of [
        `INSERT INTO pgmigrations (name, run_on) VALUES ('9999999999999_fake', now())`,
        `UPDATE pgmigrations SET name = 'renamed'`,
        'DELETE FROM pgmigrations',
        'TRUNCATE pgmigrations',
      ]) {
        codes.push((await rejection(app, statement)).code ?? '');
      }
      expect(codes).toEqual(['42501', '42501', '42501', '42501']);
    } finally {
      app.release();
    }
  });
});
