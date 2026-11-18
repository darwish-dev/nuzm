import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlibabaEcsAdapter, AlibabaSim } from '@nuzm/adapter-alibaba-ecs';
import { createFetchTransport } from '@nuzm/adapter-http';
import { MemoryVaultClient } from '@nuzm/adapter-runtime';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { AdapterRegistry } from '../cloud';
import { ProviderCostCapture, VENDOR_EGRESS, vendorEntries } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;
const h = new Harness();
let app: App;
const staff: Record<string, Record<string, string>> = {};
const sql = (q: string, p: unknown[] = []) => h.env.sql(q, p) as Promise<Row[]>;
const admin = (who: string, method: 'GET' | 'POST', url: string, body?: object) =>
  app.inject({
    method,
    url,
    headers: { cookie: cookieHeader(staff[who]!), 'x-csrf-token': staff[who]!.nuzm_admin_csrf! },
    ...(body ? { payload: body } : {}),
  });
let providerIds: Record<string, string> = {};
let sim: AlibabaSim;
const KEY = 'vault://dev/test/alibaba-sim';
const lastMonth = (() => {
  const d = new Date();
  const y = d.getUTCMonth() === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  const m = d.getUTCMonth() === 0 ? 12 : d.getUTCMonth();
  return {
    cycle: `${y}-${String(m).padStart(2, '0')}`,
    from: `${y}-${String(m).padStart(2, '0')}-01T00:00:00Z`,
    to: new Date(Date.UTC(y, m, 0)).toISOString(),
  };
})();

beforeAll(async () => {
  await h.init();
  app = (await h.buildApp({}, undefined, [], { realAudit: false })).app;
  for (const [name, roles] of Object.entries({
    pa: ['platform_admin'],
    sec: ['security'],
    co: ['compliance_officer'],
    fin: ['finance'],
  }))
    staff[name] = (await h.platformUser(app, `vend-${name}`, roles)).jar;
  providerIds = Object.fromEntries(
    (await sql(`SELECT id, key FROM cloud.providers`)).map((r) => [r.key, r.id]),
  );
  sim = await new AlibabaSim(() => Date.now()).start();
  const registry = app.get(AdapterRegistry);
  // replace ONLY the transport: the Alibaba adapter talks to the documented-shape simulator on loopback (fixture evidence, NOT VERIFIED)
  const vault = new MemoryVaultClient({ [KEY]: { ...sim.credentials } }, registry.redactor);
  const [alibaba] = vendorEntries({
    vault,
    redactor: registry.redactor,
    transport: () =>
      createFetchTransport({
        policy: { adapterId: 'alibaba-ecs', hosts: ['127.0.0.1'], allowLoopback: true },
      }),
  });
  registry.register({
    ...alibaba!,
    create: () =>
      new AlibabaEcsAdapter({
        vault,
        redactor: registry.redactor,
        transport: createFetchTransport({
          policy: { adapterId: 'alibaba-ecs', hosts: ['127.0.0.1'], allowLoopback: true },
        }),
        endpoint: () => sim.baseUrl,
        bssEndpoint: sim.baseUrl,
      }),
  });
});
afterAll(async () => {
  await sim.stop();
  await h.close();
});

describe('vendor adapters in the registry', () => {
  it('are registered (documentation-built, NOT VERIFIED) and their egress equals spec/providers/providers.yaml', async () => {
    const r = await admin('pa', 'GET', '/v1/admin/providers');
    const by = Object.fromEntries(r.json().items.map((p: Row) => [p.key, p]));
    for (const k of ['alibaba', 'huawei', 'contabo']) expect(by[k].adapterAvailable).toBe(true);
    const yaml = readFileSync(
      join(__dirname, '../../../../../spec/providers/providers.yaml'),
      'utf8',
    );
    for (const [adapter, hosts] of Object.entries(VENDOR_EGRESS)) {
      const block = yaml.split('adapter: ' + adapter)[1]!.split('note:')[0]!;
      const listed = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(listed).toEqual([...hosts]);
    }
  });
});

