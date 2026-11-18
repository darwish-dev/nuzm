/**
 * Load-test harness (M12 S56, FR-OPS-01). Open-loop: requests START on a fixed schedule (rps), whether or not earlier ones finished, so a slow server
 * shows up as latency and errors instead of silently lowering the offered load (coordinated omission). Pure Node (fetch); no external load tool.
 * The harness proves its OWN arithmetic in runner.spec.ts against a local fake server; real numbers come only from a run on staging at the declared scale
 * (docs/reports/M12-load-report.md says which runs exist). A smoke run is never reported as a pass of a declared-scale target.
 */
export interface RequestSpec {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string | (() => string);
  weight: number;
  kind: 'read' | 'write';
  headers?: Record<string, string> | (() => Record<string, string>);
  body?: () => unknown;
  expectStatus?: number[];
}
export interface ScenarioConfig {
  id: string;
  baseUrl: string;
  rps: number;
  durationSeconds: number;
  /** Maximum requests in flight; beyond it a scheduled request is counted as `dropped` (the client, not the server, is saturated). */
  maxInFlight: number;
  requests: RequestSpec[];
  thresholds: Thresholds;
  /** 'smoke' runs are labelled and never satisfy a declared-scale target. */
  scale: 'smoke' | 'declared';
  now?: () => number;
  fetcher?: typeof fetch;
  seed?: number;
}
export interface Thresholds {
  readP95Ms?: number;
  writeP95Ms?: number;
  maxErrorRatePct?: number;
  minAchievedRpsPct?: number; // achieved / offered
}
export interface Stats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
export interface ScenarioResult {
  id: string;
  scale: 'smoke' | 'declared';
  offeredRps: number;
  achievedRps: number;
  durationSeconds: number;
  total: number;
  errors: number;
  dropped: number;
  errorRatePct: number;
  read: Stats;
  write: Stats;
  byRequest: Record<string, { count: number; errors: number; p95: number }>;
  verdicts: { check: string; limit: number; actual: number; pass: boolean }[];
  pass: boolean;
  startedAt: string;
}

export const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
};
const stats = (xs: number[]): Stats => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    count: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1] ?? 0,
  };
};
const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

export async function runScenario(cfg: ScenarioConfig): Promise<ScenarioResult> {
  const fetcher = cfg.fetcher ?? fetch;
  const rand = rng(cfg.seed ?? 42);
  const total = Math.round(cfg.rps * cfg.durationSeconds);
  const weightSum = cfg.requests.reduce((a, r) => a + r.weight, 0);
  const pick = (): RequestSpec => {
    let x = rand() * weightSum;
    for (const r of cfg.requests) if ((x -= r.weight) < 0) return r;
    return cfg.requests[cfg.requests.length - 1]!;
  };
  const lat: Record<'read' | 'write', number[]> = { read: [], write: [] };
  const per: Record<string, { lat: number[]; errors: number }> = {};
  let errors = 0;
  let dropped = 0;
  let inFlight = 0;
  const pending: Promise<void>[] = [];
  const t0 = performance.now();
  const startedAt = new Date().toISOString();

  const fire = async (r: RequestSpec) => {
    const url = cfg.baseUrl + (typeof r.path === 'function' ? r.path() : r.path);
    const headers = {
      'content-type': 'application/json',
      ...(typeof r.headers === 'function' ? r.headers() : (r.headers ?? {})),
    };
    const s = performance.now();
    let bad = false;
    try {
      const res = await fetcher(url, {
        method: r.method,
        headers,
        ...(r.body ? { body: JSON.stringify(r.body()) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      await res.arrayBuffer();
      bad = !(r.expectStatus ?? [200, 201, 202, 204]).includes(res.status);
    } catch {
      bad = true;
    }
    const ms = performance.now() - s;
    lat[r.kind].push(ms);
    (per[r.name] ??= { lat: [], errors: 0 }).lat.push(ms);
    if (bad) {
      errors++;
      per[r.name]!.errors++;
    }
  };

  for (let i = 0; i < total; i++) {
    const due = t0 + (i / cfg.rps) * 1000;
    const wait = due - performance.now();
    if (wait > 1) await new Promise((r) => setTimeout(r, wait));
    if (inFlight >= cfg.maxInFlight) {
      dropped++;
      continue;
    }
    inFlight++;
    pending.push(fire(pick()).finally(() => inFlight--));
  }
  await Promise.all(pending);
  const elapsed = (performance.now() - t0) / 1000;
  const done = lat.read.length + lat.write.length;
  const read = stats(lat.read);
  const write = stats(lat.write);
  const errorRatePct = done ? (errors / done) * 100 : 0;
  const achievedRps = done / elapsed;
  const verdicts: ScenarioResult['verdicts'] = [];
  const t = cfg.thresholds;
  const add = (check: string, limit: number, actual: number, pass: boolean) =>
    verdicts.push({ check, limit, actual: Math.round(actual * 100) / 100, pass });
  if (t.readP95Ms !== undefined)
    add('read p95 ms <=', t.readP95Ms, read.p95, read.count > 0 && read.p95 <= t.readP95Ms);
  if (t.writeP95Ms !== undefined)
    add('write p95 ms <=', t.writeP95Ms, write.p95, write.count > 0 && write.p95 <= t.writeP95Ms);
  if (t.maxErrorRatePct !== undefined)
    add('error rate % <=', t.maxErrorRatePct, errorRatePct, errorRatePct <= t.maxErrorRatePct);
  if (t.minAchievedRpsPct !== undefined)
    add(
      'achieved/offered % >=',
      t.minAchievedRpsPct,
      (achievedRps / cfg.rps) * 100,
      (achievedRps / cfg.rps) * 100 >= t.minAchievedRpsPct,
    );
  return {
    id: cfg.id,
    scale: cfg.scale,
    offeredRps: cfg.rps,
    achievedRps: Math.round(achievedRps * 10) / 10,
    durationSeconds: Math.round(elapsed * 10) / 10,
    total: done,
    errors,
    dropped,
    errorRatePct: Math.round(errorRatePct * 1000) / 1000,
    read,
    write,
    byRequest: Object.fromEntries(
      Object.entries(per).map(([k, v]) => [
        k,
        { count: v.lat.length, errors: v.errors, p95: stats(v.lat).p95 },
      ]),
    ),
    verdicts,
    pass: verdicts.length > 0 && verdicts.every((v) => v.pass) && dropped === 0,
    startedAt,
  };
}

/** Soak: memory growth between the first and last sample (percent). The target (M12 §11) is <= 20 % over 4 h. */
export const memoryGrowthPct = (samplesMb: number[]): number =>
  samplesMb.length < 2 || samplesMb[0]! <= 0
    ? 0
    : ((samplesMb[samplesMb.length - 1]! - samplesMb[0]!) / samplesMb[0]!) * 100;
