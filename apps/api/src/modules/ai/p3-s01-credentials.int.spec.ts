import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LIVE_REQUIRED_DECISIONS,
  MockModelAdapter,
  TWIN_PRICING,
  runQualification,
  tokenCostNano,
  trackWorstCase,
  twinTarget,
  type QualificationEvidence,
} from '@nuzm/adapter-model';
import { v7 as uuidv7 } from 'uuid';
import { recordSha256 } from './internal/live-executor';
import { AuditSink } from '../../common/audit';
import { MemorySecretStore } from '../../common/secrets';
import { DB } from '../../common/tokens';
import {
  KillSwitchDrillService,
  ModelProviderService,
  GatewayService,
  loadAiConfig,
} from './index';
import type { ProbeResult } from './internal/claude-probe';
import { setupAiEnv, type AiEnv } from './testing/ai-harness';

/**
 * P3-S01: key rotation, key revocation and the kill switch drill, against the real database, gateway and audit sink. The keys are synthetic, the provider probe is a stub (nothing is
 * sent to any vendor: fetch is stubbed to fail loudly), the results are SIMULATED. What this proves: the swap is atomic and only after the new key is accepted, nothing leaks, the
 * revocation disables and (for a compromise) engages the kill switch, and the drill proves the switch and always restores it.
 */
let e: AiEnv;
const OLD = `test-only-${'Aq3W'.repeat(9)}`;
const NEW = `test-only-${'Zt8N'.repeat(9)}`;
const BAD = `test-only-${'Bd5Y'.repeat(9)}`;
const FRAGMENTS = [OLD, NEW, BAD].flatMap((k) => [k, k.slice(0, 20), k.slice(-20)]);
let secrets: MemorySecretStore;
let probeCalls: string[];
let probeAnswer: (key: string) => ProbeResult;
let svc: ModelProviderService;
let providerId = '';
const actor = () => e.ids.padmin!;

beforeAll(async () => {
  e = await setupAiEnv();
  secrets = new MemorySecretStore();
  probeCalls = [];
  probeAnswer = (k) =>
    k === BAD
      ? { outcome: 'invalid_key', httpStatus: 401 }
      : { outcome: 'ok', httpStatus: 200, modelCount: 3 };
  svc = new ModelProviderService(
    e.app.get(DB),
    e.app.get(AuditSink),
    e.registry,
    { ...loadAiConfig(), liveProviders: ['claude'] },
    secrets,
    async (k) => (probeCalls.push(k), probeAnswer(k)),
  );
  providerId = (await svc.saveClaudeKey(actor(), OLD)).id;
}, 300_000);
afterAll(() => e.h.close());
const events = (action: string) => e.sink.events.filter((x) => x.action === action);
const noLeak = (text: string, where: string) => {
  for (const f of FRAGMENTS) expect(text, where).not.toContain(f);
};

