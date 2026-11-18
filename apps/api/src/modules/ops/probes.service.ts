import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';

export type ProbeKey = 'login' | 'quote' | 'provisioning_mock' | 'payment_sandbox' | 'dns_change';
export type ProbeMode = 'fixture' | 'sandbox' | 'live';
export interface Probe {
  key: ProbeKey;
  mode: ProbeMode;
  run(): Promise<{ ok: boolean; detail?: Record<string, unknown> }>;
}

/** HTTP reachability probe (e.g. the sign-in redirect). Flows that need an authenticated session or a sandbox account (quote, provisioning-mock, payment-sandbox, DNS change) are NOT CONFIGURED here: they are registered by the environment that owns the credentials (HG-03-02, HG-05-xx, HG-07-01). */
export const httpProbe = (
  key: ProbeKey,
  url: string,
  expectStatus: number[],
  mode: ProbeMode,
  fetcher: typeof fetch = fetch,
): Probe => ({
  key,
  mode,
  async run() {
    const res = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return { ok: expectStatus.includes(res.status), detail: { status: res.status } };
  },
});

export class ProbeRunner {
  constructor(private readonly db: Db) {}

  /** Runs and records every configured probe. A probe that throws is a FAILED run (with the error class only, no payload). Returns what was recorded plus the keys that are not configured. */
  async runAll(probes: Probe[]): Promise<{
    recorded: { key: ProbeKey; ok: boolean; durationMs: number; mode: ProbeMode }[];
    notConfigured: ProbeKey[];
  }> {
    const all: ProbeKey[] = [
      'login',
      'quote',
      'provisioning_mock',
      'payment_sandbox',
      'dns_change',
    ];
    const recorded: { key: ProbeKey; ok: boolean; durationMs: number; mode: ProbeMode }[] = [];
    for (const p of probes) {
      const t0 = Date.now();
      let ok = false;
      let detail: Record<string, unknown> = {};
      try {
        const r = await p.run();
        ok = r.ok;
        detail = r.detail ?? {};
      } catch (e) {
        detail = { error: (e as Error).name };
      }
      const durationMs = Date.now() - t0;
      await this.db.withWorkerClaim((c) =>
        c.query(
          `INSERT INTO ops.probe_runs (id, probe_key, ok, duration_ms, detail, mode) VALUES ($1,$2,$3,$4,$5,$6)`,
          [uuidv7(), p.key, ok, durationMs, JSON.stringify(detail), p.mode],
        ),
      );
      recorded.push({ key: p.key, ok, durationMs, mode: p.mode });
    }
    return { recorded, notConfigured: all.filter((k) => !probes.some((p) => p.key === k)) };
  }
}
