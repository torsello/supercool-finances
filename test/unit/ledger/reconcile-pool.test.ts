import { describe, expect, it } from 'vitest';
import {
  openReconcilePool,
  RECONCILE_CONNECTION_TIMEOUT_MS,
} from '../../../src/modules/ledger/adapters/cli/reconcile.js';

describe('reconcile pool', () => {
  it('LED-R21 bounds the connect at 10000 ms, so an unreachable database exits 2 promptly', async () => {
    // A pg pool connects lazily: building one opens no connection.
    const pool = openReconcilePool('postgres://user:secret@127.0.0.1:1/none', {
      write: () => true,
    });
    try {
      expect(RECONCILE_CONNECTION_TIMEOUT_MS).toBe(10_000);
      expect(pool.options.connectionTimeoutMillis).toBe(10_000);
      expect(pool.options.max).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
