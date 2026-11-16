import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeTraceId, httpMetrics, initTelemetry, startServerSpan, withSpan } from './index';

let tel: ReturnType<typeof initTelemetry>;
beforeAll(() => {
  tel = initTelemetry({ serviceName: 'nuzm-test', env: {} });
});
afterAll(() => tel.shutdown());

const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('telemetry', () => {
  it('continues a valid traceparent (same trace id) and mints a trace id otherwise', () => {
    const a = startServerSpan('GET /x', { traceparent: TP });
    expect(a.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    a.end(200);
    const b = startServerSpan('GET /x', { traceparent: 'garbage' });
    expect(b.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(b.traceId).not.toBe('00000000000000000000000000000000');
    b.end(200);
    const c = startServerSpan('GET /x', {});
    expect(c.traceId).not.toBe(b.traceId);
    c.end(500);
  });

  it('withSpan exposes the active trace id inside and rethrows errors', async () => {
    expect(activeTraceId()).toBeUndefined();
    const inside = await withSpan('job', async () => activeTraceId());
    expect(inside).toMatch(/^[0-9a-f]{32}$/);
    await expect(
      withSpan('boom', async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
  });

  it('records HTTP metrics without throwing when no reader is attached', () => {
    expect(() => httpMetrics().record('GET', '/v1/me', 200, 12)).not.toThrow();
  });
});
