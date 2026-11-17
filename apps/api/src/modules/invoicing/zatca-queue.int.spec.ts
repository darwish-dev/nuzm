import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import {
  CreditNoteService,
  InvoiceService,
  ZatcaOnboardingService,
  ZatcaPipelineService,
  ZatcaSubmissionService,
} from './index';
import { ZatcaDocumentService } from './index';
import { DevFileVault } from './internal/zatca/signing';
import { SimulatedZatca } from './internal/zatca/simulated-adapter';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

const tmp = mkdtempSync(join(tmpdir(), 'zatca-queue-'));
process.env.ZATCA_MODE = 'sandbox';
process.env.ZATCA_ARCHIVE_DIR = join(tmp, 'archive');
process.env.ZATCA_DEV_VAULT_DIR = join(tmp, 'vault');

const VAT = '300000000000003';
const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
let entity = '';
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};
const staff: Record<string, Record<string, string>> = {};
let seq = 0;
const T0 = new Date('2026-11-17T09:00:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

const sql = (q: string, p: unknown[] = []) => h.env.sql(q, p) as Promise<Row[]>;
const count = async (q: string, p: unknown[] = []) => Number((await sql(q, p))[0]!.n);
const sim = () => app.get(SimulatedZatca);
const subs = () => app.get(ZatcaSubmissionService);
const docs = () => app.get(ZatcaDocumentService);
const pipeline = () =>
  new ZatcaPipelineService(
    (docs() as any).db,
    docs(),
    subs(),
    app.get(DevFileVault),
    new Date('2026-01-01T00:00:00Z'),
  );
const admin = (who: string, method: 'GET' | 'POST', url: string, body?: object) =>
  app.inject({
    method,
    url,
    headers: { cookie: cookieHeader(staff[who]!), 'x-csrf-token': staff[who]!.nuzm_admin_csrf! },
    ...(body ? { payload: body } : {}),
  });
const step = (who: string, body: object) =>
  admin(who, 'POST', '/v1/admin/billing/zatca/onboarding', body);
const mkInvoice = async (org: string, net = '10000') => {
  const n = ++seq;
  const r = await app.get(InvoiceService).issueSubscriptionCharge(
    org,
    {
      sourceKey: `zq-${n}`,
      currency: 'SAR',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      lines: [
        {
          description: `Fee ${n}`,
          quantity: '1',
          unit: 'subscription_period',
          netMinor: net,
          meterId: null,
          sourceId: `zq-line-${n}`,
        },
      ],
    },
    null,
    at(0),
  );
  return r.invoice.id;
};
const stateOf = async (docId: string) =>
  (
    await sql(
      `SELECT state, attempt, dead_letter, next_attempt_at, response FROM invoicing.zatca_submissions WHERE document_id = $1 ORDER BY seq DESC LIMIT 1`,
      [docId],
    )
  )[0]!;
const docOf = async (source: string) =>
  (await sql(`SELECT id FROM invoicing.zatca_documents WHERE source_id = $1`, [source]))[0]!
    .id as string;
const trail = async (docId: string) =>
  (
    await sql(`SELECT state FROM invoicing.zatca_submissions WHERE document_id = $1 ORDER BY seq`, [
      docId,
    ])
  ).map((r) => r.state as string);

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  for (const [name, roles] of Object.entries({
    fin1: ['finance'],
    sup: ['support'],
    sec1: ['security'],
    sec2: ['security'],
  })) {
    const u = await h.platformUser(app, `staff-${name}`, roles);
    ids[name] = u.id;
    staff[name] = u.jar;
  }
  const mk = async (who: string, name: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie: cookieHeader(jars[who]!), 'x-csrf-token': jars[who]!.nuzm_csrf! },
        payload: { name },
      })
    ).json().id as string;
  orgA = await mk('alice', 'ZQ A');
  orgB = await mk('bob', 'ZQ B');
  entity = (
    await sql(
      `SELECT id FROM invoicing.billing_entities WHERE status = 'active' ORDER BY created_at LIMIT 1`,
    )
  )[0]!.id;
  await sql(
    `UPDATE invoicing.billing_entities SET placeholder = false, vat_number = $2, cr_number = '1010000001', address = '{"city":"Riyadh","country":"SA","street":"King Fahd Road"}' WHERE id = $1`,
    [entity, VAT],
  );
  const put = await app.inject({
    method: 'PUT',
    url: '/v1/billing/tax-profile',
    headers: {
      cookie: cookieHeader(jars.bob!),
      'x-csrf-token': jars.bob!.nuzm_csrf!,
      'x-nuzm-org': orgB,
    },
    payload: {
      buyerType: 'b2b',
      legalName: { ar: 'شركة الأفق', en: 'Horizon Co' },
      vatNumber: VAT,
      crNumber: '1010000000',
      address: {
        street: 'Tahlia',
        buildingNumber: '1234',
        district: 'Olaya',
        city: 'Jeddah',
        postalCode: '12211',
        country: 'SA',
      },
    },
  });
  expect([200, 201], put.body).toContain(put.statusCode);
});
afterAll(async () => {
  await h.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('before onboarding', () => {
  it('documents are generated but wait for credentials; nothing is stamped or submitted; standard invoices are held', async () => {
    const simpl = await mkInvoice(orgA);
    const std = await mkInvoice(orgB);
    const r = await pipeline().run(at(10));
    expect(r).toMatchObject({ generated: 2, stamped: 0, waitingForCredentials: 2, queued: 0 });
    expect(await trail(await docOf(simpl))).toEqual(['generated']);
    await expect(
      subs().assertDeliverable(orgB, { id: std, buyer: { buyerType: 'b2b', vatNumber: VAT } }),
    ).rejects.toMatchObject({ detail: expect.stringMatching(/only after clearance/) });
    await expect(
      subs().assertDeliverable(orgA, { id: simpl, buyer: { buyerType: 'b2c', vatNumber: null } }),
    ).resolves.toBeUndefined(); // simplified is not held
    // the XML is not available yet and the invoice says where it stands
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/billing/invoices/${std}/xml`,
          headers: { cookie: cookieHeader(jars.bob!), 'x-nuzm-org': orgB },
        })
      ).statusCode,
    ).toBe(409);
    const inv = await app.inject({
      method: 'GET',
      url: `/v1/billing/invoices/${std}`,
      headers: { cookie: cookieHeader(jars.bob!), 'x-nuzm-org': orgB },
    });
    expect(inv.json().zatca).toMatchObject({ state: 'generated', qr: null });
    expect(sim().submissions).toBe(0);
  });
});

describe('onboarding (simulated server; two people for every credential step)', () => {
  it('starts not_started and refuses out-of-order steps, other environments, production and junk', async () => {
    const v = (await admin('fin1', 'GET', '/v1/admin/billing/zatca/onboarding')).json().items[0];
    expect(v).toMatchObject({
      environment: 'sandbox',
      state: 'not_started',
      onboarded: false,
      notVerifiedVsZatca: true,
      credentials: [],
      steps: [],
    });
    expect(
      (await step('fin1', { environment: 'sandbox', step: 'compliance_csid' })).statusCode,
    ).toBe(409);
    expect(
      (await step('fin1', { environment: 'sandbox', step: 'production_csid' })).statusCode,
    ).toBe(409);
    expect((await step('fin1', { environment: 'production', step: 'csr' })).statusCode).toBe(422);
    expect((await step('fin1', { environment: 'simulation', step: 'csr' })).statusCode).toBe(422); // only the enabled environment
    expect((await step('fin1', { environment: 'sandbox', step: 'nope' })).statusCode).toBe(422);
    expect((await step('fin1', { environment: 'sandbox', step: 'csr', extra: 1 })).statusCode).toBe(
      422,
    );
    expect((await admin('sup', 'GET', '/v1/admin/billing/zatca/onboarding')).statusCode).toBe(403);
    expect((await step('sup', { environment: 'sandbox', step: 'csr' })).statusCode).toBe(403);
    expect((await step('sec1', { environment: 'sandbox', step: 'csr' })).statusCode).toBe(403); // security approves, it does not request
  });

  it('csr: the requester cannot approve; one pending request at a time; a rejection frees the slot', async () => {
    const r1 = await step('fin1', { environment: 'sandbox', step: 'csr' });
    expect(r1.statusCode).toBe(201);
    expect(r1.json()).toMatchObject({ status: 'pending_approval', step: 'csr', decidedBy: null });
    expect((await step('fin1', { stepId: r1.json().id, decision: 'approve' })).statusCode).toBe(
      403,
    ); // not an approver at all
    expect((await step('fin1', { environment: 'sandbox', step: 'csr' })).statusCode).toBe(409); // already waiting
    const rej = await step('sec1', { stepId: r1.json().id, decision: 'reject' });
    expect(rej.statusCode).toBe(200);
    expect(rej.json().status).toBe('rejected');
    expect((await step('sec1', { stepId: r1.json().id, decision: 'approve' })).statusCode).toBe(
      409,
    ); // already decided
    const r2 = await step('fin1', { environment: 'sandbox', step: 'csr' });
    expect(r2.statusCode).toBe(201);
    const ok = await step('sec1', { stepId: r2.json().id, decision: 'approve' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'completed', decidedBy: ids.sec1 });
    expect(ok.json().result.csrPem).toMatch(/BEGIN CERTIFICATE REQUEST/);
    expect(JSON.stringify(ok.json())).not.toMatch(/PRIVATE KEY/);
    expect((await step('fin1', { environment: 'sandbox', step: 'csr' })).statusCode).toBe(409); // already completed
    expect(
      await count(
        `SELECT count(*)::int n FROM invoicing.zatca_credentials_refs WHERE kind = 'csr_key' AND key_ref ~ '^vault://dev/zatca/'`,
      ),
    ).toBe(1);
  });

  it('compliance credential: needs the one-time password; a bad one fails the step and can be requested again; the OTP and secrets are never stored', async () => {
    const r = await step('fin1', { environment: 'sandbox', step: 'compliance_csid' });
    expect(r.statusCode).toBe(201);
    expect((await step('sec1', { stepId: r.json().id, decision: 'approve' })).statusCode).toBe(422); // OTP missing
    const bad = await step('sec1', { stepId: r.json().id, decision: 'approve', otp: '12' });
    expect(bad.json()).toMatchObject({ status: 'failed' });
    expect(bad.json().result.error).toMatch(/one-time password/);
    const r2 = await step('fin1', { environment: 'sandbox', step: 'compliance_csid' });
    const ok = await step('sec2', { stepId: r2.json().id, decision: 'approve', otp: '482913' });
    expect(ok.json()).toMatchObject({ status: 'completed', decidedBy: ids.sec2 });
    expect(ok.json().result.serial).toMatch(/^SIM-COMPLIANCE-/);
    for (const needle of ['482913', 'sim_compliance_tok', 'sim_compliance_sec']) {
      expect(
        await count(
          `SELECT count(*)::int n FROM invoicing.zatca_onboarding WHERE result::text LIKE '%' || $1 || '%'`,
          [needle],
        ),
      ).toBe(0);
      expect(
        await count(
          `SELECT count(*)::int n FROM invoicing.zatca_credentials_refs WHERE token_ref LIKE '%' || $1 || '%' OR secret_ref LIKE '%' || $1 || '%'`,
          [needle],
        ),
      ).toBe(0);
      expect(
        await count(
          `SELECT count(*)::int n FROM audit.audit_logs WHERE (detail::text || coalesce(after::text,'') || coalesce(before::text,'')) LIKE '%' || $1 || '%'`,
          [needle],
        ),
      ).toBe(0);
    }
    expect(
      await count(
        `SELECT count(*)::int n FROM invoicing.zatca_credentials_refs WHERE kind = 'compliance_csid' AND token_ref ~ '^vault://dev/zatca/' AND secret_ref ~ '^vault://dev/zatca/'`,
      ),
    ).toBe(1);
  });

  it('compliance checks run at once with sample documents (never stored, never in the chain); the production credential completes the onboarding', async () => {
    const chainBefore = await count(
      `SELECT count(*)::int n FROM invoicing.zatca_documents WHERE entity_id = $1`,
      [entity],
    );
    const c = await step('fin1', { environment: 'sandbox', step: 'compliance_checks' });
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ status: 'completed', decidedBy: ids.fin1 });
    expect(
      c.json().result.checks.map((x: Row) => `${x.documentType}/${x.subtype}/${x.status}`),
    ).toEqual([
      'invoice/standard/cleared',
      'invoice/simplified/reported',
      'credit_note/standard/cleared',
    ]);
    expect(
      await count(`SELECT count(*)::int n FROM invoicing.zatca_documents WHERE entity_id = $1`, [
        entity,
      ]),
    ).toBe(chainBefore);
    const p = await step('fin1', { environment: 'sandbox', step: 'production_csid' });
    const ok = await step('sec1', { stepId: p.json().id, decision: 'approve' });
    expect(ok.json()).toMatchObject({ status: 'completed' });
    const v = (
      await admin('fin1', 'GET', '/v1/admin/billing/zatca/onboarding?environment=sandbox')
    ).json().items[0];
    expect(v).toMatchObject({ state: 'production_csid', onboarded: true });
    expect(v.credentials.map((x: Row) => x.kind).sort()).toEqual([
      'compliance_csid',
      'csr_key',
      'production_csid',
    ]);
    expect(JSON.stringify(v)).not.toMatch(/vault:\/\/|sim_/); // references and secrets are not even shown
  });
});

describe('the submission pipeline', () => {
  it('stamps, queues and submits what was waiting; standard is cleared (and delivered), simplified is reported; repeating changes nothing', async () => {
    const r = await pipeline().run(at(100));
    expect(r).toMatchObject({ generated: 0, stamped: 2, queued: 2, waitingForCredentials: 0 });
    expect(r.submitted).toMatchObject({ cleared: 1, reported: 1, rejected: 0, failed: 0 });
    const [simplId, stdId] = [
      (
        await sql(
          `SELECT source_id FROM invoicing.zatca_documents WHERE subtype = 'simplified' LIMIT 1`,
        )
      )[0]!.source_id,
      (
        await sql(
          `SELECT source_id FROM invoicing.zatca_documents WHERE subtype = 'standard' LIMIT 1`,
        )
      )[0]!.source_id,
    ];
    expect(await trail(await docOf(stdId))).toEqual([
      'generated',
      'stamped',
      'queued',
      'submitted',
      'cleared',
    ]);
    expect(await trail(await docOf(simplId))).toEqual([
      'generated',
      'stamped',
      'queued',
      'submitted',
      'reported',
    ]);
    await expect(
      subs().assertDeliverable(orgB, { id: stdId, buyer: { buyerType: 'b2b', vatNumber: VAT } }),
    ).resolves.toBeUndefined();
    const inv = await app.inject({
      method: 'GET',
      url: `/v1/billing/invoices/${stdId}`,
      headers: { cookie: cookieHeader(jars.bob!), 'x-nuzm-org': orgB },
    });
    expect(inv.json().zatca).toMatchObject({ state: 'cleared' });
    expect(inv.json().zatca.qr).toBeTruthy();
    const xml = await app.inject({
      method: 'GET',
      url: `/v1/billing/invoices/${stdId}/xml`,
      headers: { cookie: cookieHeader(jars.bob!), 'x-nuzm-org': orgB },
    });
    expect(xml.statusCode).toBe(200);
    expect(xml.headers['content-type']).toMatch(/application\/xml/);
    expect(xml.body).toContain('SIMULATED-CLEARANCE'); // the cleared XML, not the stamped one
    const sx = await app.inject({
      method: 'GET',
      url: `/v1/billing/invoices/${simplId}/xml`,
      headers: { cookie: cookieHeader(jars.alice!), 'x-nuzm-org': orgA },
    });
    expect(sx.statusCode).toBe(200);
    expect(sx.body).not.toContain('SIMULATED-CLEARANCE');
    expect(
      await count(
        `SELECT count(*)::int n FROM invoicing.zatca_documents WHERE cleared_archive_ref IS NOT NULL`,
      ),
    ).toBe(1);
    // another organization cannot see them
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/billing/invoices/${stdId}/xml`,
          headers: { cookie: cookieHeader(jars.alice!), 'x-nuzm-org': orgA },
        })
      ).statusCode,
    ).toBe(404);
    const before = sim().submissions;
    expect(await pipeline().run(at(200))).toMatchObject({
      generated: 0,
      stamped: 0,
      queued: 0,
      submitted: { cleared: 0, reported: 0 },
    });
    expect(sim().submissions).toBe(before);
    expect(sim().duplicateSubmissions).toBe(0);
  });

  it('a credit note follows the same pipeline: generated, stamped, cleared', async () => {
    const inv = await mkInvoice(orgB);
    const cn = await app.get(CreditNoteService).issue(
      orgB,
      null,
      {
        invoiceId: inv,
        reasonCode: 'billing_error',
        reason: 'duplicate',
        sourceKey: 'zq-cn-1',
      },
      at(0),
    );
    const r = await pipeline().run(at(300));
    expect(r.generated).toBe(2);
    expect(r.submitted.cleared).toBe(2);
    expect(await trail(await docOf(cn.id))).toEqual([
      'generated',
      'stamped',
      'queued',
      'submitted',
      'cleared',
    ]);
  });

  it('server unavailable: backoff (error → queued), the invoice stays held, an alert is raised, and the document clears when the server returns', async () => {
    const inv = await mkInvoice(orgB);
    sim().queue('unavailable');
    expect((await pipeline().run(at(400))).submitted.failed).toBe(1);
    const d = await docOf(inv);
    expect(await trail(d)).toEqual([
      'generated',
      'stamped',
      'queued',
      'submitted',
      'error',
      'queued',
    ]);
    const s = await stateOf(d);
    expect(s).toMatchObject({ state: 'queued', attempt: 1 });
    expect(s.response.lastError.code).toBe('unavailable');
    expect(new Date(s.next_attempt_at).getTime()).toBe(at(400).getTime() + 60_000); // base backoff
    await expect(
      subs().assertDeliverable(orgB, { id: inv, buyer: { buyerType: 'b2b', vatNumber: VAT } }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await count(
        `SELECT count(*)::int n FROM platform.outbox WHERE org_id = $1 AND topic = 'zatca.clearance_unavailable' AND payload->>'documentId' = $2`,
        [orgB, d],
      ),
    ).toBe(1);
    expect((await pipeline().run(at(430))).submitted).toMatchObject({ cleared: 0, failed: 0 }); // not due yet
    expect((await pipeline().run(at(461))).submitted.cleared).toBe(1);
    expect((await stateOf(d)).state).toBe('cleared');
  });

  it('exponential backoff, then a dead letter after the last attempt; a person retries it; the retry is idempotent and a decided document is not retryable', async () => {
    const inv = await mkInvoice(orgA);
    sim().queue(
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
    );
    let now = at(1000);
    await pipeline().run(now); // generate, stamp, queue, attempt 1
    const d = await docOf(inv);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const s = await stateOf(d);
      expect(s).toMatchObject({ state: 'queued', attempt });
      delays.push((new Date(s.next_attempt_at).getTime() - now.getTime()) / 1000);
      now = new Date(s.next_attempt_at);
      await pipeline().run(now);
    }
    expect(delays).toEqual([60, 120, 240, 480, 960]); // doubling
    const dead = await stateOf(d);
    expect(dead).toMatchObject({ state: 'error', attempt: 6, dead_letter: true });
    expect(await events(orgA, 'zatca.submission.dead_letter', d)).toBe(1);
    const calls = sim().submissions;
    await pipeline().run(new Date(now.getTime() + 86_400_000));
    expect(sim().submissions).toBe(calls); // a dead letter is not retried automatically
    // finance: it shows in the dead-letter list and is retried by a person
    const list = await admin('fin1', 'GET', '/v1/admin/billing/zatca/submissions?deadLetter=true');
    const row = list.json().items.find((x: Row) => x.documentId === d);
    expect(row).toMatchObject({
      state: 'error',
      deadLetter: true,
      attempt: 6,
      lastError: { code: 'unavailable' },
    });
    expect(
      (await admin('sup', 'POST', `/v1/admin/billing/zatca/submissions/${row.id}/retry`))
        .statusCode,
    ).toBe(403);
    const r1 = await admin('fin1', 'POST', `/v1/admin/billing/zatca/submissions/${row.id}/retry`);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ state: 'queued', attempt: 0, deadLetter: false });
    const r2 = await admin('fin1', 'POST', `/v1/admin/billing/zatca/submissions/${row.id}/retry`); // idempotent
    expect(r2.statusCode).toBe(200);
    expect(await trail(d)).toHaveLength((await trail(d)).length);
    expect(
      await count(
        `SELECT count(*)::int n FROM invoicing.zatca_submissions WHERE document_id = $1 AND state = 'queued' AND response ? 'manualRetryBy'`,
        [d],
      ),
    ).toBe(1);
    await pipeline().run(new Date(now.getTime() + 86_400_000 + 1000));
    expect((await stateOf(d)).state).toBe('reported');
    expect(
      (await admin('fin1', 'POST', `/v1/admin/billing/zatca/submissions/${row.id}/retry`))
        .statusCode,
    ).toBe(409); // decided
    expect(
      (
        await admin(
          'fin1',
          'POST',
          `/v1/admin/billing/zatca/submissions/${crypto.randomUUID()}/retry`,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('a lost answer (timeout) is reconciled by looking the document up: adopted, never submitted twice', async () => {
    const inv = await mkInvoice(orgB);
    const before = { s: sim().submissions, d: sim().duplicateSubmissions, l: sim().lookups };
    sim().queue('timeout');
    const r = await pipeline().run(at(5000));
    expect(r.submitted.cleared).toBe(1); // the server had decided; the platform found out by asking
    expect(sim().submissions - before.s).toBe(1);
    expect(sim().duplicateSubmissions).toBe(before.d);
    expect(sim().lookups - before.l).toBe(1);
    expect((await stateOf(await docOf(inv))).state).toBe('cleared');
  });

  it('a rejected document is final: no resubmission, a retry is refused and says why', async () => {
    const inv = await mkInvoice(orgB);
    sim().queue('reject');
    const r = await pipeline().run(at(6000));
    expect(r.submitted.rejected).toBe(1);
    const d = await docOf(inv);
    const st = await stateOf(d);
    expect(st.state).toBe('rejected');
    expect(st.response.errors[0].code).toBe('SIM-REJ');
    const calls = sim().submissions;
    await pipeline().run(at(9000));
    expect(sim().submissions).toBe(calls);
    const row = (await admin('fin1', 'GET', '/v1/admin/billing/zatca/submissions?state=rejected'))
      .json()
      .items.find((x: Row) => x.documentId === d);
    expect(row).toMatchObject({ state: 'rejected', lastError: { code: 'SIM-REJ' } });
    const rr = await admin('fin1', 'POST', `/v1/admin/billing/zatca/submissions/${row.id}/retry`);
    expect(rr.statusCode).toBe(409);
    expect(rr.json().detail).toMatch(/human review/);
  });

  it('concurrent workers submit each queued document exactly once', async () => {
    const invs = await Promise.all([mkInvoice(orgA), mkInvoice(orgB), mkInvoice(orgA)]);
    // generate, stamp and queue without submitting
    const p: any = pipeline();
    const real = p.submissions.processDue.bind(p.submissions);
    p.submissions.processDue = async () => ({
      cleared: 0,
      reported: 0,
      rejected: 0,
      failed: 0,
      deadLetters: 0,
      skipped: 0,
    });
    await p.run(at(7000));
    p.submissions.processDue = real;
    const before = { s: sim().submissions, d: sim().duplicateSubmissions };
    await Promise.all([1, 2, 3, 4, 5].map(() => subs().processDue(at(7100))));
    expect(sim().submissions - before.s).toBe(3);
    expect(sim().duplicateSubmissions).toBe(before.d);
    for (const i of invs)
      expect(['cleared', 'reported']).toContain((await stateOf(await docOf(i))).state);
  });

  it('the simulated server rejects a document whose stamp does not verify (internal consistency only; NOT ZATCA)', async () => {
    const r = (
      await sql(
        `SELECT * FROM invoicing.zatca_documents WHERE xml_final IS NOT NULL AND subtype = 'simplified' LIMIT 1`,
      )
    )[0]!;
    const cred = await subs().credentialFor(entity, 'sandbox');
    const secrets = (subs() as any).secrets;
    const c = {
      token: await secrets.get(cred!.tokenRef),
      secret: await secrets.get(cred!.secretRef),
    };
    const tampered = (r.xml_final as string).replace('<cbc:ID>', '<cbc:ID x="1">'); // changes the hashed body
    const res = await sim().submit(c, {
      uuid: crypto.randomUUID(),
      hash: r.invoice_hash,
      type: 'invoice',
      subtype: 'simplified',
      xml: tampered,
    });
    expect(res.status).toBe('rejected');
    expect(res.errors.map((e) => e.code)).toContain('SIM-HASH');
    const unstamped = await sim().submit(c, {
      uuid: crypto.randomUUID(),
      hash: r.invoice_hash,
      type: 'invoice',
      subtype: 'simplified',
      xml: r.xml_body,
    });
    expect(unstamped.errors.map((e) => e.code)).toContain('SIM-NOSTAMP');
  });

  it('the reporting window clock: alert at 50%, breach at 100%, nothing once reported', async () => {
    const inv = await mkInvoice(orgA);
    sim().queue('unavailable');
    await pipeline().run(at(20_000));
    const d = await docOf(inv);
    const stamped = (
      await sql(`SELECT stamped_at FROM invoicing.zatca_documents WHERE id = $1`, [d])
    )[0]!.stamped_at as Date;
    const at_ = (h: number) => new Date(stamped.getTime() + h * 3_600_000);
    const pick = async (now: Date) =>
      (await subs().list({ limit: 100, state: 'queued' }, now)).items.find(
        (x) => x.documentId === d,
      )!;
    expect(await pick(at_(1))).toMatchObject({ windowAlert: false, windowBreached: false });
    expect((await pick(at_(1))).windowRemainingSeconds).toBe(23 * 3600);
    expect(await pick(at_(13))).toMatchObject({ windowAlert: true, windowBreached: false });
    expect(await pick(at_(25))).toMatchObject({
      windowAlert: true,
      windowBreached: true,
      windowRemainingSeconds: 0,
    });
    await pipeline().run(new Date(stamped.getTime() + 61_000 + 20_000_000));
    const done = (await subs().list({ limit: 100, state: 'reported' }, at_(30))).items.find(
      (x) => x.documentId === d,
    )!;
    expect(done).toMatchObject({
      windowAlert: false,
      windowBreached: false,
      windowRemainingSeconds: null,
    });
  });
});

const events = (org: string, topic: string, doc: string) =>
  count(
    `SELECT count(*)::int n FROM platform.outbox WHERE org_id = $1 AND topic = $2 AND payload->>'documentId' = $3`,
    [org, topic, doc],
  );

describe('admin list and database guards', () => {
  it('lists with filters and validates them; support cannot read', async () => {
    const all = await admin('fin1', 'GET', '/v1/admin/billing/zatca/submissions?limit=2');
    expect(all.statusCode).toBe(200);
    expect(all.json().items).toHaveLength(2);
    expect(all.json().nextCursor).toBeTruthy();
    const page2 = await admin(
      'fin1',
      'GET',
      `/v1/admin/billing/zatca/submissions?limit=2&cursor=${all.json().nextCursor}`,
    );
    expect(page2.json().items[0].documentId).not.toBe(all.json().items[0].documentId);
    expect(
      (await admin('fin1', 'GET', `/v1/admin/billing/zatca/submissions?org=${orgA}`))
        .json()
        .items.every((x: Row) => x.orgId === orgA),
    ).toBe(true);
    expect(
      (await admin('fin1', 'GET', '/v1/admin/billing/zatca/submissions?state=nope')).statusCode,
    ).toBe(422);
    expect(
      (await admin('fin1', 'GET', '/v1/admin/billing/zatca/submissions?deadLetter=maybe'))
        .statusCode,
    ).toBe(422);
    expect((await admin('sup', 'GET', '/v1/admin/billing/zatca/submissions')).statusCode).toBe(403);
    expect((await admin('sec1', 'GET', '/v1/admin/billing/zatca/submissions')).statusCode).toBe(
      200,
    );
  });

  it('submission rows are append-only with a legal state machine; onboarding and credential records are immutable', async () => {
    const d = (
      await sql(
        `SELECT document_id id, org_id FROM invoicing.zatca_submissions WHERE state = 'cleared' LIMIT 1`,
      )
    )[0]!;
    await expect(
      sql(`UPDATE invoicing.zatca_submissions SET state = 'error' WHERE document_id = $1`, [d.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql(`DELETE FROM invoicing.zatca_submissions WHERE document_id = $1`, [d.id]),
    ).rejects.toThrow(/append-only/);
    await expect(sql(`TRUNCATE invoicing.zatca_submissions`)).rejects.toThrow(
      /never truncated|cannot truncate/,
    );
    const seqN = Number(
      (
        await sql(
          `SELECT max(seq)::int m FROM invoicing.zatca_submissions WHERE document_id = $1`,
          [d.id],
        )
      )[0]!.m,
    );
    const ins = (state: string, seq: number) =>
      sql(
        `INSERT INTO invoicing.zatca_submissions (id, org_id, document_id, seq, state) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [d.org_id, d.id, seq, state],
      );
    await expect(ins('queued', seqN + 1)).rejects.toThrow(
      /illegal submission transition cleared -> queued/,
    ); // a cleared document never goes back
    await expect(ins('error', seqN + 2)).rejects.toThrow(/consecutive/);
    const o = (
      await sql(`SELECT id FROM invoicing.zatca_onboarding WHERE status = 'completed' LIMIT 1`)
    )[0]!;
    await expect(
      sql(`UPDATE invoicing.zatca_onboarding SET status = 'failed' WHERE id = $1`, [o.id]),
    ).rejects.toThrow(/cannot change/);
    await expect(
      sql(`DELETE FROM invoicing.zatca_onboarding WHERE id = $1`, [o.id]),
    ).rejects.toThrow(/never deleted/);
    await expect(
      sql(
        `INSERT INTO invoicing.zatca_onboarding (id, entity_id, environment, step, status, requested_by, decided_by, decided_at) VALUES (gen_random_uuid(), $1, 'sandbox', 'csr', 'completed', $2, $2, now())`,
        [entity, ids.fin1],
      ),
    ).rejects.toThrow(/zatca_onboarding_check|check/); // two-person rule
    await expect(
      sql(
        `INSERT INTO invoicing.zatca_credentials_refs (id, entity_id, environment, kind, key_ref, secret_ref) VALUES (gen_random_uuid(), $1, 'sandbox', 'compliance_csid', 'vault://dev/zatca/ok-key', 'sim_compliance_sec_000001')`,
        [entity],
      ),
    ).rejects.toThrow(/secret_ref|check/); // a raw secret is not a reference
    await expect(
      sql(
        `UPDATE invoicing.zatca_credentials_refs SET key_ref = 'vault://dev/zatca/other-key' WHERE kind = 'csr_key'`,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`UPDATE invoicing.zatca_documents SET cleared_xml = 'x' WHERE cleared_xml IS NOT NULL`),
    ).rejects.toThrow(/set once/);
  });
});

describe('e-invoicing off', () => {
  it('does nothing, shows not_generated and refuses the XML', async () => {
    const real: any = docs();
    const off = new ZatcaDocumentService(real.db, real.audit, real.profile, real.archive, 'off');
    const offSubs = new ZatcaSubmissionService(
      real.db,
      real.audit,
      off,
      sim(),
      (subs() as any).secrets,
      real.archive,
    );
    const offPipeline = new ZatcaPipelineService(
      real.db,
      off,
      offSubs,
      app.get(DevFileVault),
      new Date(0),
    );
    expect((await offPipeline.run(at(0))).generated).toBe(0);
    expect(await offSubs.statusOf(orgA, 'invoice', crypto.randomUUID())).toEqual({
      state: 'not_generated',
      uuid: null,
      qr: null,
    });
    await expect(offSubs.xmlFor(orgA, crypto.randomUUID())).rejects.toMatchObject({ status: 409 });
    await expect(
      offSubs.assertDeliverable(orgB, {
        id: crypto.randomUUID(),
        buyer: { buyerType: 'b2b', vatNumber: VAT },
      }),
    ).resolves.toBeUndefined();
    await expect(offSubs.processDue(at(0))).rejects.toMatchObject({ status: 409 });
    const onb = new ZatcaOnboardingService(
      real.db,
      real.audit,
      off,
      sim(),
      app.get(DevFileVault),
      (subs() as any).secrets,
    );
    expect(await onb.view()).toEqual([]);
  });
});
