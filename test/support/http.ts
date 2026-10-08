import type { LightMyRequestResponse } from 'fastify';

/** The `Authorization` header of a bearer token. */
export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export type ProblemBody = Record<string, unknown> & {
  type: string;
  title: string;
  status: number;
  detail: string;
  requestId: string;
};

/** The problem details body of a response, after checking its content type (SYS-R24). */
export function problemOf(response: LightMyRequestResponse): ProblemBody {
  const contentType = response.headers['content-type'];
  if (contentType !== 'application/problem+json') {
    throw new Error(`expected application/problem+json, got ${String(contentType)}`);
  }
  return response.json<ProblemBody>();
}

/** A problem body without its `requestId`, to compare bodies that may differ only there. */
export function withoutRequestId(body: ProblemBody): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([name]) => name !== 'requestId'));
}
