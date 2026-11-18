import 'reflect-metadata';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../../common/tokens';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { AlertService } from './alerts.service';
import { HealthService } from './health.service';
import { MetricsService } from './metrics.service';
import { ProbeRunner } from './probes.service';
import { ProviderIncidentService } from './provider-incidents.service';
import { TechnicalReconciliationService, type TrSources } from './technical-reconciliation.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON in tests */
const h = new Harness();
let app: App;
let ops: { id: string; jar: Record<string, string> };
let support: { id: string; jar: Record<string, string> };
let seq = 0;
const sql = (q: string, p?: unknown[]) => h.env.sql(q, p);
const call = (
  who: { jar: Record<string, string> },
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: object,
  key: string | null = `k-${++seq}`,
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(who.jar),
      'x-csrf-token': who.jar.nuzm_admin_csrf!,
      ...(key && method === 'POST' ? { 'idempotency-key': key } : {}),
    },
    ...(body ? { payload: body } : {}),
  });

/** Inserts fixture rows with FK checks and triggers off (one connection): the reconcilers read these tables, they do not own them. */
async function fixture(fn: (c: Client) => Promise<void>) {
  const c = new Client({ connectionString: h.env.adminUrl });
  await c.connect();
  try {
    await c.query('SET session_replication_role = replica');
    await fn(c);
  } finally {
    await c.end();
  }
}
const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  ops = await h.platformUser(app, 'ops-1', ['platform_admin']);
  support = await h.platformUser(app, 'support-1', ['support']);
});
afterAll(() => h.close());

describe('incidents', () => {
  let inc: any;
  it('opens an incident (idempotent), keeps a timeline, and refuses personal data', async () => {
    const key = 'inc-1';
    const r = await call(
      ops,
      'POST',
      '/v1/admin/incidents',
      {
        severity: 'SEV2',
        title: 'Hosting node degraded',
        components: ['hosting.node-1'],
        summary: 'Elevated error rate on node one',
      },
      key,
    );
    expect(r.statusCode).toBe(201);
    inc = r.json();
    expect(inc.timeline.map((t: any) => t.kind)).toEqual(['opened']);
    const again = await call(
      ops,
      'POST',
      '/v1/admin/incidents',
      { severity: 'SEV2', title: 'Hosting node degraded' },
      key,
    );
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(inc.id);
    const pii = await call(ops, 'POST', '/v1/admin/incidents', {
      severity: 'SEV3',
      title: 'Customer alice@example.com cannot log in',
    });
    expect(pii.statusCode).toBe(422);
    expect(
      (await call(ops, 'POST', '/v1/admin/incidents', { severity: 'SEV9', title: 'x y z' }))
        .statusCode,
    ).toBe(422);
  });
  it('moves through the severity workflow; closed is terminal; support can read but not write', async () => {
    const p = (b: object) => call(ops, 'PATCH', `/v1/admin/incidents/${inc.id}`, b);
    expect((await p({ status: 'closed' })).statusCode).toBe(409); // open -> closed is not a step
    const a = await p({
      status: 'investigating',
      severity: 'SEV1',
      note: 'paging the on-call role',
      commsDraft: 'We are investigating degraded hosting.',
    });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ status: 'investigating', severity: 'SEV1' });
    expect(a.json().timeline.map((t: any) => t.kind)).toEqual([
      'opened',
      'status_change',
      'severity_change',
      'note',
      'comms_draft',
    ]);
    expect((await p({ status: 'resolved' })).json().resolvedAt).toBeTruthy();
    expect((await p({ status: 'closed' })).json().closedAt).toBeTruthy();
    expect((await p({ note: 'after close' })).statusCode).toBe(409);
    expect(
      (await call(support, 'GET', '/v1/admin/incidents')).json().items.length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (
        await call(support, 'POST', '/v1/admin/incidents', {
          severity: 'SEV4',
          title: 'support tries',
        })
      ).statusCode,
    ).toBe(403);
    const unknownBreach = await call(ops, 'POST', '/v1/admin/incidents', {
      severity: 'SEV1',
      title: 'Suspected breach',
      breachCaseId: uuid(),
    });
    expect(unknownBreach.statusCode).toBe(422);
  });
  it('audits opened/closed and the timeline table is append-only', async () => {
    const acts = (
      await sql(`SELECT action FROM audit.audit_logs WHERE action LIKE 'ops.incident.%'`)
    ).map((r) => r.action);
    expect(acts).toContain('ops.incident.opened');
    expect(acts).toContain('ops.incident.closed');
    await expect(sql(`UPDATE ops.incident_updates SET body = 'x'`)).rejects.toThrow();
    await expect(sql(`DELETE FROM ops.incident_updates`)).rejects.toThrow();
  });
});

