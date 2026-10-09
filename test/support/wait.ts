/**
 * Polls `done` every 20 ms until it holds, failing with `what` after `timeoutMs`: the tests wait
 * for the condition itself, never for a fixed time.
 */
export async function waitUntil(
  done: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
