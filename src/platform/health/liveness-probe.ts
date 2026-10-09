/** How long the probe waits for an answer, below the image's `HEALTHCHECK --timeout=3s`. */
export const LIVENESS_PROBE_TIMEOUT_MS = 2000;

/** The service's default `PORT` (section 1.2 of spec 007). */
const DEFAULT_PORT = 3000;

export interface LivenessProbeOptions {
  /** `PORT` as the environment has it; the default 3000 when unset. */
  port: string | undefined;
  timeoutMs?: number;
}

/**
 * The container healthcheck (DEP-R21): requests `http://127.0.0.1:${PORT}/health/live` with Node's
 * `fetch`, with no shell or extra binary in the image, and returns 0 when it answers 200 and 1
 * otherwise: another status, no answer within the timeout, a refused connection or an invalid
 * `PORT`. It writes nothing, so Docker records only the exit code.
 */
export async function checkLiveness(options: LivenessProbeOptions): Promise<0 | 1> {
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 1;
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health/live`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? LIVENESS_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status === 200 ? 0 : 1;
  } catch {
    return 1;
  }
}
