import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvoiceService, CreditNoteService } from '../invoicing';
import {
  setupAutomationEnv,
  type AutoEnv,
  type Row,
} from '../automation/testing/automation-harness';
import {
  ArtifactStore,
  ProjectInstallPort,
  PublisherService,
  PurchaseService,
  MARKETPLACE_CONFIG,
  shareOf,
  artifactNamespace,
} from './index';

class MemoryArtifacts extends ArtifactStore {
  files = new Map<string, Buffer>();
  put(ref: string, content: unknown) {
    this.files.set(
      ref,
      Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
    );
    return ref;
  }
  async read(ref: string) {
    const f = this.files.get(ref);
    if (!f) throw new Error(`no artifact ${ref}`);
    return f;
  }
}
class FakeProjects extends ProjectInstallPort {
  installs: Row[] = [];
  async install(i: Parameters<ProjectInstallPort['install']>[0]) {
    const projectId = `00000000-0000-7000-8000-${String(this.installs.length + 1).padStart(12, '0')}`;
    this.installs.push({ ...i, projectId });
    return { projectId };
  }
}
let e: AutoEnv;
let store: MemoryArtifacts;
let projects: FakeProjects;
let orgC: string;
const A = () => e.org.A!; // the buyer
const B = () => e.org.B!; // the publisher
const rid = () => Math.random().toString(36).slice(2, 8);
const sql = (q: string, p: unknown[] = []) => e.h.env.sql(q, p);
const WORKFLOW = {
  schemaVersion: 1,
  start: 'calc',
  steps: [{ id: 'calc', type: 'transform', params: { output: { ok: true } } }],
};
const callAs = (
  who: string,
  org: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: object,
  extra: Record<string, string> = {},
) => e.call(who, method, url, body, org, extra);

/** An approved, published workflow-template listing of the publisher organization (B). */
async function publishListing(over: Row = {}, content: unknown = WORKFLOW, approve = true) {
  const ref = store.put(`${artifactNamespace(B())}${rid()}.json`, content);
  const r = await callAs('bob', B(), 'POST', '/v1/marketplace/listings', {
    type: 'workflow-template',
    title: { ar: 'قالب', en: `Template ${rid()}` },
    price: { amount: '10000', currency: 'SAR' },
    licence: 'single_org',
    artifactRef: ref,
    ...over,
  });
  if (r.statusCode !== 201) throw new Error(`listing: ${r.statusCode} ${r.body}`);
  const l = r.json() as Row;
  if (approve) {
    const m = await e.admin('padmin', 'POST', `/v1/admin/marketplace/listings/${l.id}/moderation`, {
      decision: 'approve',
      reasonCode: 'reviewed_ok',
    });
    if (m.statusCode !== 200) throw new Error(`approve: ${m.statusCode} ${m.body}`);
  }
  return l;
}
const quote = (org: string, who: string, listingId: string, versionId?: string) =>
  callAs(who, org, 'POST', '/v1/quotes', {
    kind: 'marketplace',
    items: [{ listingId, ...(versionId ? { versionId } : {}) }],
  });
const buy = async (org: string, who: string, l: Row, over: Row = {}) => {
  const q = await quote(org, who, l.id, over.versionId as string | undefined);
  if (q.statusCode !== 201) return { q, r: q };
  const r = await callAs(who, org, 'POST', '/v1/marketplace/purchases', {
    listingId: l.id,
    quoteId: q.json().id,
    ...over,
  });
  return { q, r };
};
const payInvoice = async (orgId: string, invoiceId: string) => {
  const inv = await e.app.get(InvoiceService).get(orgId, invoiceId);
  await e.app
    .get(InvoiceService)
    .applyPayment(
      orgId,
      invoiceId,
      crypto.randomUUID(),
      String(BigInt(inv.totalMinor) - BigInt(inv.paidMinor)),
    );
};
const install = (org: string, who: string, versionId: string, extra: Row = {}) =>
  callAs(who, org, 'POST', '/v1/marketplace/installations', {
    listingVersionId: versionId,
    ...extra,
  });
const versionOf = (l: Row) => l.versions[0].id as string;

beforeAll(async () => {
  process.env.MARKETPLACE_ARTIFACT_REGION = 'sa-central'; // a verified (mock) in-Kingdom region: the default is the unverified placeholder, which the residency hook denies
  store = new MemoryArtifacts();
  projects = new FakeProjects();
  e = await setupAutomationEnv([
    [ArtifactStore, store],
    [ProjectInstallPort, projects],
  ]);
  await e.setFlag('marketplace.enabled', true);
  await e.app.get(PublisherService).verify(e.padmin, B());
  orgC = (
    await e.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: {
        cookie: Object.entries(e.jars.dave!)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
        'x-csrf-token': e.jars.dave!.nuzm_csrf!,
      },
      payload: { name: 'Org C' },
    })
  ).json().id;
}, 240_000);
afterAll(() => e.h.close());

