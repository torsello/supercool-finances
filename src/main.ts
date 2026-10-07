import { buildApp } from './app.js';

const port = Number.parseInt(process.env['PORT'] ?? '3000', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(
    `PORT must be an integer between 1 and 65535, got "${process.env['PORT'] ?? ''}"`,
  );
}

const app = buildApp({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });
await app.listen({ port, host: '0.0.0.0' });
