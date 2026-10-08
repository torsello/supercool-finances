import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { bearer, problemOf } from '../../support/http.js';
import { referenceToken, nowSeconds } from '../../support/tokens.js';

const PATHS = ['/token', '/tokens', '/auth/token', '/oauth/token', '/login', '/sessions'];

describe('token issuing', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
  });

  it('AUT-AC14 no endpoint issues tokens: every token-like path answers 404 and no route is named like one', async () => {
    const v = referenceToken(nowSeconds());
    let requests = 0;
    for (const path of PATHS) {
      for (const url of [path, `/v1${path}`]) {
        for (const method of ['POST', 'GET'] as const) {
          for (const headers of [{}, bearer(v)]) {
            const response = await built.app.inject({ method, url, headers });
            const label = `${method} ${url} ${'authorization' in headers ? 'with V' : 'without'}`;
            expect(response.statusCode, label).toBe(404);
            expect(problemOf(response).type, label).toBe('/problems/not-found');
            requests += 1;
          }
        }
      }
    }
    expect(requests).toBe(48);

    const routes = built.app.printRoutes({ commonPrefix: false });
    expect(routes).toContain('accounts');
    expect(routes).toContain('transactions');
    for (const word of ['token', 'login', 'session', 'oauth', 'auth']) {
      expect(routes.toLowerCase()).not.toContain(word);
    }
  });
});
