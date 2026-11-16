import {
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

/**
 * OpenTelemetry bootstrap (M01 §19, D-13: observability backend is a reversible choice).
 *  - Traces: always on, so every request/operation has a W3C trace id even with no backend. Spans are exported over
 *    OTLP/HTTP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (or to the console with `OTEL_TRACES_CONSOLE=true`).
 *  - Metrics: instruments are created, and exported only when a reader is supplied (backend choice pending).
 *  - Logs: `logJson` writes structured lines carrying the active trace id (no PII).
 */
export interface TelemetryOptions {
  serviceName: string;
  env?: NodeJS.ProcessEnv;
}

let started = false;
export function initTelemetry(opts: TelemetryOptions): { shutdown: () => Promise<void> } {
  const env = opts.env ?? process.env;
  if (started) return { shutdown: async () => undefined };
  started = true;
  const processors = [];
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT)
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`,
        }),
      ),
    );
  if (env.OTEL_TRACES_CONSOLE === 'true')
    processors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': opts.serviceName }),
    spanProcessors: processors,
  });
  provider.register({ propagator: new W3CTraceContextPropagator() });
  const meter = new MeterProvider({
    resource: resourceFromAttributes({ 'service.name': opts.serviceName }),
  });
  metrics.setGlobalMeterProvider(meter);
  return {
    shutdown: async () => {
      await provider.shutdown();
      await meter.shutdown();
      started = false;
    },
  };
}

const tracer = () => trace.getTracer('nuzm');

export interface ServerSpan {
  traceId: string;
  span: Span;
  ctx: Context;
  end(status: number): void;
}

/** Start a SERVER span continuing the caller's `traceparent` when valid (else a fresh trace). */
export function startServerSpan(
  name: string,
  headers: Record<string, string | string[] | undefined>,
  attrs: Record<string, string | number> = {},
): ServerSpan {
  const parent = propagation.extract(context.active(), headers, {
    get: (carrier, key) => {
      const v = (carrier as Record<string, string | string[] | undefined>)[key];
      return Array.isArray(v) ? v[0] : v;
    },
    keys: (carrier) => Object.keys(carrier as object),
  });
  const span = tracer().startSpan(name, { kind: SpanKind.SERVER, attributes: attrs }, parent);
  const ctx = trace.setSpan(parent, span);
  return {
    traceId: span.spanContext().traceId,
    span,
    ctx,
    end(status) {
      span.setAttribute('http.response.status_code', status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    },
  };
}

/** Run `fn` inside a child span (worker ticks, outbox deliveries, external calls). */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attrs: Record<string, string | number> = {},
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      span.end();
    }
  });
}

export const activeTraceId = (): string | undefined => trace.getActiveSpan()?.spanContext().traceId;

export function httpMetrics() {
  const m = metrics.getMeter('nuzm-http');
  const requests = m.createCounter('http.server.requests', {
    description: 'HTTP requests handled',
  });
  const duration = m.createHistogram('http.server.duration', {
    unit: 'ms',
    description: 'HTTP request duration',
  });
  return {
    record(method: string, route: string, status: number, ms: number) {
      const attrs = { method, route, status_class: `${Math.floor(status / 100)}xx` };
      requests.add(1, attrs);
      duration.record(ms, attrs);
    },
  };
}

/** Structured log line with the active trace id. Callers must not pass PII or secrets. */
export function logJson(
  level: 'info' | 'warn' | 'error',
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  process.stdout.write(
    JSON.stringify({
      level,
      msg,
      ts: new Date().toISOString(),
      trace_id: activeTraceId(),
      ...fields,
    }) + '\n',
  );
}