describe('key rotation', () => {
  it('a rejected key changes nothing: the old key stays, the staging copy is gone, a failure is audited without any key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('a request left the process');
      }),
    );
    const before = await secrets.get('vault://mem/ai-claude');
    await expect(svc.rotateCredential(actor(), providerId, BAD)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(await secrets.get('vault://mem/ai-claude')).toBe(before);
    await expect(secrets.get('vault://mem/ai-claude-next')).rejects.toThrow();
    const f = events('ai.provider.credential_rotation_failed');
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toMatchObject({
      outcome: 'invalid_key',
      httpStatus: 401,
      vaultRef: 'vault://mem/ai-claude',
    });
    noLeak(JSON.stringify(e.sink.events), 'audit');
    vi.unstubAllGlobals();
  });
  it('an accepted key replaces the old one under the SAME reference; the old key is gone; the provider row only moves its version; the audit holds the reference only', async () => {
    const before = (await svc.list()).items.find((p) => p.id === providerId)!;
    const r = await svc.rotateCredential(actor(), providerId, NEW);
    expect(r.provider.vaultRef).toBe('vault://mem/ai-claude');
    expect(r.provider.vaultRef).toBe(before.vaultRef);
    expect(await secrets.get('vault://mem/ai-claude')).toBe(NEW);
    await expect(secrets.get('vault://mem/ai-claude-next')).rejects.toThrow();
    expect(r.provider.version).toBe(before.version + 1);
    expect(r.vendorSteps.join(' ')).toMatch(/Revoke the OLD key in the vendor console/);
    const ok = events('ai.provider.credential_rotated');
    expect(ok).toHaveLength(1);
    expect(ok[0]!.detail).toMatchObject({
      vaultRef: 'vault://mem/ai-claude',
      tested: true,
      modelCount: 3,
    });
    noLeak(JSON.stringify(e.sink.events) + JSON.stringify(r), 'audit and response');
    expect(probeCalls.at(-1)).toBe(NEW);
    // no table holds a key (the vault reference is the only credential-shaped value)
    for (const t of ['ai.model_providers']) {
      const rows = await e.sql(`SELECT row_to_json(x)::text AS j FROM ${t} x`);
      noLeak(rows.map((x) => String(x.j)).join('\n'), t);
    }
  });
  it('refuses, and probes nothing, while the live gate is closed; with a malformed key; with no key to rotate; and in a production profile', async () => {
    const closed = new ModelProviderService(
      e.app.get(DB),
      e.app.get(AuditSink),
      e.registry,
      { ...loadAiConfig(), liveProviders: [] },
      secrets,
      async (k) => (probeCalls.push(k), { outcome: 'ok' }),
    );
    const n = probeCalls.length;
    await expect(closed.rotateCredential(actor(), providerId, NEW)).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    await expect(svc.rotateCredential(actor(), providerId, 'short')).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      svc.rotateCredential(actor(), providerId, 'has a space in it so it is not a key'),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(probeCalls.length).toBe(n);
    const prod = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(svc.rotateCredential(actor(), providerId, NEW)).rejects.toMatchObject({
        code: 'unsupported_capability',
      });
    } finally {
      process.env.NODE_ENV = prod;
    }
    expect(await secrets.get('vault://mem/ai-claude')).toBe(NEW);
  });
  it('a probe that throws is a refusal, not a swap', async () => {
    const boom = new ModelProviderService(
      e.app.get(DB),
      e.app.get(AuditSink),
      e.registry,
      { ...loadAiConfig(), liveProviders: ['claude'] },
      secrets,
      async () => {
        throw new Error('network');
      },
    );
    await expect(boom.rotateCredential(actor(), providerId, OLD)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(await secrets.get('vault://mem/ai-claude')).toBe(NEW);
    await expect(secrets.get('vault://mem/ai-claude-next')).rejects.toThrow();
  });
});

