import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyRequest } from 'fastify';

/**
 * The in-flight request, available to code that has no `req` parameter (the audit sink enriches events with
 * trace id, IP/UA, API-key and impersonation identity from here). It is entered in a `preHandler` hook so
 * body parsing cannot lose it. Reads are lazy: the guard sets `req.principal`/`req.access` after entry.
 */
const als = new AsyncLocalStorage<FastifyRequest>();
export const enterRequest = (req: FastifyRequest) => als.enterWith(req);
export const currentRequest = (): FastifyRequest | undefined => als.getStore();
