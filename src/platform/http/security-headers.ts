import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

/** The policy of every response (table 1.5 of spec 007): nothing may load or frame it. */
const API_POLICY = {
  useDefaults: false,
  directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
};

/** The policy of `/docs`, whose Swagger UI loads its own scripts, styles and images. */
const DOCS_POLICY = {
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'],
    styleSrc: ["'self'", "'unsafe-inline'"],
    frameAncestors: ["'none'"],
  },
};

/**
 * The headers helmet sets with the configuration below, plus `Cache-Control: no-store`: what an
 * answer given before any hook runs, by the router or the HTTP parser, sends instead, so it
 * carries the same headers as every other response (SEC-R14). A test compares them with what
 * helmet sends, so they cannot drift apart.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none';frame-ancestors 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'DENY',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0',
  'cache-control': 'no-store',
};

/** Whether `path` is `prefix` or below it. */
function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The headers of table 1.5 of spec 007 on every response, through `@fastify/helmet` with its
 * defaults and the values of the table (SEC-R14): its own policy on `/docs` and every route below
 * it, given as the routes' helmet configuration when Swagger UI registers them; and
 * `Cache-Control: no-store` on every response of a route under `apiPrefix` and on every answer to
 * a path that is not a route, so no cache keeps a balance or a history. The route is the one the
 * router matched, after it decoded the path, so a percent-encoded `/v1` is covered too. Fastify sends no `X-Powered-By`, and helmet removes one if anything sets it (SEC-R15).
 * Registered before the routes and the not-found hook, so even a 404 at the route step carries the
 * headers.
 */
export function registerSecurityHeaders(
  app: FastifyInstance,
  options: { docsPrefix: string; apiPrefix: string },
): void {
  app.addHook('onRoute', (route) => {
    if (isUnder(route.url, options.docsPrefix)) {
      route.helmet = { contentSecurityPolicy: DOCS_POLICY };
    }
  });
  void app.register(helmet, {
    contentSecurityPolicy: API_POLICY,
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    xFrameOptions: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  app.addHook('onRequest', (request, reply, done) => {
    const route = request.routeOptions.url;
    if (request.is404 || route === undefined || isUnder(route, options.apiPrefix)) {
      void reply.header('cache-control', 'no-store');
    }
    done();
  });
}