describe('key revocation', () => {
  it('a scheduled revocation clears the key and disables the provider; the kill switch is NOT touched', async () => {
    const r = await svc.revokeCredential(actor(), providerId, { reason: 'scheduled' });
    expect(r.killSwitch).toBe(false);
    expect(r.provider).toMatchObject({ vaultRef: null, enabled: false });
    await expect(secrets.get('vault://mem/ai-claude')).rejects.toThrow();
    const ev = events('ai.provider.credential_revoked');
    expect(ev.at(-1)!.detail).toMatchObject({
      reason: 'scheduled',
      killSwitchEngaged: false,
      hadCredential: true,
    });
    expect(events('ai.killswitch.toggled')).toHaveLength(0);
    noLeak(JSON.stringify(e.sink.events), 'audit');
  });
  it('a suspected compromise engages the GLOBAL kill switch first, clears the key and tells the operator what the platform cannot do', async () => {
    await svc.saveClaudeKey(actor(), OLD);
    const r = await svc.revokeCredential(actor(), providerId, { reason: 'compromised' });
    expect(r.killSwitch).toBe(true);
    expect(r.vendorSteps.join(' ')).toMatch(/vendor console NOW/);
    expect(r.vendorSteps.join(' ')).toMatch(/Lift the kill switch/);
    const flag = await e.sql(
      `SELECT value FROM platform.feature_flags WHERE key='ai.killswitch' AND org_id IS NULL`,
    );
    expect(flag.map((x) => x.value)).toEqual([true]);
    const order = e.sink.events.map((x) => x.action);
    expect(order.lastIndexOf('ai.killswitch.toggled')).toBeLessThan(
      order.lastIndexOf('ai.provider.credential_cleared'),
    );
    await svc.setKillSwitch(actor(), false); // leave the shared state clean for the drill below
  });
  it('an unknown reason is refused and changes nothing', async () => {
    await svc.saveClaudeKey(actor(), OLD);
    await expect(
      svc.revokeCredential(actor(), providerId, { reason: 'because' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await secrets.get('vault://mem/ai-claude')).toBe(OLD);
  });
});

describe('kill switch drill against the real gateway', () => {
  it('engages, sees the gateway refuse, lifts, sees it served again; every toggle and the drill itself are audited; nothing was sent to a provider', async () => {
    let served = 0;
    await e.enableMock('mock-cap-ok', {
      adapter: new MockModelAdapter({
        id: 'mock-cap-ok',
        region: 'sa-central',
        handler: () => (served++, 'x'),
      }),
    });
    await e.fund(e.org.A!, '1000000');
    const drill = new KillSwitchDrillService(
      e.app.get(DB),
      e.app.get(AuditSink),
      svc,
      e.app.get(GatewayService),
    );
    const before = events('ai.killswitch.toggled').length;
    const r = await drill.run(actor(), e.org.A!);
    expect(r.ok, JSON.stringify(r.steps)).toBe(true);
    expect(r.steps.map((s) => s.id)).toEqual([
      'baseline',
      'engage',
      'refused_within_bound',
      'lift',
      'restored',
    ]);
    expect(r.restored).toBe(true);
    expect(events('ai.killswitch.toggled').length - before).toBe(2);
    expect(events('ai.killswitch.drill').at(-1)!.outcome).toBe('success');
    expect(served).toBe(0); // the drill's pre-flight never calls a model
    const flag = await e.sql(
      `SELECT value FROM platform.feature_flags WHERE key='ai.killswitch' AND org_id IS NULL`,
    );
    expect(flag.every((x) => x.value === false)).toBe(true);
  });
  it('refuses to run while the switch is engaged by someone else and leaves it engaged', async () => {
    await svc.setKillSwitch(actor(), true);
    const drill = new KillSwitchDrillService(
      e.app.get(DB),
      e.app.get(AuditSink),
      svc,
      e.app.get(GatewayService),
    );
    const r = await drill.run(actor(), e.org.A!);
    expect(r.ok).toBe(false);
    const flag = await e.sql(
      `SELECT value FROM platform.feature_flags WHERE key='ai.killswitch' AND org_id IS NULL`,
    );
    expect(flag.map((x) => x.value)).toEqual([true]);
    await svc.setKillSwitch(actor(), false);
  });
});

describe('capability evidence ingestion from the executor envelope (D8)', () => {
  const rows = async () =>
    (await e.sql(
      `SELECT model_id, capability, state, evidence_ref FROM ai.model_capability_evidence WHERE provider_id=$1 ORDER BY recorded_at, capability`,
      [providerId],
    )) as {
      model_id: string;
      capability: string;
      state: string;
      evidence_ref: string;
    }[];
  /** A LIVE-labelled track-B record from the mock twin (this proves the ingestion mechanics only), re-addressed to the registered Claude adapter the way a real run would be. */
  async function envelope(
    over: { detail?: string; verdict?: string; mode?: string; sha?: boolean } = {},
  ) {
    const w = trackWorstCase('B');
    const { target } = twinTarget();
    const rec = await runQualification(
      'B',
      { ...target, mode: 'live' },
      {
        ref: 'synthetic-D9-ref',
        approvedBy: 'synthetic-owner',
        environment: 'non-production',
        maxRequests: w.requests,
        maxTotalTokens: w.totalTokens,
        maxCostNano: tokenCostNano(w.inputTokens, w.outputTokens, TWIN_PRICING).toString(),
      },
      {
        liveProviders: ['mock-live-twin'],
        evidence: LIVE_REQUIRED_DECISIONS.map((decision) => ({
          decision,
          ref: `synthetic-ref-${decision}`,
          recordedBy: 'synthetic-owner',
          recordedAt: '2026-11-20T10:00:00Z',
          provider: 'mock-live-twin',
          environment: 'non-production',
          outcome: 'approved',
        })),
      },
    );
    const adapter = e.registry.get('claude')!;
    const r2 = {
      ...rec,
      provider: 'claude',
      model: adapter.models()[0]!.modelId,
      contractVersion: adapter.contractVersion,
    } as QualificationEvidence;
    if (over.detail) r2.checks = r2.checks.map((c) => ({ ...c, detail: over.detail! }));
    if (over.verdict) (r2 as { verdict: string }).verdict = over.verdict;
    return {
      schema: 'nuzm.p3-provider-evidence',
      schemaVersion: 1,
      id: uuidv7(),
      mode: over.mode ?? 'live',
      provider: 'claude',
      model: r2.model,
      contractVersion: adapter.contractVersion,
      cap: { overran: false },
      records: [r2],
      tracks: [
        {
          track: 'B',
          status: 'ran',
          recordSha256: over.sha === false ? 'f'.repeat(64) : recordSha256(r2),
        },
      ],
    };
  }
  it('a LIVE-VERIFIED tool-calling record records tool-use VERIFIED (and the dependent capabilities as the record says), and the router then counts them', async () => {
    const env = await envelope();
    const before = (await rows()).length;
    const p = await svc.ingestExecutorEvidence(actor(), providerId, env);
    const got = (await rows()).slice(before);
    expect(got.map((x) => [x.capability, x.state]).sort()).toEqual([
      ['parallel-tool-calls', 'VERIFIED'],
      ['streaming-tool-calls', 'VERIFIED'],
      ['tool-use', 'VERIFIED'],
    ]);
    expect(got.every((x) => x.evidence_ref === `p3-envelope:${env.id}`)).toBe(true);
    const model = e.registry.get('claude')!.models()[0]!.modelId;
    expect((await svc.verifiedCapabilities()).get(`${providerId}|${model}|tool-use`)).toBe(
      e.registry.get('claude')!.contractVersion,
    );
    expect(
      p.capabilityEvidence.some((x) => x.capability === 'tool-use' && x.state === 'VERIFIED'),
    ).toBe(true);
  });
  it('dependent capabilities the record does not verify are recorded NOT VERIFIED, never VERIFIED', async () => {
    const env = await envelope({
      detail:
        'the probe verified tool-use (parallel calls NOT verified; streamed calls NOT verified)',
    });
    const before = (await rows()).length;
    await svc.ingestExecutorEvidence(actor(), providerId, env);
    const got = (await rows()).slice(before);
    expect(got.map((x) => [x.capability, x.state]).sort()).toEqual([
      ['parallel-tool-calls', 'NOT VERIFIED'],
      ['streaming-tool-calls', 'NOT VERIFIED'],
      ['tool-use', 'VERIFIED'],
    ]);
  });
  it.each([
    ['a mock twin run', { mode: 'mock' }],
    ['a record that is not LIVE-VERIFIED', { verdict: 'FAIL' }],
    ['a digest that does not match', { sha: false }],
  ] as const)('refuses %s and writes nothing', async (_n, over) => {
    const before = (await rows()).length;
    await expect(
      svc.ingestExecutorEvidence(actor(), providerId, await envelope(over)),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await rows()).length).toBe(before);
  });
  it('refuses another provider or contract, an overrun, a missing track-B record, key-shaped text and non-objects', async () => {
    const before = (await rows()).length;
    const base = await envelope();
    const bad: unknown[] = [
      { ...base, provider: 'openai' },
      { ...base, contractVersion: '1.0.0' },
      { ...base, model: 'some-other-model' },
      { ...base, cap: { overran: true } },
      { ...base, records: [] },
      { ...base, schema: 'x' },
      { ...base, note: `sk-ant-${'a'.repeat(30)}` },
      { ...base, id: 'not-a-uuid' },
      null,
      'text',
      [],
    ];
    for (const b of bad)
      await expect(svc.ingestExecutorEvidence(actor(), providerId, b)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    expect((await rows()).length).toBe(before);
  });
});
