import fastifyCookie from '@fastify/cookie';
import type { INestApplication } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ProblemFilter } from './common/problem.filter';
import { enterRequest } from './common/request-context';
import { httpMetrics, initTelemetry, startServerSpan, type ServerSpan } from '@nuzm/telemetry';

/** Cross-cutting HTTP setup shared by main.ts and tests (one place, so tests exercise the real thing). */
declare module 'fastify' {
  interface FastifyRequest {
    otel?: ServerSpan;
    startedAt?: number;
  }
}

export async function configureApp(app: INestApplication): Promise<void> {
  const fastify = (app as NestFastifyApplication).getHttpAdapter().getInstance();
  await fastify.register(fastifyCookie);
  // M12: SCIM clients (RFC 7644) send application/scim+json; parse it as JSON.
  fastify.addContentTypeParser(
    'application/scim+json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, body === '' ? {} : JSON.parse(body as string));
      } catch {
        const e = new Error('invalid JSON') as Error & { statusCode: number };
        e.statusCode = 400;
        done(e, undefined);
      }
    },
  );
  initTelemetry({ serviceName: 'nuzm-api' }); // idempotent; exporter only when OTEL_EXPORTER_OTLP_ENDPOINT is set
  const metrics = httpMetrics();
  fastify.addHook('onRequest', async (req, reply) => {
    // Continue the caller's W3C traceparent when valid, else mint a trace id; the same id is in problem+json.
    req.otel = startServerSpan(`HTTP ${req.method}`, req.headers, {
      'http.request.method': req.method,
    });
    req.startedAt = Date.now();
    req.traceId = req.otel.traceId;
    void reply.header('x-trace-id', req.traceId);
  });
  fastify.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched'; // route pattern, never the raw URL (no ids/PII in labels)
    req.otel?.span.updateName(`${req.method} ${route}`);
    req.otel?.span.setAttribute('http.route', route);
    req.otel?.end(reply.statusCode);
    metrics.record(req.method, route, reply.statusCode, Date.now() - (req.startedAt ?? Date.now()));
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
