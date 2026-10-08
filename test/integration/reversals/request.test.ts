import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { createAccount, deposit, problemOf } from '../../support/http.js';
import { footprint, idOf, reversalAuditsOf, reversalsOf, reverseWith, users } from './support.js';

const REASON = { reason: 'Operator correction' };

describe('the reversal request', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('REV-AC15 a reversal requires an Idempotency-Key, and a retry with the same key replays the first answer', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const d = idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    const before = await footprint([a1.id]);

    const missingOrEmpty: Record<string, string>[] = [{}, { 'idempotency-key': '' }];
    for (const headers of missingOrEmpty) {
      const response = await reverseWith(built.app, u.o1, d, REASON, headers);
      expect(response.statusCode, response.body).toBe(400);
      expect(problemOf(response).type).toBe('/problems/malformed-request');
    }
    expect(await footprint([a1.id])).toEqual(before);
    expect(await reversalsOf(d)).toEqual([]);

    const first = await reverseWith(built.app, u.o1, d, REASON, { 'idempotency-key': 'k1' });
    const retry = await reverseWith(built.app, u.o1, d, REASON, { 'idempotency-key': 'k1' });

    expect(first.statusCode, first.body).toBe(201);
    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.body).toBe(first.body);
    expect(retry.json<{ requestId?: string }>()).toEqual(first.json());
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(await balanceOf(a1.id)).toBe('0');
    expect(await reversalsOf(d)).toHaveLength(1);
    expect(await reversalAuditsOf(d)).toHaveLength(1);
  });

  it('REV-AC17 an invalid reason or an unknown member answers 422 with one error and writes nothing', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const d = idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    const before = await footprint([a1.id]);

    const cases: [unknown, string][] = [
      [{}, '/reason'],
      [{ reason: 'ab' }, '/reason'],
      [{ reason: 42 }, '/reason'],
      [{ reason: 'abc', amount: '5' }, '/amount'],
    ];
    for (const [body, pointer] of cases) {
      const response = await reverseWith(built.app, u.o1, d, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
      const problem = problemOf(response);
      expect(problem.type).toBe('/problems/validation-error');
      const errors = problem['errors'] as { pointer?: string }[];
      expect(errors, JSON.stringify(body)).toHaveLength(1);
      expect(errors[0]?.pointer, JSON.stringify(body)).toBe(pointer);
    }
    expect(await footprint([a1.id])).toEqual(before);
    expect(await reversalsOf(d)).toEqual([]);

    idOf(await reverseWith(built.app, u.o1, d, { reason: 'abc' }));
    expect(await balanceOf(a1.id)).toBe('0');
  });
});
