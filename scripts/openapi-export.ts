// npm run openapi:export: writes the OpenAPI document generated from the route schemas to
// docs/api/openapi.yaml. A unit test fails when the committed file is out of date.
import { writeFile } from 'node:fs/promises';
import { OPENAPI_PATH, renderOpenApiYaml } from './openapi.js';

await writeFile(OPENAPI_PATH, await renderOpenApiYaml(), 'utf8');
process.stdout.write(`wrote ${OPENAPI_PATH}\n`);
