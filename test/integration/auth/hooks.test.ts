import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAuthentication } from '../../../src/modules/auth/adapters/http/authenticate.js';
import { registerAuthorization } from '../../../src/modules/auth/adapters/http/authorize.js';
import { handleError } from '../../../src/platform/http/error-handler.js';
import type { BuiltApp } from '../../support/app.js';
import { bearer, problemOf, withoutRequestId } from '../../support/http.js';
import { LOG_LEVEL } from '../../support/logs.js';
import {
  buildTestApp,
  THROWING_ROUTE_MESSAGE,
  THROWING_ROUTE_PATH,
} from '../../support/test-app.js';
import {
  C1,
  K2,
  nowSeconds,
  O1,
  segments,
  TEST_JWT,
  tokenFor,
  variantToken,
} from '../../support/tokens.js';

const UNAUTHENTICATED = {
  type: '/problems/unauthenticated',
  title: 'Unauthenticated',
  status: 401,
  detail: 'A valid bearer token is required.',
};
const WWW_AUTHENTICATE = 'Bearer realm="supercool-finances"';

describe('the authentication hook on /v1 routes', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildTestApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
  });

  it('AUT-R06 AUT-R01 answers every request without a valid token with the one 401 body and header of section 1.5', async () => {
    const now = nowSeconds();
    const valid = tokenFor(C1, 'customer');
    const [header, payload] = segments(valid);
    const cases: [string, { url: string; headers: Record<string, string> }, string][] = [
      ['no header', { url: THROWING_ROUTE_PATH, headers: {} }, 'missing'],
      [
        'Basic',
        { url: THROWING_ROUTE_PATH, headers: { authorization: 'Basic dXNlcjpwYXNz' } },
        'malformed',
      ],
      [
        'Bearer alone',
        { url: THROWING_ROUTE_PATH, headers: { authorization: 'Bearer' } },
        'malformed',
      ],
      [
        'two spaces',
        { url: THROWING_ROUTE_PATH, headers: { authorization: `Bearer  ${valid}` } },
        'malformed',
      ],
      ['two segments', { url: THROWING_ROUTE_PATH, headers: bearer('abc.def') }, 'malformed'],
      [
        'payload not base64url JSON',
        { url: THROWING_ROUTE_PATH, headers: bearer(`${header}.@@@.${segments(valid)[2]}`) },
        'malformed',
      ],
      [
        'the token only in the query string',
        { url: `${THROWING_ROUTE_PATH}?access_token=${valid}`, headers: {} },
        'missing',
      ],
      [
        'expired',
        {
          url: THROWING_ROUTE_PATH,
          headers: bearer(variantToken({ iat: now - 600, exp: now - 60 }, { now })),
        },
        'expired',
      ],
      [
        'wrong signature',
        { url: THROWING_ROUTE_PATH, headers: bearer(variantToken({}, { now, secret: K2 })) },
        'signature',
      ],
      [
        'alg none',
        {
          url: THROWING_ROUTE_PATH,
          headers: bearer(
            `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${payload}.`,
          ),
        },
        'algorithm',
      ],
      [
        'role admin',
        { url: THROWING_ROUTE_PATH, headers: bearer(variantToken({ role: 'admin' }, { now })) },
        'claims',
      ],
    ];

    const bodies = [];
    for (const [name, request, reason] of cases) {
      built.logs.clear();
      const response = await built.app.inject({ method: 'GET', ...request });
      expect(response.statusCode, name).toBe(401);
      expect(response.headers['www-authenticate'], name).toBe(WWW_AUTHENTICATE);
      const body = problemOf(response);
      expect(withoutRequestId(body), name).toEqual(UNAUTHENTICATED);
      bodies.push(withoutRequestId(body));

      const warnings = built.logs.lines().filter((line) => line.level === LOG_LEVEL.warn);
      expect(warnings, name).toHaveLength(1);
      expect(warnings[0], name).toMatchObject({ reqId: body.requestId, reason });
      expect(built.logs.text(), name).not.toContain(valid);
      expect(built.logs.text(), name).not.toContain(segments(valid)[2]);
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });

  it('AUT-R07 lets a valid token of either role through to the route', async () => {
    for (const token of [tokenFor(C1, 'customer'), tokenFor(O1, 'operator')]) {
      const response = await built.app.inject({
        method: 'GET',
        url: THROWING_ROUTE_PATH,
        headers: { authorization: `bEaReR ${token}` },
      });
      expect(response.statusCode).toBe(500);
      const body = problemOf(response);
      expect(body.type).toBe('/problems/internal-error');
      expect(response.body).not.toContain(THROWING_ROUTE_MESSAGE);
    }
  });

  it('AUT-R20 answers the health check without reading the Authorization header', async () => {
    built.logs.clear();
    const answers = [];
    for (const headers of [
      {},
      bearer(tokenFor(C1, 'customer')),
      bearer(variantToken({ iat: 0, exp: 60 })),
      { authorization: 'Basic dXNlcjpwYXNz' },
    ]) {
      const response = await built.app.inject({ method: 'GET', url: '/health/live', headers });
      expect(response.statusCode).toBe(200);
      answers.push(response.body);
    }
    expect(new Set(answers).size).toBe(1);
    expect(built.logs.lines().filter((line) => line.msg === 'authentication failed')).toEqual([]);
  });
});

describe('the role hook', () => {
  const app = Fastify();
  app.setErrorHandler(handleError);
  registerAuthentication(app, TEST_JWT);
  registerAuthorization(app);
  app.get('/operator-only', { config: { roles: ['operator'] } }, () => ({ ok: true }));
  app.get('/both', { config: { roles: ['customer', 'operator'] } }, () => ({ ok: true }));
  app.get('/undeclared', () => ({ ok: true }));

  afterAll(async () => {
    await app.close();
  });

  it('SYS-R04 answers 403 forbidden to a role the route does not permit, with one body whatever the path', async () => {
    const customer = bearer(tokenFor(C1, 'customer'));
    const forbidden = await app.inject({ method: 'GET', url: '/operator-only', headers: customer });
    expect(forbidden.statusCode).toBe(403);
    expect(withoutRequestId(problemOf(forbidden))).toEqual({
      type: '/problems/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'Your role is not permitted this operation.',
    });
    expect(forbidden.headers['www-authenticate']).toBeUndefined();

    const operator = bearer(tokenFor(O1, 'operator'));
    expect(
      (await app.inject({ method: 'GET', url: '/operator-only', headers: operator })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/both', headers: customer })).statusCode).toBe(
      200,
    );
  });

  it('SYS-R31 authenticates before it checks the role: no token answers 401, not 403', async () => {
    const response = await app.inject({ method: 'GET', url: '/operator-only' });
    expect(response.statusCode).toBe(401);
    expect(problemOf(response).type).toBe('/problems/unauthenticated');
  });

  it('SYS-R03 refuses a route that declares no roles, as a defect', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/undeclared',
      headers: bearer(tokenFor(O1, 'operator')),
    });
    expect(response.statusCode).toBe(500);
  });
});
