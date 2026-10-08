import type { FastifyReply, FastifyRequest } from 'fastify';
import type { KeyedAnswer } from '../../application/idempotent-runner.js';
import type { StoredResponse } from '../../domain/outcome.js';

/** The exact bytes of a response, without copying them. */
function bytesOf(response: StoredResponse): Buffer {
  const { body } = response;
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

/**
 * Sends the answer of a keyed request: its status, its stored headers (`Content-Type`, and
 * `Location` on a 201) and its exact bytes. A replay also carries the current request's
 * `X-Request-Id` and `Idempotent-Replayed: true`, which are never stored, while its body keeps
 * the original `requestId` (IDM-R07, SYS-R33).
 */
export async function sendAnswer(
  request: FastifyRequest,
  reply: FastifyReply,
  answer: KeyedAnswer,
): Promise<FastifyReply> {
  const { response } = answer;
  void reply.code(response.status).headers({ ...response.headers });
  if (answer.replayed) {
    void reply.header('x-request-id', request.id).header('idempotent-replayed', 'true');
  }
  return await reply.send(bytesOf(response));
}
