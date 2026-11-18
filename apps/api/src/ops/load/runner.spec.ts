import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryGrowthPct, percentile, runScenario } from './runner';
import { SCENARIOS } from './scenarios';

let server: ReturnType<typeof createServer>;
let base = '';
let failEvery = 0;
let n = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    n++;
    const slow = req.url?.startsWith('/slow') ? 120 : 2;
    setTimeout(() => {
      res.statusCode = failEvery && n % failEvery === 0 ? 500 : 200;
      res.end('{}');
    }, slow);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('load harness arithmetic (local fake server; this is NOT a performance result)', () => {
  it('percentiles', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([
      percentile(xs, 50),
      percentile(xs, 95),
      percentile(xs, 99),
      percentile([], 95),
    ]).toEqual([50, 95, 99, 0]);
  });
  it('offers the scheduled rate, measures latency, and passes thresholds that hold', async () => {
    failEvery = 0;
    const r = await runScenario({
      id: 't',
      baseUrl: base,
      rps: 50,
      durationSeconds: 1,
      maxInFlight: 100,
      scale: 'smoke',
      requests: [
        { name: 'r', method: 'GET', path: '/a', weight: 3, kind: 'read' },
        { name: 'w', method: 'POST', path: '/b', weight: 1, kind: 'write', body: () => ({}) },
      ],
      thresholds: { readP95Ms: 100, writeP95Ms: 100, maxErrorRatePct: 0.5, minAchievedRpsPct: 90 },
    });
    expect(r.total).toBe(50);
    expect(r.errors).toBe(0);
    expect(r.read.count + r.write.count).toBe(50);
    expect(r.pass).toBe(true);
    expect(r.scale).toBe('smoke');
  });
  it('fails a threshold that is missed (latency) and counts server errors', async () => {
    failEvery = 5;
    const slow = await runScenario({
      id: 't2',
      baseUrl: base,
      rps: 20,
      durationSeconds: 1,
      maxInFlight: 100,
      scale: 'smoke',
      requests: [{ name: 'r', method: 'GET', path: '/slow', weight: 1, kind: 'read' }],
      thresholds: { readP95Ms: 50, maxErrorRatePct: 0.5 },
    });
    expect(slow.verdicts.find((v) => v.check.startsWith('read'))!.pass).toBe(false);
    expect(slow.errors).toBeGreaterThan(0);
    expect(slow.pass).toBe(false);
    failEvery = 0;
  });
  it('is open-loop: a saturated client drops and reports it instead of lowering the offered load', async () => {
    const r = await runScenario({
      id: 't3',
      baseUrl: base,
      rps: 100,
      durationSeconds: 1,
      maxInFlight: 2,
      scale: 'smoke',
      requests: [{ name: 'r', method: 'GET', path: '/slow', weight: 1, kind: 'read' }],
      thresholds: { maxErrorRatePct: 100 },
    });
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.pass).toBe(false);
  });
  it('counts connection failures as errors', async () => {
    const r = await runScenario({
      id: 't4',
      baseUrl: 'http://127.0.0.1:1',
      rps: 5,
      durationSeconds: 1,
      maxInFlight: 10,
      scale: 'smoke',
      requests: [{ name: 'r', method: 'GET', path: '/', weight: 1, kind: 'read' }],
      thresholds: { maxErrorRatePct: 0.5 },
    });
    expect(r.errors).toBe(5);
    expect(r.pass).toBe(false);
  });
  it('soak growth arithmetic', () => {
    expect(memoryGrowthPct([100, 110, 119])).toBeCloseTo(19);
    expect(memoryGrowthPct([100, 125])).toBe(25);
    expect(memoryGrowthPct([])).toBe(0);
  });
  it('every blocked scenario names its reason; every runnable one builds a declared-scale config at the prompt figures', () => {
    for (const s of SCENARIOS) {
      if (s.status === 'blocked') expect(s.blockedBy, s.id).toBeTruthy();
      else {
        const c = s.build!(
          'https://staging.invalid',
          { cookie: 'c', csrf: 'x', orgId: 'o' },
          'declared',
        );
        expect(c.rps).toBe(500);
        expect(c.durationSeconds).toBe(1800);
        expect(c.thresholds).toMatchObject({
          readP95Ms: 300,
          writeP95Ms: 800,
          maxErrorRatePct: 0.5,
        });
      }
    }
  });
});