describe('alerts', () => {
  it('seeds default rules, each with an owner role, severity and runbook', async () => {
    const r = (await call(ops, 'GET', '/v1/admin/alerts?limit=50')).json();
    expect(r.items.length).toBeGreaterThanOrEqual(9);
    for (const a of r.items) {
      expect(a.runbookUrl).toMatch(/^docs\/runbooks\/.+\.md$/);
      expect(a.ownerRole).toMatch(/^[a-z_]+$/);
    }
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const a of r.items)
      expect(
        fs.existsSync(path.join(__dirname, '../../../../../', a.runbookUrl)),
        a.runbookUrl,
      ).toBe(true);
  });
  it('evaluates, acknowledges, silences with an expiry, and never reports ok for an unmeasured metric', async () => {
    const svc = app.get(AlertService);
    const ch = await svc.evaluate({ 'queue.max_lag_seconds': 900 });
    expect(ch).toEqual([{ rule: 'queue.lag', from: 'ok', to: 'firing' }]);
    const unevaluated = (await call(ops, 'GET', '/v1/admin/alerts?limit=50'))
      .json()
      .items.find((a: any) => a.ruleKey === 'api.5xx_rate');
    expect(unevaluated.state).toBe('ok');
    expect(unevaluated.lastEvaluatedAt).toBeNull(); // NOT EVALUATED, not "evaluated ok"
    const ack = await call(ops, 'POST', '/v1/admin/alerts', {
      action: 'acknowledge',
      ruleKey: 'queue.lag',
    });
    expect(ack.json().state).toBe('acknowledged');
    expect((await svc.evaluate({ 'queue.max_lag_seconds': 1000 })).length).toBe(0); // stays acknowledged
    expect((await svc.evaluate({ 'queue.max_lag_seconds': 5 }))[0]).toMatchObject({ to: 'ok' });
    expect(
      (await call(ops, 'POST', '/v1/admin/alerts', { action: 'acknowledge', ruleKey: 'queue.lag' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call(ops, 'POST', '/v1/admin/alerts', { action: 'silence', ruleKey: 'queue.lag' }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await call(ops, 'POST', '/v1/admin/alerts', {
          action: 'silence',
          ruleKey: 'queue.lag',
          until: new Date(Date.now() + 90 * 86400_000).toISOString(),
        })
      ).statusCode,
    ).toBe(422);
    const sil = await call(ops, 'POST', '/v1/admin/alerts', {
      action: 'silence',
      ruleKey: 'queue.lag',
      until: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(sil.json().state).toBe('silenced');
    expect((await svc.evaluate({ 'queue.max_lag_seconds': 999 })).length).toBe(0); // silenced: no change
    const later = new Date(Date.now() + 2 * 3600_000);
    expect((await svc.evaluate({ 'queue.max_lag_seconds': 999 }, later))[0]).toMatchObject({
      from: 'silenced',
      to: 'firing',
    }); // expiry
  });
  it('defining a rule needs a runbook and a role; replay is a no-op', async () => {
    const good = {
      action: 'define',
      ruleKey: 'custom.probe_slow',
      title: 'Probe slow',
      severity: 'warning',
      ownerRole: 'sre',
      runbookUrl: 'docs/runbooks/incident-response.md',
      rule: { metric: 'probe.p95_ms', op: '>', threshold: 2000 },
    };
    expect(
      (await call(ops, 'POST', '/v1/admin/alerts', { ...good, runbookUrl: 'nowhere' })).statusCode,
    ).toBe(422);
    expect(
      (await call(ops, 'POST', '/v1/admin/alerts', { ...good, ownerRole: 'Alice Smith' }))
        .statusCode,
    ).toBe(422);
    expect((await call(ops, 'POST', '/v1/admin/alerts', good)).statusCode).toBe(201);
    expect((await call(ops, 'POST', '/v1/admin/alerts', good)).statusCode).toBe(200);
  });
});

describe('recovery exercises', () => {
  const base = () => {
    const started = new Date(Date.now() - 3 * 3600_000);
    const restored = new Date(started.getTime() + 2 * 3600_000 + 5 * 60_000 + 7_000);
    return {
      scope: 'control_plane_db',
      environment: 'local',
      startedAt: started.toISOString(),
      restoredAt: restored.toISOString(),
      rpoSeconds: 420,
      rtoSeconds: 2 * 3600 + 5 * 60 + 7,
      evidenceRefs: ['docs/runbooks/db-restore.md#run-2026-11-18'],
    };
  };
  it('records MEASURED values, derives the result from the D-30 targets, and is idempotent', async () => {
    const key = 'dr-1';
    const r = await call(ops, 'POST', '/v1/admin/recovery-exercises', base(), key);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      result: 'pass',
      rpoSeconds: 420,
      targetRpoSeconds: 900,
      targetRtoSeconds: 14400,
    });
    expect((await call(ops, 'POST', '/v1/admin/recovery-exercises', base(), key)).statusCode).toBe(
      200,
    );
    const slow = { ...base(), rpoSeconds: 1200 };
    const f = await call(ops, 'POST', '/v1/admin/recovery-exercises', slow);
    expect(f.json().result).toBe('fail');
  });
  it('refuses an estimated RTO, a wrong result, a future restore time and missing evidence', async () => {
    expect(
      (await call(ops, 'POST', '/v1/admin/recovery-exercises', { ...base(), rtoSeconds: 3600 }))
        .statusCode,
    ).toBe(422);
    expect(
      (await call(ops, 'POST', '/v1/admin/recovery-exercises', { ...base(), result: 'fail' }))
        .statusCode,
    ).toBe(422);
    expect(
      (await call(ops, 'POST', '/v1/admin/recovery-exercises', { ...base(), evidenceRefs: [] }))
        .statusCode,
    ).toBe(422);
    const future = { ...base(), restoredAt: new Date(Date.now() + 86400_000).toISOString() };
    expect((await call(ops, 'POST', '/v1/admin/recovery-exercises', future)).statusCode).toBe(422);
    await expect(sql(`UPDATE ops.recovery_exercises SET result = 'pass'`)).rejects.toThrow();
    expect(
      (await call(ops, 'GET', '/v1/admin/recovery-exercises?scope=control_plane_db')).json().items
        .length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('health, probes and provider incidents', () => {
  it('reports unmeasured things as unknown / not_measured, and never counts fixture probes as availability', async () => {
    const hr = (await call(ops, 'GET', '/v1/admin/operations/health')).json();
    expect(hr.components.find((c: any) => c.key === 'probes').status).toBe('unknown');
    expect(hr.sloBurn[0]).toMatchObject({
      sloKey: 'api.availability',
      measured: null,
      status: 'not_measured',
    });
    const runner = app.get(ProbeRunner);
    const res = await runner.runAll([
      { key: 'login', mode: 'fixture', run: async () => ({ ok: true }) },
    ]);
    expect(res.notConfigured).toEqual([
      'quote',
      'provisioning_mock',
      'payment_sandbox',
      'dns_change',
    ]);
    expect((await call(ops, 'GET', '/v1/admin/operations/health')).json().sloBurn[0].status).toBe(
      'not_measured',
    );
    await runner.runAll([
      { key: 'login', mode: 'sandbox', run: async () => ({ ok: true }) },
      {
        key: 'login',
        mode: 'sandbox',
        run: async () => {
          throw new Error('boom');
        },
      },
    ]);
    const after = (await call(ops, 'GET', '/v1/admin/operations/health')).json();
    expect(after.sloBurn[0]).toMatchObject({ measured: 50, status: 'burning' });
    expect(after.alerts).toBeDefined();
    expect(after.reconcilers.financialLastRunAt).toBeNull();
    const m = await app.get(MetricsService).collect();
    expect(m['probe.consecutive_failures']).toBe(1);
    expect(m['dr.days_since_exercise']).toBe(9999); // only a local exercise exists: not counted as production DR
  });
  it('ingests provider incidents idempotently and lists them', async () => {
    const svc = app.get(ProviderIncidentService);
    const first = await svc.ingest({
      providerKey: 'alibaba',
      externalRef: 'inc-77',
      status: 'investigating',
      title: 'ECS API elevated latency',
      startedAt: new Date(),
    });
    const upd = await svc.ingest({
      providerKey: 'alibaba',
      externalRef: 'inc-77',
      status: 'resolved',
      title: 'ECS API elevated latency',
      startedAt: new Date(),
    });
    expect(upd.id).toBe(first.id);
    const list = (
      await call(ops, 'GET', '/v1/admin/provider-incidents?providerKey=alibaba')
    ).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ status: 'resolved' });
    expect(list.items[0].resolvedAt).toBeTruthy();
    expect(app.get(HealthService)).toBeDefined();
  });
});

describe('technical reconciliation TR-01..TR-04 (fixtures: NOT VERIFIED against real providers)', () => {
  const org = uuid();
  const acct = uuid();
  const node = uuid();
  const plan = uuid();
  const regAcct = uuid();
  const resUnknown = uuid();
  const resActive = uuid();
  const siteNoAlloc = uuid();
  const siteOk = uuid();
  const dom = uuid();
  const dom2 = uuid();
  let sources: TrSources;
  const mk = () => new TechnicalReconciliationService(app.get(DB), { record() {} } as any, sources);

  beforeAll(async () => {
    await fixture(async (c) => {
      await c.query(
        `INSERT INTO cloud.provider_accounts (id, provider_id, name, vault_ref, created_by) VALUES ($1,$2,'a','vault://dev/tr-test',$3)`,
        [acct, uuid(), uuid()],
      );
      await c.query(
        `INSERT INTO cloud.resources (id, org_id, kind, provider_account_id, provider_ref, state, data_region, country, provider_region_id, updated_at) VALUES ($1,$2,'compute_instance',$3,'i-unknown','UNKNOWN','x','SA','r', now() - interval '3 hours')`,
        [resUnknown, org, acct],
      );
      await c.query(
        `INSERT INTO cloud.resources (id, org_id, kind, provider_account_id, provider_ref, state, data_region, country, provider_region_id) VALUES ($1,$2,'compute_instance',$3,'i-gone','ACTIVE','x','SA','r')`,
        [resActive, org, acct],
      );
      await c.query(
        `INSERT INTO hosting.nodes (id, name, compute_instance_id, region, data_region, status, health, runtimes) VALUES ($1,'tr-node','ci','r','SA','active','healthy','["php:8.3"]')`,
        [node],
      );
      await c.query(
        `INSERT INTO hosting.node_capacity (node_id, dim, physical, sellable) VALUES ($1,'cpu_millicores',1000,1000)`,
        [node],
      );
      await c.query(
        `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, data_region, status, node_id) VALUES ($1,$2,'a',$3,'s-aaaaaaaaaaaa',$4,'static','SA','active',$5)`,
        [siteNoAlloc, org, 'a'.repeat(64), plan, node],
      );
      await c.query(
        `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, data_region, status, node_id) VALUES ($1,$2,'b',$3,'s-bbbbbbbbbbbb',$4,'static','SA','active',$5)`,
        [siteOk, org, 'b'.repeat(64), plan, node],
      );
      await c.query(
        `INSERT INTO hosting.site_allocations (site_id, node_id, cpu_millicores, memory_mb, disk_mb) VALUES ($1,$2,1500,10,10)`,
        [siteOk, node],
      ); // oversold: 1500 > sellable 1000
      await c.query(
        `INSERT INTO domains.domains (id, org_id, name, tld, registrar_account_id, data_region, state, provider_ref, expires_at) VALUES ($1,$2,'ours.example','example',$3,'SA','active','p1', '2027-01-01'), ($4,$2,'gone.example','example',$3,'SA','active','p2','2027-01-01')`,
        [dom, org, regAcct, dom2],
      );
    });
  });

  it('with no provider source the provider half is NOT EVALUATED and the run is database_only; DB-only checks still find drift', async () => {
    sources = {
      mode: 'database_only',
      computeInventory: async () => null,
      nodeSites: async () => null,
      registrarDomains: async () => null,
      providerObjects: async () => null,
    };
    const r1 = await mk().run('TR-01', null);
    expect(r1.notEvaluated).toContain('provider inventory');
    expect(r1.findings.map((f) => f.kind)).toEqual(['unknown_state_over_1h']);
    const r2 = await mk().run('TR-02', null);
    expect(r2.findings.map((f) => f.kind).sort()).toEqual([
      'oversold_node',
      'site_without_allocation',
    ]);
    expect(r2.notEvaluated).toContain('node report');
    expect((await mk().run('TR-03', null)).notEvaluated).toContain('registrar state');
  });

  it('detects 100 % of injected discrepancies against fixture sources and records them in cloud.resource_reconciliations', async () => {
    sources = {
      mode: 'fixture',
      computeInventory: async () => [
        { ref: 'i-unknown', state: 'running' },
        { ref: 'i-orphan', state: 'running' },
        { ref: 'i-old', state: 'terminated' },
      ],
      nodeSites: async () => ['s-bbbbbbbbbbbb', 's-ghost000000'],
      registrarDomains: async () => [
        { name: 'ours.example', state: 'active', expiresAt: '2027-03-01T00:00:00Z' },
        { name: 'stranger.example', state: 'active' },
      ],
      providerObjects: async () => [],
    };
    const t1 = await mk().run('TR-01', ops.id);
    expect(t1.findings.map((f) => `${f.kind}:${f.subjectRef}`).sort()).toEqual(
      [
        `missing_at_provider:${resActive}`,
        'orphaned_billable_resource:i-orphan',
        `unknown_state_over_1h:${resUnknown}`,
      ].sort(),
    );
    const t2 = await mk().run('TR-02', ops.id);
    expect(t2.findings.map((f) => f.kind).sort()).toEqual([
      'oversold_node',
      'site_missing_on_node',
      'site_unknown_to_platform',
      'site_without_allocation',
    ]);
    const t3 = await mk().run('TR-03', ops.id);
    expect(t3.findings.map((f) => f.kind).sort()).toEqual([
      'domain_missing_at_registrar',
      'domain_unknown_to_platform',
      'expiry_mismatch',
    ]);
    expect(t3.mode).toBe('fixture');
    const rows = await sql(
      `SELECT tr_type, result, evidence_mode FROM cloud.resource_reconciliations WHERE tr_type IS NOT NULL`,
    );
    expect(rows.filter((r) => r.tr_type === 'TR-03' && r.evidence_mode === 'fixture').length).toBe(4); // 3 findings + the run summary row
    expect(
      rows.every((r) => ['fixture', 'database_only'].includes(r.evidence_mode as string)),
    ).toBe(true);
    const audits = (
      await sql(
        `SELECT count(*)::int AS n FROM audit.audit_logs WHERE action = 'reconciliation.technical.findings'`,
      )
    )[0]!.n;
    expect(audits).toBeGreaterThanOrEqual(3);
  });

  it('clean data yields zero findings and a recorded in_sync row', async () => {
    await fixture(async (c) => {
      await c.query(
        `DELETE FROM hosting.sites; DELETE FROM hosting.site_allocations; DELETE FROM domains.domains; DELETE FROM cloud.resources`,
      );
    });
    sources = {
      mode: 'fixture',
      computeInventory: async () => [],
      nodeSites: async () => [],
      registrarDomains: async () => [],
      providerObjects: async () => [],
    };
    for (const t of ['TR-01', 'TR-02', 'TR-03', 'TR-04'] as const) {
      const r = await mk().run(t, null);
      expect(r.findings, t).toEqual([]);
    }
    const clean = await sql(
      `SELECT count(*)::int AS n FROM cloud.resource_reconciliations WHERE subject_kind = 'run' AND result = 'in_sync'`,
    );
    expect(clean[0]!.n).toBeGreaterThanOrEqual(4);
  });
});