describe('provider cost capture (fixture bills; NOT VERIFIED live)', () => {
  let acct: string;
  it('captures closed-month bills once (idempotent), accrues the ledger, keeps the provider currency; unknown instances stay unattributed', async () => {
    const created = await admin('pa', 'POST', '/v1/admin/provider-accounts', {
      providerId: providerIds.alibaba,
      name: 'cost-acct',
      credentialRef: KEY,
    });
    expect(created.statusCode).toBe(201);
    acct = created.json().id;
    sim.bills = [
      {
        InstanceID: 'i-orphan0001',
        PretaxAmount: 1.005,
        Currency: 'USD',
        BillingCycle: lastMonth.cycle,
        InstanceSpec: 'ecs.g6.large',
        BillingDate: `${lastMonth.cycle}-02`,
      },
      {
        InstanceID: 'i-orphan0002',
        PretaxAmount: 0.1,
        Currency: 'USD',
        BillingCycle: lastMonth.cycle,
        InstanceSpec: 'ecs.g6.large',
        BillingDate: `${lastMonth.cycle}-03`,
      },
    ];
    const cap = app.get(ProviderCostCapture);
    const r1 = await cap.capture(acct, { from: lastMonth.from, to: lastMonth.to });
    expect(r1).toMatchObject({ captured: 2, inserted: 2, unattributed: 2 });
    const r2 = await cap.capture(acct, { from: lastMonth.from, to: lastMonth.to });
    expect(r2).toMatchObject({ captured: 2, inserted: 0 });
    const rows = await sql(
      `SELECT cost_minor::text, currency::text, source, org_id FROM metering.provider_cost_records WHERE provider_account_id = $1 ORDER BY cost_minor`,
      [acct],
    );
    expect(rows.map((x) => [x.cost_minor, x.currency, x.source, x.org_id])).toEqual([
      ['10', 'USD', 'api', null],
      ['101', 'USD', 'api', null],
    ]);
    expect(
      await sql(`SELECT 1 FROM billing.ledger_transactions WHERE idempotency_key LIKE $1`, [
        `cost:${acct}:%`,
      ]),
    ).toHaveLength(2);
  });

  it('the current month is never captured ("for reference only" data changes)', async () => {
    const now = new Date();
    const cur = {
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
      to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString(),
    };
    expect(await app.get(ProviderCostCapture).capture(acct, cur)).toMatchObject({
      captured: 0,
      skipped: expect.stringContaining('not closed'),
    });
  });

  it('the RC-04 bill source carries the SAME line references as the recorded cost rows', async () => {
    const lines = await app.get(ProviderCostCapture).billSource()(
      lastMonth.from.slice(0, 10),
      lastMonth.to.slice(0, 10),
    );
    const refs = (
      await sql(
        `SELECT provider_line_ref FROM metering.provider_cost_records WHERE provider_account_id = $1`,
        [acct],
      )
    )
      .map((x) => x.provider_line_ref)
      .sort();
    expect(
      lines!
        .filter((l) => l.providerAccountId === acct)
        .map((l) => l.lineRef)
        .sort(),
    ).toEqual(refs);
    expect(lines!.find((l) => l.amountMinor === '101')).toMatchObject({ currency: 'USD' });
  });

  it('a provider without a billing API refuses automated capture; the manual import records bill_import rows with the evidence reference and rejects guesses', async () => {
    const c = (
      await admin('pa', 'POST', '/v1/admin/provider-accounts', {
        providerId: providerIds.contabo,
        name: 'contabo-cost',
        credentialRef: 'vault://dev/test/contabo-cost',
      })
    ).json();
    const cap = app.get(ProviderCostCapture);
    await expect(
      cap.capture(c.id, { from: lastMonth.from, to: lastMonth.to }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/unsupported_capability|credential/) });
    const ok = await cap.importManual(
      c.id,
      `period,reference,description,amount,currency\n${lastMonth.cycle},V153-1,Cloud VPS 4,12.50,EUR\n`,
      'evidence:bill-2026-contabo-1',
    );
    expect(ok).toMatchObject({ captured: 1, inserted: 1 });
    expect(
      (
        await sql(
          `SELECT source, evidence_ref, cost_minor::text FROM metering.provider_cost_records WHERE provider_account_id = $1`,
          [c.id],
        )
      )[0],
    ).toMatchObject({
      source: 'bill_import',
      evidence_ref: 'evidence:bill-2026-contabo-1',
      cost_minor: '1250',
    });
    await expect(
      cap.importManual(
        c.id,
        `period,reference,description,amount,currency\n${lastMonth.cycle},,x,1.234,EUR\n`,
        'evidence:x1',
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('GET /v1/admin/provider-costs lists with totals and a keyset cursor; finance may read; a compliance officer may not; no org can read it', async () => {
    const r = await admin(
      'fin',
      'GET',
      `/v1/admin/provider-costs?providerAccountId=${acct}&limit=1`,
    );
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.items).toHaveLength(1);
    expect(j.nextCursor).toBeTruthy();
    expect(j.totals).toEqual([{ currency: 'USD', costMinor: '111', records: 2, unattributed: 2 }]);
    const next = (
      await admin(
        'fin',
        'GET',
        `/v1/admin/provider-costs?providerAccountId=${acct}&limit=1&cursor=${j.nextCursor}`,
      )
    ).json();
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).not.toBe(j.items[0].id);
    expect(next.nextCursor).toBeNull();
    expect((await admin('co', 'GET', '/v1/admin/provider-costs')).statusCode).toBe(403);
    expect((await admin('pa', 'GET', '/v1/admin/provider-costs?period=2026-13')).statusCode).toBe(
      422,
    );
    expect((await app.inject({ method: 'GET', url: '/v1/admin/provider-costs' })).statusCode).toBe(
      401,
    );
  });

  it('no secret reaches the cost tables or the evidence (canary)', async () => {
    const secret = sim.credentials.accessKeySecret;
    const dump = JSON.stringify(
      await sql(`SELECT row_to_json(k)::text AS j FROM metering.provider_cost_records k`),
    );
    expect(dump.includes(secret)).toBe(false);
  });
});

describe('live-verification register (UI-M05-15)', () => {
  it('lists the three jobs as NOT RUN / PENDING until a human records a result; there is no route that starts a run', async () => {
    const j = (await admin('sec', 'GET', '/v1/admin/live-verification')).json();
    expect(j.jobs.map((x: Row) => [x.jobId, x.gate, x.gateStatus, x.label])).toEqual([
      ['live-verify-alibaba', 'HG-05-01', 'PENDING', 'NOT RUN'],
      ['live-verify-huawei', 'HG-05-02', 'PENDING', 'NOT RUN'],
      ['live-verify-contabo', 'HG-05-03', 'PENDING', 'NOT RUN'],
    ]);
    expect((await admin('pa', 'POST', '/v1/admin/live-verification/run', {})).statusCode).toBe(404);
    expect((await admin('pa', 'POST', '/v1/admin/live-verification/trigger', {})).statusCode).toBe(
      404,
    );
  });

  it('records a NOT VERIFIED run; LIVE-VERIFIED needs the gate evidence, evidence ids and zero residue (API and DB CHECK)', async () => {
    const ok = await admin('pa', 'POST', '/v1/admin/live-verification/runs', {
      jobId: 'live-verify-alibaba',
      status: 'NOT VERIFIED',
      reason: 'fixture run, evidence was not live',
      steps: [{ step: 'probe', status: 'pass' }],
    });
    expect(ok.statusCode).toBe(201);
    for (const bad of [
      { jobId: 'live-verify-alibaba', status: 'LIVE-VERIFIED', reason: 'x' },
      {
        jobId: 'live-verify-alibaba',
        status: 'LIVE-VERIFIED',
        reason: 'x',
        gateEvidenceId: 'HG-05-01:E1',
        evidenceIds: ['ev-1'],
        residualResources: 1,
      },
      { jobId: 'nope', status: 'FAIL', reason: 'x' },
    ])
      expect((await admin('pa', 'POST', '/v1/admin/live-verification/runs', bad)).statusCode).toBe(
        422,
      );
    await expect(
      sql(
        `INSERT INTO cloud.live_verification_runs (id, job_id, provider_key, gate, status, reason, recorded_by) VALUES (gen_random_uuid(), 'live-verify-alibaba','alibaba','HG-05-01','LIVE-VERIFIED','forged', gen_random_uuid())`,
      ),
    ).rejects.toThrow();
    const j = (await admin('sec', 'GET', '/v1/admin/live-verification')).json();
    expect(j.jobs[0]).toMatchObject({
      jobId: 'live-verify-alibaba',
      gateStatus: 'PENDING',
      label: 'NOT VERIFIED',
    });
    expect(
      (
        await admin('sec', 'POST', '/v1/admin/live-verification/runs', {
          jobId: 'live-verify-alibaba',
          status: 'FAIL',
          reason: 'x',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('is append-only and a live-verified run (with the owner evidence) flips the gate to GRANTED', async () => {
    const r = await admin('pa', 'POST', '/v1/admin/live-verification/runs', {
      jobId: 'live-verify-huawei',
      status: 'LIVE-VERIFIED',
      reason: 'unit fixture of the register only',
      gateEvidenceId: 'HG-05-02:TEST-1',
      evidenceIds: ['ev-test-1'],
      residualResources: 0,
      spendCapMinor: '1000',
      currency: 'USD',
    });
    expect(r.statusCode).toBe(201);
    const j = (await admin('pa', 'GET', '/v1/admin/live-verification')).json();
    expect(j.jobs.find((x: Row) => x.jobId === 'live-verify-huawei')).toMatchObject({
      gateStatus: 'GRANTED',
      label: 'LIVE-VERIFIED',
    });
    await expect(sql(`UPDATE cloud.live_verification_runs SET status = 'FAIL'`)).rejects.toThrow();
    await expect(sql(`DELETE FROM cloud.live_verification_runs`)).rejects.toThrow();
    // clean-up impossible by design: leave the harness DB (it is thrown away with the test database)
  });
});
