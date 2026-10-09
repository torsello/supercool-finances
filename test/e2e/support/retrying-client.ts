import { headerOf, send, type E2eRequest, type E2eResponse } from './http.js';
import { delay } from './wait.js';

/**
 * The client retry policy of section 1.5 of spec 008, which the API documentation recommends and
 * DEP-AC11 uses: send the same request, with the same Idempotency-Key and body, again on a
 * connection error, a 502, 503 or 504, or a 409 `/problems/request-in-progress`; wait the
 * response's `Retry-After`, or 200 ms when it has none; at most 60 times; and never retry any other
 * 4xx. A replica restart is covered with the `Retry-After: 1` that nginx and the service send.
 */
export const MAX_RETRIES = 60;
export const DEFAULT_RETRY_DELAY_MS = 200;

/** Whether the policy sends the request again after `response`. */
export function isRetryable(response: E2eResponse): boolean {
  if ([502, 503, 504].includes(response.status)) return true;
  if (response.status !== 409) return false;
  try {
    return (
      (JSON.parse(response.body) as { type?: unknown }).type === '/problems/request-in-progress'
    );
  } catch {
    return false;
  }
}

/** The wait before the next attempt: `Retry-After` in whole seconds, else the default. */
export function retryDelayMs(response: E2eResponse | undefined): number {
  const value = response === undefined ? undefined : headerOf(response, 'retry-after');
  if (value !== undefined && /^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  return DEFAULT_RETRY_DELAY_MS;
}

/** Every attempt of one logical request, and its final answer. */
export interface RetriedRequest {
  final: E2eResponse;
  /** The status of each attempt, or the error code of a connection error, in order. */
  attempts: (number | string)[];
  /** The waits before each retry, in milliseconds. */
  delaysMs: number[];
}

export interface RetryOptions {
  /** Injected by the policy's own test, which records the waits without waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** The request sender; the e2e HTTP helper unless injected. */
  sender?: (request: E2eRequest) => Promise<E2eResponse>;
}

/**
 * Sends `request` and retries it as section 1.5 says, until it gets a final answer. Fails only when
 * the last of the 61 attempts was a connection error, so there is no answer at all.
 */
export async function sendWithRetries(
  request: E2eRequest,
  options: RetryOptions = {},
): Promise<RetriedRequest> {
  const sleep = options.sleep ?? delay;
  const sender = options.sender ?? send;
  const attempts: (number | string)[] = [];
  const delaysMs: number[] = [];
  for (let attempt = 0; ; attempt += 1) {
    let response: E2eResponse | undefined;
    let failure: unknown;
    try {
      response = await sender(request);
      attempts.push(response.status);
    } catch (error) {
      failure = error;
      attempts.push((error as NodeJS.ErrnoException).code ?? 'error');
    }
    const retry = response === undefined || isRetryable(response);
    if (!retry || attempt === MAX_RETRIES) {
      if (response !== undefined) return { final: response, attempts, delaysMs };
      throw new Error(
        `no answer after ${String(attempts.length)} attempts: ${attempts.join(', ')}`,
        {
          cause: failure,
        },
      );
    }
    const wait = retryDelayMs(response);
    delaysMs.push(wait);
    await sleep(wait);
  }
}
