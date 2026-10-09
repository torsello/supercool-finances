import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runOk } from './command.js';
import { E2E_TMP, RESPONSES_PATH } from './paths.js';
import { assertStackCanStart, downStack, PROJECT } from './stack.js';

/**
 * Before the e2e run: Docker must answer, the stack's host ports and subnet must be free (plan 008
 * section 5), and the response record starts empty (plan 007 section 6). After it: the stack and
 * its volumes are removed, so the host ports are free again for the developer's own stack, unless
 * `E2E_KEEP_STACK=1` keeps it running for a look.
 */
export default async function setup(): Promise<() => Promise<void>> {
  await runOk('docker', ['version', '--format', '{{.Server.Version}}']);
  await assertStackCanStart();
  mkdirSync(dirname(RESPONSES_PATH), { recursive: true });
  writeFileSync(RESPONSES_PATH, '');
  mkdirSync(E2E_TMP, { recursive: true });
  return async () => {
    if (process.env['E2E_KEEP_STACK'] === '1') {
      console.warn(
        `E2E_KEEP_STACK=1: the stack ${PROJECT} keeps running; docker compose -p ${PROJECT} down -v removes it.`,
      );
      return;
    }
    await downStack();
    rmSync(E2E_TMP, { recursive: true, force: true });
  };
}
