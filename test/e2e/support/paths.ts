import { join } from 'node:path';
import { REPOSITORY_ROOT } from '../../support/deployment.js';

/** The record of every response the e2e HTTP helpers receive (plan 007 section 6). */
export const RESPONSES_PATH = join(REPOSITORY_ROOT, 'reports', 'e2e-responses.jsonl');

/**
 * Scratch files of the e2e suite: the clone of DEP-AC01, the override of DEP-AC03 and the empty
 * env file every Compose command reads. Under `reports/`, which Git and the Docker build context
 * ignore, and inside the home directory, which Docker Desktop and colima share with their VM, so
 * a bind mount from here works; the system temporary folder is not shared on macOS.
 */
export const E2E_TMP = join(REPOSITORY_ROOT, 'reports', 'e2e-tmp');
