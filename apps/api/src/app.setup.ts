import fastifyCookie from '@fastify/cookie';
import type { INestApplication } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ProblemFilter } from './common/problem.filter';
import { enterRequest } from './common/request-context';
import { traceIdFrom } from './common/trace';

/** Cross-cutting HTTP setup shared by main.ts and tests (one place, so tests exercise the real thing). */
export async function configureApp(app: INestApplication): Promise<void> {
  const fastify = (app as NestFastifyApplication).getHttpAdapter().getInstance();
  await fastify.register(fastifyCookie);
  fastify.addHook('onRequest', async (req, reply) => {
    req.traceId = traceIdFrom(req.headers['traceparent']);
    void reply.header('x-trace-id', req.traceId);
  });
  fastify.addHook('preHandler', (req, _reply, done) => {
    enterRequest(req);
    done();
  });
  fastify.addHook('onSend', async (_req, reply) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('cache-control', 'no-store');
  });
  app.useGlobalFilters(new ProblemFilter());
}
