import { requireEnv } from '../support/env.js';
import { migrate } from '../support/migrations.js';

/**
 * Migrates the shared test database to the latest migration as the owner role before the
 * integration tests run as the runtime role (plan 000 section 9, ADR-0020).
 */
export default async function setup(): Promise<void> {
  await migrate(requireEnv('TEST_MIGRATION_DATABASE_URL'), 'up');
}