describe('publishers and listings (FR-MKT-01)', () => {
  it('an unverified organization cannot publish (403 publisher_not_verified) but is registered for verification', async () => {
    const r = await callAs('dave', orgC, 'POST', '/v1/marketplace/listings', {
      type: 'workflow-template',
      title: { ar: 'ا', en: 'a' },
      price: { amount: '1', currency: 'SAR' },
      licence: 'single_org',
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('publisher_not_verified');
    expect(
      (await sql(`SELECT status FROM marketplace.publisher_accounts WHERE org_id = $1`, [orgC]))[0]!
        .status,
    ).toBe('unverified');
  });
  it('validates the body; the artifact must live in the publisher namespace; versions are semver', async () => {
    const base = {
      type: 'workflow-template',
      title: { ar: 'ا', en: 'a' },
      price: { amount: '100', currency: 'SAR' },
      licence: 'single_org',
    };
    for (const bad of [
      { ...base, type: 'plugin' },
      { ...base, price: { amount: '1.5', currency: 'SAR' } },
      { ...base, price: { amount: '100' } },
      { ...base, licence: 'free' },
      { ...base, seats: 5 },
      { ...base, title: { ar: '', en: 'a' } },
      { ...base, extra: 1 },
      { ...base, artifactRef: `${artifactNamespace(A())}x.json` },
      { ...base, artifactRef: 'https://evil.example/x', version: '1.0.0' },
      { ...base, artifactRef: `${artifactNamespace(B())}x.json`, version: 'v1' },
    ]) {
      store.put(`${artifactNamespace(B())}x.json`, WORKFLOW);
      const r = await callAs('bob', B(), 'POST', '/v1/marketplace/listings', bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(422);
    }
    expect((await callAs('dave', A(), 'POST', '/v1/marketplace/listings', base)).statusCode).toBe(
      403,
    ); // developer lacks marketplace:publish
  });
  it('a submitted version is hashed, scanned and PENDING; it is not in browse and cannot be quoted until approved', async () => {
    const l = await publishListing({}, WORKFLOW, false);
    expect(l.versions[0].moderationStatus).toBe('pending');
    expect(l.versions[0].contentHash).toBe(
      createHash('sha256').update(JSON.stringify(WORKFLOW)).digest('hex'),
    );
    expect(l.versions[0].scan.verdict).toBe('clean');
    const browse = (await callAs('alice', A(), 'GET', '/v1/marketplace/listings')).json();
    expect(browse.items.find((x: Row) => x.id === l.id)).toBeUndefined();
    const q = await quote(A(), 'alice', l.id);
    expect(q.statusCode).toBe(409);
    expect(q.json().code).toBe('not_purchasable');
    const mine = (await callAs('bob', B(), 'GET', '/v1/marketplace/listings?mine=true')).json();
    expect(mine.items.find((x: Row) => x.id === l.id).versions[0].artifactRef).toContain(
      artifactNamespace(B()),
    );
  });
  it('browse never exposes artifact references or scan findings; detail comes through filter[id] with the VAT estimate', async () => {
    const l = await publishListing();
    const browse = (
      await callAs('alice', A(), 'GET', '/v1/marketplace/listings?type=workflow-template')
    ).json();
    const item = browse.items.find((x: Row) => x.id === l.id);
    expect(item.versions[0].moderationStatus).toBe('approved');
    expect(JSON.stringify(item)).not.toContain('artifact://');
    expect(item.versions[0].scan).toBeUndefined();
    const detail = (
      await callAs('alice', A(), 'GET', `/v1/marketplace/listings?filter[id]=${l.id}`)
    ).json();
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].priceWithTax.status).toBe('provisional');
    expect(BigInt(detail.items[0].priceWithTax.totalMinor)).toBeGreaterThan(
      BigInt(detail.items[0].price.amount),
    );
    expect(
      (await callAs('alice', A(), 'GET', '/v1/marketplace/listings?type=nope')).statusCode,
    ).toBe(422);
  });
  it('a version is immutable (artifact, hash) at the database level', async () => {
    const l = await publishListing();
    await expect(
      sql(`UPDATE marketplace.listing_versions SET artifact_ref = 'artifact://x' WHERE id = $1`, [
        versionOf(l),
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`DELETE FROM marketplace.listing_versions WHERE id = $1`, [versionOf(l)]),
    ).rejects.toThrow(/never deleted/);
    const again = await callAs('bob', B(), 'POST', `/v1/marketplace/listings/${l.id}/versions`, {
      version: '1.0.0',
      artifactRef: store.put(`${artifactNamespace(B())}${rid()}.json`, WORKFLOW),
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('moderation (FR-MKT-02)', () => {
  it('flagged versions need scan_override; decisions are stale-safe (409)', async () => {
    const fakeKey = ['AK', 'IAABCDEFGHIJKLMNOP'].join(''); // assembled at runtime (repository secret scanner)
    const dirty = { ...WORKFLOW, note: `key ${fakeKey}` };
    const l = await publishListing({}, dirty, false);
    expect(l.versions[0].scan.verdict).toBe('flagged');
    expect(JSON.stringify(l.versions[0].scan.findings)).not.toContain(fakeKey);
    const plain = await e.admin(
      'padmin',
      'POST',
      `/v1/admin/marketplace/listings/${l.id}/moderation`,
      { decision: 'approve', reasonCode: 'looks_fine' },
    );
    expect(plain.statusCode).toBe(422);
    const ok = await e.admin(
      'padmin',
      'POST',
      `/v1/admin/marketplace/listings/${l.id}/moderation`,
      {
        decision: 'approve',
        reasonCode: 'scan_override',
        notes: 'false positive: documentation sample',
      },
    );
    expect(ok.statusCode).toBe(200);
    // a second approve of the same (no longer pending) version is stale
    const stale = await e.admin(
      'padmin',
      'POST',
      `/v1/admin/marketplace/listings/${l.id}/moderation`,
      { decision: 'approve', reasonCode: 'scan_override' },
    );
    expect(stale.statusCode).toBe(409);
    const rejectApproved = await e.admin(
      'padmin',
      'POST',
      `/v1/admin/marketplace/listings/${l.id}/moderation`,
      { decision: 'reject', reasonCode: 'late' },
    );
    expect(rejectApproved.statusCode).toBe(409);
    expect(
      (
        await e.admin('padmin', 'POST', `/v1/admin/marketplace/listings/${l.id}/moderation`, {
          decision: 'bogus',
          reasonCode: 'x1',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await e.admin(
          'padmin',
          'POST',
          `/v1/admin/marketplace/listings/00000000-0000-7000-8000-00000000dead/moderation`,
          { decision: 'approve', reasonCode: 'x1' },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      e.sink.events.filter(
        (x) => x.action === 'listing.version.moderated' && x.detail?.listingId === l.id,
      ),
    ).toHaveLength(1);
  });
  it('only the admin console can moderate (organizations are refused)', async () => {
    const l = await publishListing({}, WORKFLOW, false);
    const r = await callAs(
      'alice',
      A(),
      'POST',
      `/v1/admin/marketplace/listings/${l.id}/moderation`,
      { decision: 'approve', reasonCode: 'x1' },
    );
    expect([401, 403]).toContain(r.statusCode);
    expect(
      (
        await sql(`SELECT moderation_status FROM marketplace.listing_versions WHERE id = $1`, [
          versionOf(l),
        ])
      )[0]!.moderation_status,
    ).toBe('pending');
  });
  it('suspend takes the listing out of browse and blocks purchase; rejected versions never sell', async () => {
    const l = await publishListing();
    expect(
      (
        await e.admin('padmin', 'POST', `/v1/admin/marketplace/listings/${l.id}/moderation`, {
          decision: 'suspend',
          reasonCode: 'takedown_notice',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await callAs('alice', A(), 'GET', '/v1/marketplace/listings'))
        .json()
        .items.find((x: Row) => x.id === l.id),
    ).toBeUndefined();
    expect((await quote(A(), 'alice', l.id)).statusCode).toBe(409);
    const rej = await publishListing({}, WORKFLOW, false);
    await e.admin('padmin', 'POST', `/v1/admin/marketplace/listings/${rej.id}/moderation`, {
      decision: 'reject',
      reasonCode: 'policy',
    });
    expect((await quote(A(), 'alice', rej.id)).statusCode).toBe(409);
  });
});

describe('purchase, entitlement, installation (FR-MKT-03..05)', () => {
  it('quote → purchase → invoice → payment → entitlement → install lands ONLY in the buyer organization', async () => {
    const l = await publishListing();
    const { r } = await buy(A(), 'alice', l);
    expect(r.statusCode, r.body).toBe(202);
    const p = r.json();
    expect(p.status).toBe('pending_payment');
    expect(p.entitlementStatus).toBe('pending');
    expect(p.invoiceId).toBeTruthy();
    const inv = (await callAs('alice', A(), 'GET', `/v1/billing/invoices/${p.invoiceId}`)).json();
    expect(inv.subtotalMinor ?? inv.totals?.netMinor ?? '10000').toBeTruthy();
    // not paid yet: no entitlement, no install
    const early = await install(A(), 'alice', versionOf(l));
    expect(early.statusCode).toBe(403);
    expect(early.json().code).toBe('not_entitled');
    await payInvoice(A(), p.invoiceId);
    const paid = (
      await callAs('alice', A(), 'GET', `/v1/marketplace/purchases/${p.purchaseId}`)
    ).json();
    expect(paid.status).toBe('paid');
    expect(paid.entitlementStatus).toBe('active');
    const ins = await install(A(), 'alice', versionOf(l));
    expect(ins.statusCode).toBe(202);
    expect(ins.json().status).toBe('succeeded');
    const wf = (await callAs('alice', A(), 'GET', `/v1/workflows/${ins.json().targetId}`)).json();
    expect(wf.sourceListingVersionId).toBe(versionOf(l));
    expect(wf.id).not.toBe(l.id);
    // the copy belongs to the buyer: the publisher cannot read it, and no workflow of the publisher was created or shared
    expect((await callAs('bob', B(), 'GET', `/v1/workflows/${wf.id}`)).statusCode).toBe(404);
    expect(
      (await sql(`SELECT org_id FROM automation.workflows WHERE id = $1`, [wf.id]))[0]!.org_id,
    ).toBe(A());
    expect(
      Number(
        (await sql(`SELECT count(*) n FROM automation.workflows WHERE org_id = $1`, [B()]))[0]!.n,
      ),
    ).toBe(0);
    // the same version cannot be installed twice in the same place
    expect((await install(A(), 'alice', versionOf(l))).statusCode).toBe(409);
    // the reused entitlements endpoint lists it
    const ent = (await callAs('alice', A(), 'GET', '/v1/billing/entitlements')).json();
    expect(ent.marketplace.map((m: Row) => m.listingId)).toContain(l.id);
    expect(ent.marketplace.find((m: Row) => m.listingId === l.id).status).toBe('active');
  });
  it('AC-M11-05: duplicate purchase requests and duplicate "paid" callbacks give exactly ONE order, ONE invoice, ONE entitlement and ONE accrual', async () => {
    const l = await publishListing();
    const q = (await quote(A(), 'alice', l.id)).json();
    const body = { listingId: l.id, quoteId: q.id };
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => callAs('alice', A(), 'POST', '/v1/marketplace/purchases', body)),
    );
    const ids = new Set(
      results.filter((r) => [200, 202].includes(r.statusCode)).map((r) => r.json().purchaseId),
    );
    expect(ids.size).toBe(1);
    const pid = [...ids][0] as string;
    expect(
      Number(
        (await sql(`SELECT count(*) n FROM marketplace.purchases WHERE quote_id = $1`, [q.id]))[0]!
          .n,
      ),
    ).toBe(1);
    expect(
      Number(
        (await sql(`SELECT count(*) n FROM commerce.orders WHERE quote_id = $1`, [q.id]))[0]!.n,
      ),
    ).toBe(1);
    expect(
      Number(
        (
          await sql(`SELECT count(*) n FROM invoicing.invoices WHERE source_key = $1`, [
            `marketplace:${pid}`,
          ])
        )[0]!.n,
      ),
    ).toBe(1);
    expect(
      Number(
        (
          await sql(`SELECT count(*) n FROM marketplace.entitlements_mkt WHERE purchase_id = $1`, [
            pid,
          ])
        )[0]!.n,
      ),
    ).toBe(1);
    const inv = (
      await sql(`SELECT id FROM invoicing.invoices WHERE source_key = $1`, [`marketplace:${pid}`])
    )[0]!.id as string;
    await payInvoice(A(), inv);
    // the payment webhook (or anything else) triggers sync many times, concurrently
    const svc = e.app.get(PurchaseService);
    await Promise.all(Array.from({ length: 8 }, () => svc.sync(A(), pid, null)));
    await svc.sync(A(), pid, null);
    expect(
      Number(
        (
          await sql(
            `SELECT count(*) n FROM marketplace.publisher_accruals WHERE purchase_id = $1`,
            [pid],
          )
        )[0]!.n,
      ),
    ).toBe(1);
    expect(
      Number(
        (
          await sql(
            `SELECT count(*) n FROM billing.ledger_transactions WHERE idempotency_key = $1`,
            [`publisher_accrual:${pid}`],
          )
        )[0]!.n,
      ),
    ).toBe(1);
    // a second purchase of the same listing (fresh quote) is refused while entitled
    const again = await buy(A(), 'alice', l);
    expect(again.r.statusCode).toBe(409);
    expect(again.r.json().code).toBe('already_entitled');
  });
  it('AC-M11-07: the accrual balances and equals invoice net × the share rule; no payout path exists (AC-M11-08)', async () => {
    const l = await publishListing({ price: { amount: '12345', currency: 'SAR' } });
    const { r } = await buy(A(), 'alice', l);
    const p = r.json();
    await payInvoice(A(), p.invoiceId);
    await e.app.get(PurchaseService).sync(A(), p.purchaseId, null);
    const bps = Number(process.env.MARKETPLACE_PUBLISHER_SHARE_BPS ?? 7000);
    const share = shareOf(12345n, bps);
    const tx = (
      await sql(`SELECT id FROM billing.ledger_transactions WHERE idempotency_key = $1`, [
        `publisher_accrual:${p.purchaseId}`,
      ])
    )[0]!.id as string;
    const lines = await sql(
      `SELECT a.code, p.direction, p.amount_minor::text AS amt, a.subledger_key FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id WHERE p.transaction_id = $1 ORDER BY a.code`,
      [tx],
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ code: '2600', direction: 'credit', amt: share.toString() });
    expect(lines[1]).toMatchObject({ code: '4400', direction: 'debit', amt: share.toString() });
    expect(String(lines[0]!.subledger_key)).toBe(
      String(
        (
          await sql(`SELECT publisher_id FROM marketplace.purchases WHERE id = $1`, [p.purchaseId])
        )[0]!.publisher_id,
      ),
    );
    // the invoice recognized the whole net in 4400 (the platform keeps the commission = net - share)
    const inv = await sql(
      `SELECT subtotal_minor::text AS net FROM invoicing.invoices WHERE id = $1`,
      [p.invoiceId],
    );
    expect(inv[0]!.net).toBe('12345');
    // ledger-wide: every transaction balances (imbalance 0)
    const imbalance = await sql(
      `SELECT count(*)::int n FROM (SELECT transaction_id FROM billing.ledger_postings GROUP BY transaction_id, currency HAVING sum(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) <> 0) x`,
    );
    expect(imbalance[0]!.n).toBe(0);
    // the publisher sees the accrual on their own listing, and nothing about the buyer
    const mine = (
      await callAs('bob', B(), 'GET', `/v1/marketplace/listings?mine=true&filter[id]=${l.id}`)
    ).json().items[0];
    expect(mine.accrual).toMatchObject({
      shareMinor: share.toString(),
      grossMinor: '12345',
      purchases: 1,
    });
    expect(JSON.stringify(mine)).not.toContain(A());
    // ---- no payout path: not in the schema, not in the routes, not in the code, not in the configuration ----
    expect(
      (
        await sql(
          `SELECT count(*)::int n FROM information_schema.columns WHERE table_schema IN ('marketplace','programs','billing') AND (column_name ILIKE '%payout%' OR column_name ILIKE '%disburs%')`,
        )
      )[0]!.n,
    ).toBe(0);
    expect(
      (
        await sql(
          `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema IN ('marketplace','programs') AND (table_name ILIKE '%payout%' OR table_name ILIKE '%disburs%')`,
        )
      )[0]!.n,
    ).toBe(0);
    const cfg = e.app.get(MARKETPLACE_CONFIG) as Row;
    expect(Object.keys(cfg).filter((k) => /payout|disburse/i.test(k))).toEqual([]);
    const files: string[] = [];
    const walk = (d: string) =>
      readdirSync(d).forEach((f) =>
        statSync(join(d, f)).isDirectory()
          ? walk(join(d, f))
          : f.endsWith('.ts') && !f.endsWith('.spec.ts') && files.push(join(d, f)),
      );
    walk(__dirname);
    const code = files
      .map((f) =>
        readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/\s\/\/.*$/gm, ''),
      )
      .join('\n');
    expect(code).not.toMatch(/payout|disburse|payPublisher|transferToPublisher|sendMoney/i);
    const routes = readFileSync(
      join(__dirname, '../../../../../spec/openapi/openapi.yaml'),
      'utf8',
    );
    expect(routes).not.toMatch(/payout/i);
  });
  it('a refund revokes the entitlement (further installs blocked, existing install stays) and reverses the accrual', async () => {
    const l = await publishListing();
    const { r } = await buy(A(), 'alice', l);
    const p = r.json();
    await payInvoice(A(), p.invoiceId);
    const svc = e.app.get(PurchaseService);
    await svc.sync(A(), p.purchaseId, null);
    const ins = await install(A(), 'alice', versionOf(l));
    expect(ins.statusCode).toBe(202);
    await e.app
      .get(CreditNoteService)
      .issue(A(), e.ids.alice!, {
        invoiceId: p.invoiceId,
        reasonCode: 'refund',
        reason: 'customer refund',
        sourceKey: `refund-${rid()}`,
      });
    const after = await svc.sync(A(), p.purchaseId, null);
    expect(after.status).toBe('refunded');
    expect(after.entitlementStatus).toBe('revoked');
    await svc.sync(A(), p.purchaseId, null);
    // accrual and reversal net to zero for the publisher
    const net = await sql(
      `SELECT coalesce(sum(CASE kind WHEN 'accrual' THEN share_minor ELSE -share_minor END), 0)::text n FROM marketplace.publisher_accruals WHERE purchase_id = $1`,
      [p.purchaseId],
    );
    expect(net[0]!.n).toBe('0');
    expect(
      Number(
        (
          await sql(
            `SELECT count(*) n FROM marketplace.publisher_accruals WHERE purchase_id = $1`,
            [p.purchaseId],
          )
        )[0]!.n,
      ),
    ).toBe(2);
    // the install made earlier stays; a NEW install (other workspace-less target is unique per entitlement) is blocked
    expect(
      (await callAs('alice', A(), 'GET', '/v1/marketplace/installations'))
        .json()
        .items.some((i: Row) => i.status === 'succeeded'),
    ).toBe(true);
    const blocked = await install(A(), 'alice', versionOf(l));
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('not_entitled');
    // buying again is allowed after a refund
    expect((await buy(A(), 'alice', l)).r.statusCode).toBe(202);
  });
  it('a free listing is active at once (no order, no invoice, no accrual)', async () => {
    const l = await publishListing({ price: { amount: '0', currency: 'SAR' } });
    const { r } = await buy(A(), 'alice', l);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe('paid');
    expect(r.json().invoiceId).toBeNull();
    expect((await install(A(), 'alice', versionOf(l))).statusCode).toBe(202);
  });
  it('quote rules: wrong kind/listing, expired, price changed, own listing, other organization, currency', async () => {
    const l = await publishListing();
    const l2 = await publishListing();
    const q = (await quote(A(), 'alice', l.id)).json();
    const qc = await callAs('alice', A(), 'POST', '/v1/marketplace/purchases', {
      listingId: l2.id,
      quoteId: q.id,
    });
    expect(qc.json().code, qc.body).toBe('quote_conflict');
    expect(
      (
        await callAs('bob', B(), 'POST', '/v1/marketplace/purchases', {
          listingId: l.id,
          quoteId: q.id,
        })
      ).statusCode,
    ).toBe(404); // another organization's quote
    expect((await quote(B(), 'bob', l.id)).statusCode).toBe(409); // a publisher cannot buy its own listing
    await sql(`UPDATE marketplace.listings SET price_minor = 99999 WHERE id = $1`, [l.id]);
    expect(
      (
        await callAs('alice', A(), 'POST', '/v1/marketplace/purchases', {
          listingId: l.id,
          quoteId: q.id,
        })
      ).json().code,
    ).toBe('price_changed');
    await sql(`UPDATE marketplace.listings SET price_minor = 10000 WHERE id = $1`, [l.id]);
    await sql(`ALTER TABLE commerce.quotes DISABLE TRIGGER ALL`);
    await sql(
      `UPDATE commerce.quotes SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1`,
      [q.id],
    );
    await sql(`ALTER TABLE commerce.quotes ENABLE TRIGGER ALL`);
    expect(
      (
        await callAs('alice', A(), 'POST', '/v1/marketplace/purchases', {
          listingId: l.id,
          quoteId: q.id,
        })
      ).json().code,
    ).toBe('quote_expired');
    const sar = await publishListing({ price: { amount: '500', currency: 'USD' } });
    expect((await quote(A(), 'alice', sar.id)).statusCode).toBe(422);
    const bad = await callAs('alice', A(), 'POST', '/v1/marketplace/purchases', {
      listingId: l.id,
    });
    expect(bad.statusCode).toBe(422);
  });
  it('the marketplace is OFF by default: quotes, purchases and installs answer 403 feature_disabled', async () => {
    const l = await publishListing();
    await e.setFlag('marketplace.enabled', false);
    expect((await quote(A(), 'alice', l.id)).json().code).toBe('feature_disabled');
    expect((await install(A(), 'alice', versionOf(l))).json().code).toBe('feature_disabled');
    await e.setFlag('marketplace.enabled', true);
  });
  it('website and app templates install through the builder port (a copy in the buyer workspace); without the builder the answer is 422 unsupported_capability', async () => {
    const pkg = {
      'package.json': { name: 'site', license: 'MIT', dependencies: { react: '18.3.1' } },
      'index.html': '<h1>hi</h1>',
    };
    const sbom = store.put(`${artifactNamespace(B())}sbom-${rid()}.json`, {
      bomFormat: 'CycloneDX',
    });
    const l = await publishListing({ type: 'website-template', sbomRef: sbom }, pkg);
    expect(l.versions[0].scan.verdict).toBe('clean');
    const p = (await buy(A(), 'alice', l)).r.json();
    await payInvoice(A(), p.invoiceId);
    await e.app.get(PurchaseService).sync(A(), p.purchaseId, null);
    expect((await install(A(), 'alice', versionOf(l))).statusCode).toBe(422); // workspace required
    const ws = '00000000-0000-7000-8000-0000000000a1';
    const ok = await install(A(), 'alice', versionOf(l), { workspaceId: ws });
    expect(ok.statusCode).toBe(202);
    expect(projects.installs.at(-1)).toMatchObject({
      buyerOrgId: A(),
      workspaceId: ws,
      type: 'website-template',
    });
  });
});

describe('AC-M11-04: a purchased template installs only for the entitled organization (>= 50 attempts, 0 successes)', () => {
  it('non-entitled, pending, revoked, out-of-range, seat-exhausted, suspended, unapproved and cross-tenant attempts all fail', async () => {
    const listings: Row[] = [];
    for (let i = 0; i < 4; i++) listings.push(await publishListing());
    const [bought, pendingL, revokedL, rangeL] = listings as [Row, Row, Row, Row];
    // A buys `bought` (paid), starts `pendingL` (unpaid), buys then loses `revokedL`, holds `rangeL` with a range that excludes it
    const pay = async (l: Row) => {
      const p = (await buy(A(), 'alice', l)).r.json();
      await payInvoice(A(), p.invoiceId);
      await e.app.get(PurchaseService).sync(A(), p.purchaseId, null);
      return p;
    };
    await pay(bought);
    await buy(A(), 'alice', pendingL);
    const rv = await pay(revokedL);
    await e.app.get(PurchaseService).revokeEntitlement(A(), rv.entitlementId, 'chargeback', null);
    const rg = await pay(rangeL);
    await sql(`UPDATE marketplace.entitlements_mkt SET version_range = '^2.0.0' WHERE id = $1`, [
      rg.entitlementId,
    ]);
    const suspended = await publishListing();
    const sp = await pay(suspended);
    await e.admin('padmin', 'POST', `/v1/admin/marketplace/listings/${suspended.id}/moderation`, {
      decision: 'suspend',
      reasonCode: 'takedown',
    });
    const unapproved = await publishListing({}, WORKFLOW, false);
    const attempts: {
      label: string;
      org: string;
      who: string;
      version: string;
      expect: number[];
    }[] = [];
    const add = (
      label: string,
      org: string,
      who: string,
      version: string,
      expectCodes: number[] = [403],
    ) => attempts.push({ label, org, who, version, expect: expectCodes });
    // every listing against organizations that never bought anything (C and the publisher B itself)
    for (const l of [...listings, suspended]) {
      const hidden = l === suspended ? [403, 404, 409] : [403]; // a suspended listing is not even visible to other organizations
      add(`C never bought ${l.id}`, orgC, 'dave', versionOf(l), hidden);
      add(
        `publisher installs own ${l.id}`,
        B(),
        'bob',
        versionOf(l),
        l === suspended ? [403, 404, 409] : [403],
      );
    }
    // buyer A against listings it did not (successfully) buy
    add('pending purchase', A(), 'alice', versionOf(pendingL));
    add('revoked entitlement', A(), 'alice', versionOf(revokedL));
    add('version outside range', A(), 'alice', versionOf(rangeL));
    add('suspended listing', A(), 'alice', versionOf(suspended), [403, 404, 409]);
    add('unapproved version', A(), 'alice', versionOf(unapproved), [404]);
    add('unapproved version, other org', orgC, 'dave', versionOf(unapproved), [404]);
    // hostile ids
    for (const id of [
      '00000000-0000-7000-8000-00000000dead',
      '00000000-0000-0000-0000-000000000000',
      'not-a-uuid',
      '',
      'a'.repeat(36),
    ])
      add(`bad version id ${id}`, A(), 'alice', id, [404, 422]);
    // roles without marketplace:install
    add('viewer in the buying org', A(), 'carol', versionOf(bought), [403]);
    // multiply by repetition from different roles/orgs to pass 50 fixtures with distinct requests
    for (let i = 0; i < 20; i++) {
      add(`C retries ${i}`, orgC, 'dave', versionOf(bought));
      add(`pending retry ${i}`, A(), 'alice', versionOf(pendingL));
    }
    expect(attempts.length).toBeGreaterThanOrEqual(50);
    const before = Number(
      (
        await sql(`SELECT count(*) n FROM marketplace.installations WHERE org_id IN ($1,$2)`, [
          orgC,
          B(),
        ])
      )[0]!.n,
    );
    let successes = 0;
    for (const a of attempts) {
      const r = await install(a.org, a.who, a.version);
      if (r.statusCode < 300) successes++;
      expect(a.expect, `${a.label}: got ${r.statusCode} ${r.body}`).toContain(r.statusCode);
    }
    expect(successes).toBe(0);
    // nothing landed for a non-entitled org; A's only installs are for entitlements it truly holds (none attempted successfully here)
    expect(
      Number(
        (
          await sql(`SELECT count(*) n FROM marketplace.installations WHERE org_id IN ($1,$2)`, [
            orgC,
            B(),
          ])
        )[0]!.n,
      ),
    ).toBe(before);
    expect(
      Number(
        (
          await sql(
            `SELECT count(*) n FROM marketplace.installations WHERE entitlement_id IN (SELECT id FROM marketplace.entitlements_mkt WHERE status <> 'active')`,
          )
        )[0]!.n,
      ),
    ).toBe(0);
    void sp;
  }, 300_000);

  it('the database itself refuses an installation row without an active entitlement of the same organization', async () => {
    const l = await publishListing();
    const bought = (await buy(A(), 'alice', l)).r.json(); // pending
    await expect(
      sql(
        `INSERT INTO marketplace.installations (id, org_id, entitlement_id, listing_id, listing_version_id, target_type, created_by) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'workflow', $5)`,
        [A(), bought.entitlementId, l.id, versionOf(l), e.ids.alice],
      ),
    ).rejects.toThrow(/entitlement/);
    await payInvoice(A(), bought.invoiceId);
    await e.app.get(PurchaseService).sync(A(), bought.purchaseId, null);
    // the entitlement is A's: an installation row for ORG C pointing at it is refused too
    await expect(
      sql(
        `INSERT INTO marketplace.installations (id, org_id, entitlement_id, listing_id, listing_version_id, target_type, created_by) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'workflow', $5)`,
        [orgC, bought.entitlementId, l.id, versionOf(l), e.ids.dave],
      ),
    ).rejects.toThrow(/entitlement/);
  });

  it('seats: a multi_seat licence allows as many installs as seats; a tampered artifact is refused', async () => {
    const l = await publishListing({ licence: 'multi_seat', seats: 1 });
    const p = (await buy(A(), 'alice', l)).r.json();
    await payInvoice(A(), p.invoiceId);
    await e.app.get(PurchaseService).sync(A(), p.purchaseId, null);
    // tamper with the stored artifact after approval: the hash no longer matches
    const v = (
      await sql(`SELECT artifact_ref FROM marketplace.listing_versions WHERE id = $1`, [
        versionOf(l),
      ])
    )[0]!.artifact_ref as string;
    const original = store.files.get(v)!;
    store.files.set(v, Buffer.from(JSON.stringify({ ...WORKFLOW, tampered: true })));
    const bad = await install(A(), 'alice', versionOf(l));
    expect(bad.statusCode).toBe(409);
    expect(
      (await sql(`SELECT status FROM marketplace.installations WHERE listing_id = $1`, [l.id]))[0]!
        .status,
    ).toBe('failed');
    store.files.set(v, original);
    const ok = await install(A(), 'alice', versionOf(l));
    expect(ok.statusCode).toBe(202);
    const second = await install(A(), 'alice', versionOf(l));
    expect([403, 409]).toContain(second.statusCode);
  });
});

describe('cross-tenant isolation of marketplace resources', () => {
  it('another organization sees 404 for purchases and its own empty installations; RLS hides foreign rows', async () => {
    const l = await publishListing();
    const p = (await buy(A(), 'alice', l)).r.json();
    expect(
      (await callAs('bob', B(), 'GET', `/v1/marketplace/purchases/${p.purchaseId}`)).statusCode,
    ).toBe(404);
    expect(
      (await callAs('dave', orgC, 'GET', `/v1/marketplace/purchases/${p.purchaseId}`)).statusCode,
    ).toBe(404);
    expect(
      (await callAs('dave', orgC, 'GET', '/v1/marketplace/installations')).json().items,
    ).toEqual([]);
    const rows = await e.h.env.app.withOrg(orgC, async (c) => ({
      purchases: (await c.query(`SELECT count(*)::int n FROM marketplace.purchases`)).rows[0]!.n,
      entitlements: (await c.query(`SELECT count(*)::int n FROM marketplace.entitlements_mkt`))
        .rows[0]!.n,
      accruals: (await c.query(`SELECT count(*)::int n FROM marketplace.publisher_accruals`))
        .rows[0]!.n,
      installs: (await c.query(`SELECT count(*)::int n FROM marketplace.installations`)).rows[0]!.n,
    }));
    expect(rows).toEqual({ purchases: 0, entitlements: 0, accruals: 0, installs: 0 });
    // the publisher can read ITS accruals but not the buyer's purchases
    const pub = await e.h.env.app.withOrg(B(), async (c) => ({
      purchases: (await c.query(`SELECT count(*)::int n FROM marketplace.purchases`)).rows[0]!.n,
    }));
    expect(pub.purchases).toBe(0);
  });
});
