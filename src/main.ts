import { buildApp } from './app.js';
import { loadConfig } from './platform/config/config.js';

// An invalid configuration throws its ConfigError here, naming every invalid variable and never a
// value, before the app is built or anything connects (SEC-R39, AUT-R18).
const config = loadConfig(process.env);
const app = buildApp(config);
await app.listen({ port: config.port, host: '0.0.0.0' });
