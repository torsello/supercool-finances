/**
 * Waits for an observable condition, never for a fixed time: `check` runs every `intervalMs` until
 * it returns a value other than `undefined`, which is returned. Fails after `timeoutMs` with
 * `description` and the last error `check` threw, if any. The bounds are loose on purpose: Docker
 * runs inside a VM on macOS, where starting a container can take many seconds.
 */
export async function waitFor<T>(
  description: string,
  check: () => Promise<T | undefined> | T | undefined,
  { timeoutMs = 120_000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const cause = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${description}${cause}`);
    }
    await delay(intervalMs);
  }
}

/** Resolves after `ms`: the pause between two checks, or a client's retry delay. */
export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
