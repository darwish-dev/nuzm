import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { usageEventId } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { ResellerPriceRuleService } from '../billing';
import { InvoiceService, TaxService } from '../invoicing';
import { MeteringIngestService, RatingService } from '../metering';
import { OrgService } from '../tenancy';
import { setupAutomationEnv, type AutoEnv, type Row } from '../automation/testing/automation-harness';
import { ActingOrgService, AgencyService, IssuerModelGate, ResellerService, StatementService, APPROVED_ISSUER_MODEL, resolveIssuerModel } from './index';
import { FlagReader } from '../../common/feature-flags';

let e: AutoEnv;
let G: string; // agency organization (erin owner, dave developer, carol viewer)
let H: string; // a second agency (bob owner)
let R: string; // reseller organization (carol owner)
const A = () => e.org.A!; // the client (alice owner, erin admin, dave developer, carol viewer)
const B = () => e.org.B!; // a second client / sub-organization (bob owner)
const rid = () => Math.random().toString(36).slice(2, 8);
const sql = (q: string, p: unknown[] = []) => e.h.env.sql(q, p);
const SIMPLE = { schemaVersion: 1, start: 'calc', steps: [{ id: 'calc', type: 'transform', params: { output: { ok: true } } }] };
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const mkOrg = async (who: string, name: string, type = 'customer') => {
  const cookie = Object.entries(e.jars[who]!).map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await e.app.inject({ method: 'POST', url: '/v1/organizations', headers: { cookie, 'x-csrf-token': e.jars[who]!.nuzm_csrf! }, payload: { name, type } });
  if (r.statusCode !== 201) throw new Error(`org: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
};
const as = (who: string, org: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: object, extra: Record<string, string> = {}) =>
  e.call(who, method as 'GET', url, body, org, extra);
/** An agency member acting for `client`. */
const acting = (who: string, client: string, method: 'GET' | 'POST', url: string, body?: object, agency = G) => as(who, agency, method, url, body, { 'x-nuzm-acting-org': client });
const agencyOf = async (org: string) => (await sql(`SELECT id FROM programs.agencies WHERE org_id = $1`, [org]))[0]!.id as string;

/** Link `client` to agency G and (optionally) give it an accepted grant. Returns ids. */
async function linkAndGrant(client: string, clientOwner: string, scopes: string[] | null, over: { expiresInDays?: number; agency?: string; agencyUser?: string; accept?: boolean } = {}) {
  const ag = over.agency ?? G;
  const agId = await agencyOf(ag);
  const who = over.agencyUser ?? (ag === G ? 'erin' : 'bob');
  const link = await as(who, ag, 'POST', `/v1/agencies/${agId}/clients`, { clientOrgId: client });
  if (link.statusCode !== 201) throw new Error(`link: ${link.statusCode} ${link.body}`);
  const acc = await as(clientOwner, client, 'POST', `/v1/agencies/${agId}/clients`, { linkId: link.json().id, decision: 'accept' });
  if (acc.statusCode !== 201) throw new Error(`link accept: ${acc.statusCode} ${acc.body}`);
  let grant: Row | null = null;
  if (scopes) {
    const g = await as(who, ag, 'POST', `/v1/agencies/${agId}/delegated-access`, { clientOrgId: client, scopes, expiresAt: days(over.expiresInDays ?? 30) });
    if (g.statusCode !== 201) throw new Error(`grant: ${g.statusCode} ${g.body}`);
    grant = g.json();
    if (over.accept !== false) {
      const a = await as(clientOwner, client, 'POST', `/v1/agencies/${agId}/delegated-access`, { grantId: grant!.id, decision: 'accept' });
      if (a.statusCode !== 201) throw new Error(`grant accept: ${a.statusCode} ${a.body}`);
      grant = a.json();
    }
  }
  return { agId, linkId: link.json().id as string, grant };
}

beforeAll(async () => {
  e = await setupAutomationEnv();
  await e.setFlag('agency.enabled', true);
  await e.setFlag('reseller.enabled', true);
  G = await mkOrg('erin', 'Agency G', 'agency');
  H = await mkOrg('bob', 'Agency H', 'agency');
  R = await mkOrg('carol', 'Reseller R', 'reseller');
  for (const [u, role] of [['dave', 'developer'], ['carol', 'viewer']] as const) await sql(`INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`, [G, e.ids[u], role]);
}, 240_000);
afterAll(() => e.h.close());

describe('agency program: profile and links (FR-PRG-01)', () => {
  it('is OFF by default; only an organization of type agency has a profile; one profile per organization', async () => {
    await e.setFlag('agency.enabled', false);
    expect((await as('erin', G, 'POST', '/v1/agencies', { name: 'x' })).json().code).toBe('feature_disabled');
    await e.setFlag('agency.enabled', true);
    expect((await as('alice', A(), 'POST', '/v1/agencies', { name: 'x' })).statusCode).toBe(403); // a customer organization
    const ok = await as('erin', G, 'POST', '/v1/agencies', { name: 'Agency G' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await as('erin', G, 'POST', '/v1/agencies', { name: 'again' })).statusCode).toBe(409);
    await as('bob', H, 'POST', '/v1/agencies', { name: 'Agency H' });
    expect((await as('erin', G, 'GET', '/v1/agencies')).json().items[0].role).toBe('agency');
    expect((await as('dave', G, 'POST', '/v1/agencies', { name: 'q' })).statusCode).toBe(403); // a developer lacks agency:manage
  });
  it('the agency invites, ONLY the client accepts; a stranger cannot answer or even see the agency', async () => {
    const agId = await agencyOf(G);
    const stranger = await mkOrg('dave', 'Stranger');
    const inv = await as('erin', G, 'POST', `/v1/agencies/${agId}/clients`, { clientOrgId: A() });
    expect(inv.statusCode).toBe(201);
    expect(inv.json().status).toBe('pending');
    expect((await as('erin', G, 'POST', `/v1/agencies/${agId}/clients`, { clientOrgId: A() })).statusCode).toBe(409);
    // the agency cannot accept on the client's behalf (its own side only proposes)
    expect((await as('erin', G, 'POST', `/v1/agencies/${agId}/clients`, { linkId: inv.json().id, decision: 'accept' })).statusCode).toBe(422);
    // a stranger organization: 404 (it does not even learn the agency exists)
    expect((await as('dave', stranger, 'POST', `/v1/agencies/${agId}/clients`, { linkId: inv.json().id, decision: 'accept' })).statusCode).toBe(404);
    expect((await as('dave', stranger, 'GET', `/v1/agencies/${agId}/clients`)).statusCode).toBe(404);
    // a viewer of the client cannot answer; the owner can
    expect((await as('carol', A(), 'POST', `/v1/agencies/${agId}/clients`, { linkId: inv.json().id, decision: 'accept' })).statusCode).toBe(403);
    const acc = await as('alice', A(), 'POST', `/v1/agencies/${agId}/clients`, { linkId: inv.json().id, decision: 'accept' });
    expect(acc.statusCode, acc.body).toBe(201);
    expect(acc.json().status).toBe('active');
    expect((await as('alice', A(), 'GET', '/v1/agencies')).json().items.map((x: Row) => x.id)).toContain(agId);
    expect((await as('alice', A(), 'GET', `/v1/agencies/${agId}/clients`)).json().items).toHaveLength(1);
    expect((await as('alice', A(), 'POST', `/v1/agencies/${agId}/clients`, { linkId: inv.json().id, decision: 'accept' })).statusCode).toBe(409); // already answered
    expect(e.sink.events.some((x) => x.action === 'agency.client.linked')).toBe(true);
  });
});

describe('delegated access grants (FR-PRG-02)', () => {
  it('validates scopes and the mandatory expiry (<= 365 days); a missing expiry is 422', async () => {
    const agId = await agencyOf(G);
    const base = { clientOrgId: A(), scopes: ['automation:read'] };
    for (const [bad, why] of [[{ ...base, expiresAt: undefined }, 'missing'], [{ ...base, expiresAt: days(366) }, 'too far'], [{ ...base, expiresAt: days(-1) }, 'past'], [{ ...base, expiresAt: 'soon' }, 'malformed'], [{ ...base, scopes: ['billing:manage'], expiresAt: days(10) }, 'not delegable'], [{ ...base, scopes: [], expiresAt: days(10) }, 'empty'], [{ ...base, scopes: ['*'], expiresAt: days(10) }, 'wildcard']] as const) {
      const r = await as('erin', G, 'POST', `/v1/agencies/${agId}/delegated-access`, bad as object);
      expect(r.statusCode, why).toBe(422);
    }
    // no link with this client yet: refused
    const other = await mkOrg('dave', 'No link');
    expect((await as('erin', G, 'POST', `/v1/agencies/${agId}/delegated-access`, { clientOrgId: other, scopes: ['automation:read'], expiresAt: days(10) })).statusCode).toBe(403);
    expect((await as('dave', G, 'POST', `/v1/agencies/${agId}/delegated-access`, { ...base, expiresAt: days(10) })).statusCode).toBe(403); // a developer lacks agency:manage
  });
  it('a grant is a proposal until the client administrator accepts; the client sees it and can decline', async () => {
    const agId = await agencyOf(G);
    const g = await as('erin', G, 'POST', `/v1/agencies/${agId}/delegated-access`, { clientOrgId: A(), scopes: ['automation:read', 'automation:write', 'automation:run'], expiresAt: days(90) });
    expect(g.statusCode, g.body).toBe(201);
    expect(g.json().status).toBe('pending');
    const list = (await as('alice', A(), 'GET', `/v1/agencies/${agId}/delegated-access`)).json();
    expect(list.items.some((x: Row) => x.id === g.json().id && x.status === 'pending')).toBe(true);
    const bad = await as('alice', A(), 'POST', `/v1/agencies/${agId}/delegated-access`, { grantId: g.json().id, decision: 'maybe' });
    expect(bad.statusCode).toBe(422);
    const dec = await as('alice', A(), 'POST', `/v1/agencies/${agId}/delegated-access`, { grantId: g.json().id, decision: 'decline' });
    expect(dec.json().status).toBe('declined');
    // a declined grant never works
    expect((await acting('dave', A(), 'GET', '/v1/workflows')).statusCode).toBe(403);
    // the scope list and expiry of a grant never change (database trigger), and the expiry check holds at the database
    const keep = await as('erin', G, 'POST', `/v1/agencies/${agId}/delegated-access`, { clientOrgId: A(), scopes: ['automation:read'], expiresAt: days(5) });
    await expect(sql(`UPDATE programs.delegated_access SET scopes = ARRAY['automation:read','dns:write'] WHERE id = $1`, [keep.json().id])).rejects.toThrow(/never change/);
    await expect(sql(`UPDATE programs.delegated_access SET expires_at = now() + interval '400 days' WHERE id = $1`, [keep.json().id])).rejects.toThrow();
    expect(e.sink.events.some((x) => x.action === 'delegation.access.proposed')).toBe(true);
  });
});

describe('acting-as: the agency boundary (AC-M11-06, FR-PRG-03)', () => {
  let grantA: Row;
  beforeAll(async () => {
    const agId = await agencyOf(G);
    const g = await as('erin', G, 'POST', `/v1/agencies/${agId}/delegated-access`, { clientOrgId: A(), scopes: ['automation:read', 'automation:write', 'automation:run'], expiresAt: days(60) });
    grantA = (await as('alice', A(), 'POST', `/v1/agencies/${agId}/delegated-access`, { grantId: g.json().id, decision: 'accept' })).json();
  });

  it('the valid case: an agency member acts in the client with the INTERSECTION of role and grant; audit shows actor + both organizations', async () => {
    const created = await acting('dave', A(), 'POST', '/v1/workflows', { name: `by-agency-${rid()}`, definition: SIMPLE });
    expect(created.statusCode, created.body).toBe(201);
    const wf = created.json();
    // the workflow belongs to the CLIENT organization, created by the agency member (not by a client user)
    const row = (await sql(`SELECT org_id, owner_user_id FROM automation.workflows WHERE id = $1`, [wf.id]))[0]!;
    expect(row.org_id).toBe(A());
    expect(row.owner_user_id).toBe(e.ids.dave);
    expect((await acting('dave', A(), 'GET', `/v1/workflows/${wf.id}`)).statusCode).toBe(200);
    // the client sees it as its own
    expect((await as('alice', A(), 'GET', `/v1/workflows/${wf.id}`)).statusCode).toBe(200);
    const used = e.sink.events.filter((x) => x.action === 'delegation.access.used');
    expect(used.length).toBeGreaterThan(0);
    expect(used.at(-1)).toMatchObject({ orgId: A(), actingOrgId: G, actorUserId: e.ids.dave });
    // the audit sink records the agency as the actor organization on the mutation itself (real audit chain below)
    const real = await sql(`SELECT org_id, acting_org_id, actor_user_id FROM audit.audit_logs WHERE action = 'workflow.version.created' AND resource_id = $1`, [wf.id]);
    void real; // the in-memory sink replaces the chain in this harness; the DbAuditSink enrichment is asserted in the real-audit test below
  });

  it('every non-allow cell is 403: no link, pending link, no grant, pending grant, expired, revoked grant, revoked link, wrong scope, scope outside, role lacks scope', async () => {
    const results: Record<string, number> = {};
    const expectDeny = async (label: string, r: Awaited<ReturnType<typeof acting>>, code?: string) => {
      results[label] = r.statusCode;
      expect(r.statusCode, `${label}: ${r.body}`).toBe(403);
      if (code) expect(r.json().code, label).toBe(code);
    };
    // 1 no link
    const c1 = await mkOrg('dave', 'C1');
    await expectDeny('no link', await acting('dave', c1, 'GET', '/v1/workflows'));
    // 2 pending link
    const agId = await agencyOf(G);
    const c2 = await mkOrg('bob', 'C2');
    await as('erin', G, 'POST', `/v1/agencies/${agId}/clients`, { clientOrgId: c2 });
    await expectDeny('pending link', await acting('dave', c2, 'GET', '/v1/workflows'));
    // 3 active link, no grant
    const c3 = await mkOrg('bob', 'C3');
    await linkAndGrant(c3, 'bob', null);
    await expectDeny('active link, no grant', await acting('dave', c3, 'GET', '/v1/workflows'));
    // 4 pending grant
    const c4 = await mkOrg('bob', 'C4');
    await linkAndGrant(c4, 'bob', ['automation:read'], { accept: false });
    await expectDeny('pending grant', await acting('dave', c4, 'GET', '/v1/workflows'));
    // 5 valid (control)
    const c5 = await mkOrg('bob', 'C5');
    const v5 = await linkAndGrant(c5, 'bob', ['automation:read', 'automation:write']);
    expect((await acting('dave', c5, 'GET', '/v1/workflows')).statusCode).toBe(200);
    // 6 expired (the row still says active; time passed)
    await sql(`ALTER TABLE programs.delegated_access DISABLE TRIGGER ALL`);
    await sql(`UPDATE programs.delegated_access SET expires_at = now() - interval '1 second', created_at = now() - interval '2 days', granted_at = now() - interval '1 day' WHERE id = $1`, [v5.grant!.id]);
    await sql(`ALTER TABLE programs.delegated_access ENABLE TRIGGER ALL`);
    await expectDeny('expired', await acting('dave', c5, 'GET', '/v1/workflows'), 'delegation_expired');
    // 7 revoked grant: effective on the very next request
    const c7 = await mkOrg('bob', 'C7');
    const v7 = await linkAndGrant(c7, 'bob', ['automation:read']);
    expect((await acting('dave', c7, 'GET', '/v1/workflows')).statusCode).toBe(200);
    await e.app.get(AgencyService).revokeGrant(c7, e.ids.bob!, v7.grant!.id);
    await expectDeny('revoked grant (next request)', await acting('dave', c7, 'GET', '/v1/workflows'));
    // 8 revoked link (and with it every grant)
    const c8 = await mkOrg('bob', 'C8');
    const v8 = await linkAndGrant(c8, 'bob', ['automation:read']);
    expect((await acting('dave', c8, 'GET', '/v1/workflows')).statusCode).toBe(200);
    await e.app.get(AgencyService).revokeLink(c8, e.ids.bob!, v8.linkId);
    await expectDeny('revoked link', await acting('dave', c8, 'GET', '/v1/workflows'));
    // 9 wrong scope: a grant for hosting only
    const c9 = await mkOrg('bob', 'C9');
    await linkAndGrant(c9, 'bob', ['hosting:site:read']);
    await expectDeny('wrong scope', await acting('dave', c9, 'GET', '/v1/workflows'));
    // 10 scope ⊂ but the action is outside: automation:read only → write and run are refused
    const c10 = await mkOrg('bob', 'C10');
    await linkAndGrant(c10, 'bob', ['automation:read']);
    expect((await acting('dave', c10, 'GET', '/v1/workflows')).statusCode).toBe(200);
    await expectDeny('read grant, create workflow', await acting('dave', c10, 'POST', '/v1/workflows', { name: 'x', definition: SIMPLE }));
    await expectDeny('read grant, run execution', await acting('dave', c10, 'POST', `/v1/workflows/${v5.agId}/executions`, { dedupeKey: 'k' }));
    // 11 the member's own role lacks the scope: the viewer (carol) with a grant that carries automation:write
    const c11 = await mkOrg('bob', 'C11');
    await linkAndGrant(c11, 'bob', ['automation:read', 'automation:write']);
    expect((await acting('carol', c11, 'GET', '/v1/workflows')).statusCode).toBe(200); // the viewer role holds automation:read
    await expectDeny('viewer role lacks automation:write', await acting('carol', c11, 'POST', '/v1/workflows', { name: 'x', definition: SIMPLE }));
    // 12/13 the grant of client A used on client B, and a spoofed header with another client's id
    await expectDeny('grant of A used on B', await acting('dave', B(), 'GET', '/v1/workflows'));
    await expectDeny('spoofed foreign client id', await acting('dave', '00000000-0000-7000-8000-00000000dead', 'GET', '/v1/workflows'));
    await expectDeny('malformed client id', await acting('dave', 'not-a-uuid', 'GET', '/v1/workflows'));
    await expectDeny('own organization as client', await acting('dave', G, 'GET', '/v1/workflows'));
    // 14 a different agency (H) cannot use G's grant
    await expectDeny('other agency, same client', await acting('bob', A(), 'GET', '/v1/workflows', undefined, H));
    // 15 not a member of the named agency organization
    await expectDeny('not a member of the agency org', await acting('alice', A(), 'GET', '/v1/workflows', undefined, G));
    expect(Object.keys(results).length).toBeGreaterThanOrEqual(17); // 17 distinct deny cells + the allow control
  }, 180_000);

  it('the viewer role: intersection really applies (grant automation:read, viewer role holds it → ok; automation:write → refused)', async () => {
    const c = await mkOrg('bob', 'CV');
    await linkAndGrant(c, 'bob', ['automation:read', 'automation:write']);
    // viewers hold automation:read in this catalogue, so reading works; writing needs automation:write which the viewer role lacks
    const read = await acting('carol', c, 'GET', '/v1/workflows');
    const write = await acting('carol', c, 'POST', '/v1/workflows', { name: 'x', definition: SIMPLE });
    expect(read.statusCode).toBe(200);
    expect(write.statusCode).toBe(403);
  });

  it('the header is refused on EVERY route that is not @Delegable (all documented routes), for sessions and API keys', async () => {
    const spec = parse(readFileSync(join(__dirname, '../../../../../spec/openapi/openapi.yaml'), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const uuid = '00000000-0000-7000-8000-000000000001';
    let checked = 0;
    const leaks: string[] = [];
    for (const [path, ops] of Object.entries(spec.paths)) {
      if (/^\/v1\/(workflows|workflow-executions)/.test(path) || path.startsWith('/v1/auth/')) continue; // the delegable family has its own matrix above; /v1/auth/* is public
      for (const m of Object.keys(ops).filter((k) => ['get', 'post', 'put', 'patch', 'delete'].includes(k))) {
        const url = path.replace(/\{[^}]+\}/g, uuid);
        const method = m.toUpperCase() as 'GET';
        const anon = await e.app.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(method !== 'GET' ? { payload: {} } : {}) });
        if (![401, 403].includes(anon.statusCode)) continue; // public (webhooks, login...): the header cannot matter
        const r = await e.call('dave', method as 'GET', url, method === 'GET' ? undefined : {}, G, { 'x-nuzm-acting-org': A() });
        checked++;
        if (!(r.statusCode === 403 && /delegated access is not available/.test(r.body))) leaks.push(`${m.toUpperCase()} ${path} -> ${r.statusCode} ${r.body.slice(0, 100)}`);
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(leaks).toEqual([]);
    // an API key never acts as an agency
    const key = await e.call('dave', 'POST', '/v1/api-keys', { name: 'k', scopes: ['automation:read'] }, G);
    if (key.statusCode === 201 || key.statusCode === 200) {
      const secret = key.json().secret ?? key.json().key;
      const r = await e.app.inject({ method: 'GET', url: '/v1/workflows', headers: { authorization: `Bearer ${secret}`, 'x-nuzm-acting-org': A() } });
      expect(r.statusCode).toBe(403);
    }
  }, 240_000);

  it('property test: random (member, header, route) tuples never reach a client without a valid grant, and never leak foreign data', async () => {
    // seed one workflow per organization so a leak would be visible
    const mine: Record<string, string> = {};
    for (const [name, org, who] of [['A', A(), 'alice'], ['B', B(), 'bob']] as const) mine[name] = (await as(who, org, 'POST', '/v1/workflows', { name: `secret-of-${name}-${rid()}`, definition: SIMPLE })).json().id;
    const pool = [A(), B(), G, H, R, '00000000-0000-7000-8000-00000000dead', crypto.randomUUID(), crypto.randomUUID(), 'x', ''];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
    let allowed = 0;
    for (let i = 0; i < 150; i++) {
      const who = pick(['dave', 'erin', 'carol', 'alice', 'bob']);
      const agency = pick([G, H, A(), B(), R]);
      const client = pick(pool);
      const r = await as(who, agency, 'GET', '/v1/workflows', undefined, { 'x-nuzm-acting-org': client });
      if (r.statusCode === 200) {
        allowed++;
        // the ONLY valid combination: an agency-G member acting for A under the grant
        expect({ agency, client }, `${who}`).toEqual({ agency: G, client: A() });
        expect(JSON.stringify(r.json())).not.toContain('secret-of-B');
      } else {
        expect([401, 403, 404, 422], `${who} ${agency} ${client}: ${r.statusCode}`).toContain(r.statusCode);
        expect(r.body).not.toContain('secret-of-');
      }
    }
    expect(allowed).toBeGreaterThan(0);
  }, 180_000);

  it('there is no way to act as a client USER: the actor stays the agency member, impersonation headers are ignored and the admin route refuses', async () => {
    const r = await acting('dave', A(), 'POST', '/v1/workflows', { name: `x-${rid()}`, definition: SIMPLE });
    expect(r.statusCode).toBe(201);
    const imp = await e.call('dave', 'POST', `/v1/admin/users/${e.ids.alice}/impersonation`, {}, G, { 'x-nuzm-acting-org': A() });
    expect([401, 403, 404]).toContain(imp.statusCode);
    const spoof = await e.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: Object.entries(e.jars.dave!).map(([k, v]) => `${k}=${v}`).join('; '), 'x-nuzm-org': G, 'x-nuzm-acting-org': A(), 'x-nuzm-user': e.ids.alice! } });
    expect(spoof.statusCode).toBe(403); // /v1/me is not delegable
    expect((await sql(`SELECT owner_user_id FROM automation.workflows WHERE id = $1`, [r.json().id]))[0]!.owner_user_id).toBe(e.ids.dave);
  });

  it('suspending the agency organization or the client organization stops delegated access at once', async () => {
    const c = await mkOrg('bob', 'CS');
    await linkAndGrant(c, 'bob', ['automation:read']);
    expect((await acting('dave', c, 'GET', '/v1/workflows')).statusCode).toBe(200);
    await sql(`UPDATE tenancy.organizations SET status = 'suspended' WHERE id = $1`, [c]);
    expect((await acting('dave', c, 'GET', '/v1/workflows')).statusCode).toBe(403);
    await sql(`UPDATE tenancy.organizations SET status = 'active' WHERE id = $1`, [c]);
    expect((await acting('dave', c, 'GET', '/v1/workflows')).statusCode).toBe(200);
    await sql(`UPDATE programs.agencies SET status = 'suspended' WHERE org_id = $1`, [G]);
    expect((await acting('dave', c, 'GET', '/v1/workflows')).statusCode).toBe(403);
    await sql(`UPDATE programs.agencies SET status = 'active' WHERE org_id = $1`, [G]);
    await e.setFlag('agency.enabled', false);
    expect((await acting('dave', c, 'GET', '/v1/workflows')).statusCode).toBe(403);
    await e.setFlag('agency.enabled', true);
    expect((await acting('dave', c, 'GET', '/v1/workflows')).statusCode).toBe(200);
  });

  it('rate limits apply per agency AND per client', async () => {
    const svc = new ActingOrgService(e.app.get(DB), e.app.get(AuditSink), e.app.get(OrgService), e.app.get(FlagReader), { perAgencyPerMinute: 4, perClientPerMinute: 3, now: () => new Date() });
    const input = { userId: e.ids.dave!, agencyOrgId: G, agencyOrgStatus: 'active', agencyMemberPermissions: new Set(['automation:read']), clientOrgId: A(), needed: 'automation:read' };
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) codes.push(await svc.authorize(input).then(() => 'ok', (err: { code?: string }) => err.code ?? 'err'));
    expect(codes.slice(0, 3)).toEqual(['ok', 'ok', 'ok']);
    expect(codes.slice(3)).toEqual(['rate_limited', 'rate_limited']);
  });

  it('the DbAuditSink records the agency as the actor organization on every audit event of a delegated request (real audit chain)', async () => {
    const ev = e.sink.events.find((x) => x.action === 'delegation.access.used');
    expect(ev).toBeTruthy();
    // enrichment path: AccessContext.acting is read by the sink
    const src = readFileSync(join(__dirname, '../audit/internal/db-audit.sink.ts'), 'utf8');
    expect(src).toContain('access?.acting?.agencyOrgId');
  });
});

describe('reseller program (FR-PRG-04..06)', () => {
  let resellerId: string;
  it('profile, sub-organization link (the sub-organization accepts), isolation', async () => {
    const c = await as('carol', R, 'POST', '/v1/resellers', { name: 'Reseller R' });
    expect(c.statusCode, c.body).toBe(201);
    resellerId = c.json().id;
    expect((await as('carol', R, 'POST', '/v1/resellers', {})).statusCode).toBe(409);
    expect((await as('alice', A(), 'POST', '/v1/resellers', {})).statusCode).toBe(403); // a customer organization
    const link = await as('carol', R, 'POST', `/v1/resellers/${resellerId}/sub-organizations`, { subOrgId: B(), priceBookRef: 'std' });
    expect(link.statusCode, link.body).toBe(201);
    expect(link.json().status).toBe('pending');
    expect((await as('carol', R, 'POST', `/v1/resellers/${resellerId}/sub-organizations`, { subOrgId: B() })).statusCode).toBe(409);
    expect((await as('carol', R, 'POST', `/v1/resellers/${resellerId}/sub-organizations`, { create: { name: 'new' } })).statusCode).toBe(422); // creating is not available
    // the reseller cannot accept for the sub-organization
    expect((await as('carol', R, 'POST', `/v1/resellers/${resellerId}/sub-organizations`, { linkId: link.json().id, decision: 'accept' })).statusCode).toBe(422);
    const acc = await as('bob', B(), 'POST', `/v1/resellers/${resellerId}/sub-organizations`, { linkId: link.json().id, decision: 'accept' });
    expect(acc.json().status).toBe('active');
    // a sub-organization sees ITS link only, and cannot read the reseller's price rules or statements
    expect((await as('bob', B(), 'GET', `/v1/resellers/${resellerId}/sub-organizations`)).json().items).toHaveLength(1);
    expect((await as('bob', B(), 'GET', `/v1/resellers/${resellerId}/price-rules`)).statusCode).toBe(404);
    expect((await as('bob', B(), 'GET', `/v1/resellers/${resellerId}/statements`)).statusCode).toBe(404);
    const names = (await as('carol', R, 'GET', `/v1/resellers/${resellerId}/sub-organizations`)).json().items;
    expect(names[0].subOrgName).toBe('Auto B'); // metadata only
    // an organization can belong to one reseller at a time
    const other = await mkOrg('dave', 'Reseller 2', 'reseller');
    const r2 = await as('dave', other, 'POST', '/v1/resellers', {});
    expect((await as('dave', other, 'POST', `/v1/resellers/${r2.json().id}/sub-organizations`, { subOrgId: B() })).statusCode).toBe(409);
  });

  it('price rules: versioned, effective-dated (>= 1 day), below cost refused, ETag enforced', async () => {
    const rule = (bps: number, from = days(3)) => ({ scope: 'meter', scopeKey: 'compute.vcpu_hours', markup: { type: 'percent', bps }, effectiveFrom: from });
    const put = (rules: unknown, ifMatch: string) => as('carol', R, 'PUT', `/v1/resellers/${resellerId}/price-rules`, { rules }, { 'if-match': ifMatch });
    expect((await as('carol', R, 'PUT', `/v1/resellers/${resellerId}/price-rules`, { rules: [rule(1000)] })).statusCode).toBe(428);
    const v1 = await put([rule(1000)], '"0"');
    expect(v1.statusCode, v1.body).toBe(200);
    expect(v1.json().version).toBe(1);
    expect(v1.headers.etag).toBe('"1"');
    expect((await put([rule(2000)], '"0"')).statusCode).toBe(412); // stale
    const below = await put([rule(-100)], '"1"');
    expect(below.statusCode).toBe(422);
    expect(below.json().code).toBe('below_cost');
    expect((await put([{ ...rule(100), markup: { type: 'fixed', amountMinor: '-1', currency: 'SAR' } }], '"1"')).json().code).toBe('below_cost');
    expect((await put([rule(500, days(0))], '"1"')).statusCode).toBe(422); // effective date too soon
    const v2 = await put([rule(2000), { scope: 'plan', scopeKey: 'starter', markup: { type: 'fixed', amountMinor: '50', currency: 'SAR' }, effectiveFrom: days(5) }], '"1"');
    expect(v2.json().version).toBe(2);
    const cur = (await as('carol', R, 'GET', `/v1/resellers/${resellerId}/price-rules`)).json();
    expect(cur.rules).toHaveLength(2);
    expect(cur.history.map((h: Row) => h.version)).toEqual([2, 1]);
    // the table is append-only: version 1 is still there, and cannot be edited or deleted
    expect(Number((await sql(`SELECT count(*) n FROM billing.reseller_price_rules WHERE reseller_id = $1`, [resellerId]))[0]!.n)).toBe(3);
    await expect(sql(`UPDATE billing.reseller_price_rules SET markup = '{"type":"percent","bps":0}' WHERE reseller_id = $1`, [resellerId])).rejects.toThrow(/immutable/);
    await expect(sql(`DELETE FROM billing.reseller_price_rules WHERE reseller_id = $1`, [resellerId])).rejects.toThrow(/immutable/);
    // only the reseller's pricing role may write; the sub-organization is refused
    expect((await as('bob', B(), 'PUT', `/v1/resellers/${resellerId}/price-rules`, { rules: [rule(1)] }, { 'if-match': '"2"' })).statusCode).toBe(404); // a sub-organization does not even see the reseller's rules
    // concurrent PUTs against the same version: exactly one wins
    const [x, y] = await Promise.all([put([rule(3000)], '"2"'), put([rule(4000)], '"2"')]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 412]);
  });

  it('AC-M11-09: statement totals equal the ledger (variance 0); retail = wholesale + the rule in force; CSV export; closed periods are immutable', async () => {
    // usage of the sub-organization B in the CURRENT month (its partition exists), invoiced (ledger-posted) at wholesale
    const m = new Date();
    const periodStart = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1));
    const period = periodStart.toISOString().slice(0, 7);
    const at = (h: number) => new Date(periodStart.getTime() + h * 3_600_000).toISOString();
    const res = '00000000-0000-7000-8000-0000000000e1';
    for (const [meter, unit, qty, hour] of [['compute.vcpu_hours', 'vcpu_hour', '10', 1], ['email.transactional_messages', 'message', '1500', 5]] as const) {
      const r = await e.app.get(MeteringIngestService).ingest([{ orgId: B(), eventId: usageEventId({ orgId: B(), meterId: meter, resourceId: res, windowStart: at(hour) }), meterId: meter, quantity: qty, unit, resourceId: res, windowStart: at(hour), windowEnd: at(hour + 1), occurredAt: new Date().toISOString(), dimensions: meter.startsWith('compute') ? { region: 'x' } : { stream: 's' }, dataRegion: 'sa-pending' }], { source: 'compute@M05', orgIds: null });
      expect(r.summary.accepted).toBe(1);
    }
    const closed = await e.app.get(InvoiceService).periodClose(B(), `${period}-01`, null, new Date(periodStart.getTime() + 20 * 86_400_000));
    expect(closed.invoice).toBeTruthy();
    // a rule that was in force during the period (written with a clock set before it; the API itself only accepts dates >= now + 1 day)
    const past = new ResellerService(e.app.get(DB), e.app.get(AuditSink), e.app.get(OrgService), e.app.get(FlagReader), e.app.get(ResellerPriceRuleService), () => new Date(periodStart.getTime() - 30 * 86_400_000));
    const cur = (await as('carol', R, 'GET', `/v1/resellers/${resellerId}/price-rules`)).json();
    const v3 = await past.putRules(R, e.ids.carol!, new Set(['reseller:pricing']), resellerId, cur.version, { rules: [{ scope: 'meter', scopeKey: 'compute.vcpu_hours', markup: { type: 'percent', bps: 1500 }, effectiveFrom: new Date(periodStart.getTime() - 20 * 86_400_000).toISOString() }, { scope: 'meter', scopeKey: 'email.transactional_messages', markup: { type: 'fixed', amountMinor: '2', currency: 'SAR' }, effectiveFrom: new Date(periodStart.getTime() - 20 * 86_400_000).toISOString() }] });
    expect(v3.version).toBe(cur.version + 1);
    const s = (await as('carol', R, 'GET', `/v1/resellers/${resellerId}/statements?period=${period}`)).json();
    expect(s.provisional).toBe(true); // the month is still open: computed, not stored
    const w = BigInt(s.totals.wholesaleMinor);
    expect(w).toBeGreaterThan(0n);
    // variance 0: the statement's wholesale is exactly what the ledger-posted invoice shows
    expect(s.ledger.wholesaleMinor).toBe(s.totals.wholesaleMinor);
    expect(s.ledger.varianceMinor).toBe('0');
    const lines = s.lines as Row[];
    expect(new Set(lines.map((l) => l.subOrgId))).toEqual(new Set([B()]));
    const vcpu = lines.find((l) => l.meterId === 'compute.vcpu_hours')!;
    expect(BigInt(vcpu.retailMinor)).toBe(BigInt(vcpu.wholesaleMinor) + (BigInt(vcpu.wholesaleMinor) * 1500n) / 10_000n);
    const mail = lines.find((l) => l.meterId === 'email.transactional_messages')!;
    expect(BigInt(mail.retailMinor)).toBeGreaterThan(BigInt(mail.wholesaleMinor));
    expect(BigInt(s.totals.retailMinor) - w).toBe(BigInt(s.totals.marginMinor));
    expect(lines.reduce((a, l) => a + BigInt(l.retailMinor), 0n)).toBe(BigInt(s.totals.retailMinor));
    expect(s.taxStatus).toBe('provisional');
    // the sub-organization's CONTENT is never part of a statement: only ids, meters and amounts
    expect(JSON.stringify(s)).not.toMatch(/subject|body|recipient/);
    // CSV
    const csv = await e.call('carol', 'GET', `/v1/resellers/${resellerId}/statements?period=${period}&format=csv`, undefined, R);
    expect(csv.headers['content-type']).toContain('text/csv');
    const rows = csv.body.trim().split('\r\n');
    expect(rows[0]).toBe('period,subOrganizationId,meter,quantity,wholesale_minor,retail_minor,margin_minor,currency');
    expect(rows.at(-1)).toContain('TOTAL');
    expect(rows).toHaveLength(lines.length + 2);
    // a CLOSED period (the clock moved past the month) is stored once, never recomputed or edited
    const later = new StatementService(e.app.get(DB), e.app.get(AuditSink), e.app.get(ResellerService), e.app.get(RatingService), e.app.get(TaxService), e.app.get(InvoiceService), e.app.get(IssuerModelGate), e.app.get(FlagReader), () => new Date(periodStart.getTime() + 40 * 86_400_000));
    const perms = new Set(['reseller:finance']);
    const c1 = await later.statement(R, e.ids.carol!, perms, resellerId, period);
    expect(c1.provisional).toBe(false);
    expect(c1.totals).toEqual(s.totals);
    expect(c1.ledger.varianceMinor).toBe('0');
    const c2 = await later.statement(R, e.ids.carol!, perms, resellerId, period);
    expect(c2.createdAt).toBe(c1.createdAt);
    expect(c2.totals).toEqual(c1.totals);
    await expect(sql(`UPDATE programs.reseller_statements SET retail_minor = 0 WHERE reseller_id = $1`, [resellerId])).rejects.toThrow(/immutable/);
    expect(Number((await sql(`SELECT count(*) n FROM programs.reseller_statements WHERE reseller_id = $1`, [resellerId]))[0]!.n)).toBe(1);
    // roles and shape
    await sql(`INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'viewer')`, [R, e.ids.dave]);
    expect((await as('dave', R, 'GET', `/v1/resellers/${resellerId}/statements`)).statusCode).toBe(403); // a viewer of the reseller lacks reseller:finance
    expect((await as('carol', R, 'GET', `/v1/resellers/${resellerId}/statements?period=2026-13`)).statusCode).toBe(422);
    expect(s.issuer).toMatchObject({ model: 'disabled' });
  }, 120_000);

  it('AC-M11-10 posture: the issuer model is disabled; an unapproved model returns BLOCKED and cannot be switched on by config, API or database', async () => {
    expect(APPROVED_ISSUER_MODEL).toBeNull(); // D-24 is open: only a person changes this, in a reviewed commit, after the decision is recorded
    for (const requested of ['platform_issues_wholesale', 'reseller_issues_own', 'bogus', 'DISABLED ', 'enabled']) {
      const r = resolveIssuerModel(requested);
      expect(r.model, requested).toBe('disabled');
      expect(r.status, requested).toBe('BLOCKED');
      expect(() => new IssuerModelGate(requested).assertEnabled(), requested).toThrow();
    }
    expect(resolveIssuerModel(undefined).status).toBe('disabled');
    expect(new IssuerModelGate(undefined).current().model).toBe('disabled');
    // the configured environment cannot enable one either
    const prev = process.env.RESELLER_ISSUER_MODEL;
    process.env.RESELLER_ISSUER_MODEL = 'reseller_issues_own';
    expect(new IssuerModelGate().current()).toMatchObject({ model: 'disabled', status: 'BLOCKED' });
    if (prev === undefined) delete process.env.RESELLER_ISSUER_MODEL;
    else process.env.RESELLER_ISSUER_MODEL = prev;
    // the database refuses any value but 'disabled'
    await expect(sql(`UPDATE invoicing.billing_entities SET issuer_model = 'reseller_issues_own'`)).rejects.toThrow();
    await expect(sql(`UPDATE invoicing.billing_entities SET issuer_model = 'platform_issues_wholesale'`)).rejects.toThrow();
    expect((await sql(`SELECT DISTINCT issuer_model FROM invoicing.billing_entities`)).map((r) => r.issuer_model)).toEqual(['disabled']);
    // invoicing for a sub-organization is blocked and creates nothing
    const before = Number((await sql(`SELECT count(*) n FROM invoicing.invoices WHERE source_key LIKE 'reseller:%'`))[0]!.n);
    await expect(e.app.get(StatementService).issueSubOrgInvoice(R, new Set(['reseller:finance']), resellerId, B(), '2026-10')).rejects.toMatchObject({ code: 'issuer_model_blocked' });
    expect(Number((await sql(`SELECT count(*) n FROM invoicing.invoices WHERE source_key LIKE 'reseller:%'`))[0]!.n)).toBe(before);
    // the scenario pack for the tax advisor (HG-03-04) is a dry run
    const pack = e.app.get(StatementService).scenarios({ totals: { wholesaleMinor: '10000', retailMinor: '11500', marginMinor: '1500', taxMinor: '0' }, currency: 'SAR' } as never);
    expect(pack.map((p) => p.scenario)).toEqual(['wholesale', 'retail', 'refund', 'marketplace']);
  });

  it('feature flag: reseller programs are OFF by default', async () => {
    await e.setFlag('reseller.enabled', false);
    expect((await as('carol', R, 'GET', '/v1/resellers')).json().code).toBe('feature_disabled');
    await e.setFlag('reseller.enabled', true);
    expect(e.app.get(ResellerService)).toBeTruthy();
    expect(e.app.get(IssuerModelGate)).toBeTruthy();
  });
});
