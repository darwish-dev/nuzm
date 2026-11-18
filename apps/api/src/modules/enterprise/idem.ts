import type { FastifyRequest } from 'fastify';
import { ProblemException } from '../../common/errors';

/** The Idempotency-Key header of an admin POST (admin routes carry no org, so the key is stored with the record, per requester). */
export const idemKey = (req: FastifyRequest): string => {
  const k = req.headers['idempotency-key'];
  if (typeof k !== 'string' || k.length < 1 || k.length > 255)
    throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
  return k;
};
