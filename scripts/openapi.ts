import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config/config.js';

/** Where `npm run openapi:export` writes the OpenAPI document, and the drift test reads it. */
export const OPENAPI_PATH = 'docs/api/openapi.yaml';

/**
 * The OpenAPI document as YAML, generated from the route schemas by the same code that serves
 * `/docs/json` (SEC-R44). The app is built with placeholder settings and the default values of
 * every variable the document states (`MAX_AMOUNT_MINOR`, `IDEMPOTENCY_KEY_TTL_SECONDS`), so the
 * document never depends on the environment it is exported in. The pool connects lazily, so no
 * database is reached.
 */
export async function renderOpenApiYaml(): Promise<string> {
  const app = buildApp(
    loadConfig({
      DATABASE_URL: 'postgres://openapi:unused@127.0.0.1:1/unused',
      JWT_SECRET: 'openapi-export-placeholder-never-used-to-sign-0001',
      JWT_ISSUER: 'openapi-export',
      JWT_AUDIENCE: 'openapi-export',
      CURSOR_SECRET: 'openapi-export-placeholder-never-used-to-sign-0002',
      LOG_LEVEL: 'fatal',
    }),
  );
  try {
    await app.ready();
    return app.swagger({ yaml: true });
  } finally {
    await app.close();
  }
}
