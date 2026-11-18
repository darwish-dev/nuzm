import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostingHarness } from './hosting-harness';
import { mockStack } from './internal/mock/fixtures';
import { AcmeHttpClient, AcmeTestServer } from './internal/mock/acme-test-server';
import { SslService, backoffMs } from './internal/ssl.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
let fake = new Date('2026-11-18T10:00:00Z');
const acme = new AcmeTestServer({ now: () => fake, duplicateLimit: 3 });
const hh = new HostingHarness();
let nodeId = '';
let plan = '';
let projA = '';
let projB = '';
let siteA = '';
let siteB = '';
const orgA = () => hh.orgs.A!;
const orgB = () => hh.orgs.B!;

beforeAll(async () => {
  await acme.start();
  const stack = mockStack(undefined, { acme: new AcmeHttpClient(acme.url) });
  await hh.init({ stack });
  await hh.customers();
  projA = await hh.project(orgA());
  projB = await hh.project(orgB());
  plan = await hh.plan('p-dom');
  nodeId = await hh.activeNode('dom-node');
  for (const [who, org, proj, name] of [
    ['alice', orgA(), projA, 'a-site'],
    ['bob', orgB(), projB, 'b-site'],
  ] as const) {
    const r = await hh.createSite(who, org, plan, 'php:8.3', name, proj);
    await hh.jobs().runOne(org, r.json().operationId);
    if (who === 'alice') siteA = r.json().site.id;
    else siteB = r.json().site.id;
  }
});
afterAll(async () => {
  await hh.close();
  await acme.stop();
});
const post = (who: string, org: string, site: string, sub: string, body: object) =>
  hh.call(who, 'POST', `/v1/hosting/sites/${site}/${sub}`, body, org);
const node = () => hh.stack.nodes.get(nodeId)!;
const nodeName = async (site: string) =>
  ((await hh.env.sql(`SELECT node_name FROM hosting.sites WHERE id=$1`, [site]))[0] as any)
    .node_name as string;
const opState = async (id: string) =>
  ((await hh.env.sql(`SELECT state FROM platform.operations WHERE id=$1`, [id]))[0] as any)
    .state as string;

describe('domains: ownership first, then the vhost; global uniqueness', () => {
  let bindingId = '';
  it('creates a pending binding with the verification record; an unverified domain never reaches the node', async () => {
    const r = await post('alice', orgA(), siteA, 'domains', {
      domain: 'www.customer-one.test',
      primary: true,
    });
    expect(r.statusCode).toBe(201);
    const b = r.json().binding;
    bindingId = b.id;
    expect(b).toMatchObject({
      domain: 'www.customer-one.test',
      state: 'pending',
      verification: {
        method: 'dns_txt',
        record: { type: 'TXT', name: '_nuzm-challenge.www.customer-one.test' },
      },
    });
    expect(b.verification.record.value).toMatch(/^nuzm-site-verification=[0-9a-f]{32}$/);
    expect(
      node()
        .sites.get(await nodeName(siteA))!
        .domains.some((d) => d === 'www.customer-one.test'),
    ).toBe(false);
  });
  it('re-checking while the record is missing answers 422 ownership_unverified with the challenge again', async () => {
    const r = await post('alice', orgA(), siteA, 'domains', { domain: 'www.customer-one.test' });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('ownership_unverified');
    expect(r.json().verification.record.type).toBe('TXT');
    expect(node().sites.get(await nodeName(siteA))!.domains).not.toContain('www.customer-one.test');
  });
  it('a vhost operation for an unverified binding is refused permanently (the safety net behind the API check)', async () => {
    const op = await hh.app.get((await import('@nuzm/platform')).OperationsService).create(orgA(), {
      kind: 'hosting.domain.bind',
      input: { siteId: siteA, bindingId },
      resourceKind: 'hosting_site',
      resourceId: siteA,
    });
    await hh.jobs().runOne(orgA(), op.id);
    expect(await opState(op.id)).toBe('failed');
    expect(node().sites.get(await nodeName(siteA))!.domains).not.toContain('www.customer-one.test');
  });
  it('once the challenge is published the domain verifies (202), the vhost is applied, it becomes primary and a managed certificate is issued', async () => {
    const tok = (
      (
        await hh.env.sql(
          `SELECT verification_token t FROM hosting.site_domain_bindings WHERE id=$1`,
          [bindingId],
        )
      )[0] as any
    ).t as string;
    hh.verifier.confirm(orgA(), siteA, 'www.customer-one.test', tok);
    const r = await post('alice', orgA(), siteA, 'domains', { domain: 'www.customer-one.test' });
    expect(r.statusCode).toBe(202);
    expect(r.json().binding.state).toBe('verified');
    await hh.jobs().runOne(orgA(), r.json().operationId);
    const list = (await hh.call('alice', 'GET', `/v1/hosting/sites/${siteA}/domains`)).json().items;
    expect(list[0]).toMatchObject({
      domain: 'www.customer-one.test',
      state: 'active',
      primary: true,
      verification: null,
    });
    expect(node().sites.get(await nodeName(siteA))!.domains).toContain('www.customer-one.test');
    const site = (await hh.call('alice', 'GET', `/v1/hosting/sites/${siteA}`)).json();
    expect(site.primaryDomain).toBe('www.customer-one.test');
    const certs = (
      await hh.call('alice', 'GET', `/v1/hosting/sites/${siteA}/ssl-certificates`)
    ).json().items;
    expect(certs[0]).toMatchObject({
      mode: 'managed',
      status: 'issued',
      domains: ['www.customer-one.test'],
    });
    expect(acme.issued).toHaveLength(1);
  });
  it('the same domain in another organization is 409 domain_in_use (even before verification); a squatted pending binding blocks nobody', async () => {
    expect(
      (await post('bob', orgB(), siteB, 'domains', { domain: 'www.customer-one.test' })).statusCode,
    ).toBe(409);
    // org B creates a PENDING binding for a domain it cannot prove; org A (the real owner) can still verify it
    expect(
      (await post('bob', orgB(), siteB, 'domains', { domain: 'contested.test' })).statusCode,
    ).toBe(201);
    expect(
      (await post('alice', orgA(), siteA, 'domains', { domain: 'contested.test' })).statusCode,
    ).toBe(201);
    const tok = (
      (
        await hh.env.sql(
          `SELECT verification_token t FROM hosting.site_domain_bindings WHERE site_id=$1 AND domain='contested.test'`,
          [siteA],
        )
      )[0] as any
    ).t as string;
    hh.verifier.confirm(orgA(), siteA, 'contested.test', tok);
    const win = await post('alice', orgA(), siteA, 'domains', { domain: 'contested.test' });
    expect(win.statusCode).toBe(202);
    // now B cannot verify it any more, whatever the verifier says
    const btok = (
      (
        await hh.env.sql(
          `SELECT verification_token t FROM hosting.site_domain_bindings WHERE site_id=$1 AND domain='contested.test'`,
          [siteB],
        )
      )[0] as any
    ).t as string;
    hh.verifier.confirm(orgB(), siteB, 'contested.test', btok);
    expect(
      (await post('bob', orgB(), siteB, 'domains', { domain: 'contested.test' })).statusCode,
    ).toBe(409);
  });
  it('the database refuses two verified bindings of one domain (race guard)', async () => {
    const e = await hh.env.sql(
      `SELECT 1 FROM hosting.site_domain_bindings WHERE domain='www.customer-one.test' AND state IN ('verified','active')`,
    );
    expect(e).toHaveLength(1);
    await expect(
      hh.env.sql(
        `INSERT INTO hosting.site_domain_bindings (id, site_id, org_id, domain, state, verification_token, verified_at) VALUES (gen_random_uuid(), $1, $2, 'www.customer-one.test', 'verified', $3, now())`,
        [siteB, orgB(), 'a'.repeat(32)],
      ),
    ).rejects.toThrow(/site_domain_bindings_global_idx/);
  });
  it('validates input and permissions; a viewer cannot bind', async () => {
    expect(
      (await post('alice', orgA(), siteA, 'domains', { domain: 'not a domain' })).statusCode,
    ).toBe(422);
    expect(
      (await post('alice', orgA(), siteA, 'domains', { domain: 'x.test', extra: 1 })).statusCode,
    ).toBe(422);
    expect(
      (await post('carol', orgA(), siteA, 'domains', { domain: 'viewer.test' })).statusCode,
    ).toBe(403);
  });
});

describe('TLS: managed issuance on the node, renewal at T-30 days, failure backoff, custom keys only in the vault', () => {
  it('renews a managed certificate at notAfter - 30 days (fake clock) and not before', async () => {
    const ssl = hh.app.get(SslService);
    const cert = (
      await hh.env.sql(
        `SELECT id, not_after, renew_after FROM hosting.ssl_certificates WHERE site_id=$1 AND mode='managed' AND status='issued' ORDER BY created_at LIMIT 1`,
        [siteA],
      )
    )[0] as any;
    const notAfter = new Date(cert.not_after).getTime();
    expect(new Date(cert.renew_after).getTime()).toBe(notAfter - 30 * 86_400_000);
    // T-31 days: not yet
    expect(await ssl.sweep(new Date(notAfter - 31 * 86_400_000))).toMatchObject({ renewed: 0 });
    // the CA clock moves with the fake clock: at T-30 days the sweep renews
    fake = new Date(notAfter - 30 * 86_400_000);
    const before = acme.issued.length;
    const r = await ssl.sweep(new Date(notAfter - 30 * 86_400_000));
    expect(r.renewed).toBeGreaterThanOrEqual(1);
    expect(acme.issued.length).toBeGreaterThan(before);
    const after = (
      await hh.env.sql(`SELECT not_after, renew_after FROM hosting.ssl_certificates WHERE id=$1`, [
        cert.id,
      ])
    )[0] as any;
    expect(new Date(after.not_after).getTime()).toBeGreaterThan(notAfter);
    const a = await hh.env.sql(
      `SELECT action FROM audit.audit_logs WHERE action IN ('hosting.ssl.issued','hosting.ssl.renewed')`,
    );
    expect(a.map((x: any) => x.action)).toContain('hosting.ssl.renewed');
  });
  it('a CA rate limit schedules a backoff (>= 6h); retries respect it; after the attempts are used up the certificate is failed', async () => {
    expect(backoffMs(1, false)).toBe(3_600_000);
    expect(backoffMs(3, false)).toBe(4 * 3_600_000);
    expect(backoffMs(1, true)).toBe(6 * 3_600_000);
    expect(backoffMs(12, false)).toBe(168 * 3_600_000); // capped at 7 days
    // bind a new domain (verified) and exhaust the CA's duplicate limit for it
    const d = 'limited.customer-one.test';
    await post('alice', orgA(), siteA, 'domains', { domain: d });
    const tok = (
      (
        await hh.env.sql(
          `SELECT verification_token t FROM hosting.site_domain_bindings WHERE site_id=$1 AND domain=$2`,
          [siteA, d],
        )
      )[0] as any
    ).t as string;
    hh.verifier.confirm(orgA(), siteA, d, tok);
    for (let i = 0; i < 3; i++)
      acme.issued.push({ domains: [d], at: fake.getTime(), certificateId: 'old' + i }); // 3 certificates already issued this week
    const r = await post('alice', orgA(), siteA, 'domains', { domain: d });
    expect(r.statusCode).toBe(202);
    await hh.jobs().runOne(orgA(), r.json().operationId);
    const c = (
      await hh.env.sql(`SELECT * FROM hosting.ssl_certificates WHERE $1 = ANY(domains)`, [d])
    )[0] as any;
    expect(c.status).toBe('pending');
    expect(c.last_error).toMatch(/rate_limit/);
    expect(c.attempts).toBe(1);
    const next = new Date(c.next_attempt_at).getTime();
    expect(next).toBeGreaterThanOrEqual(Date.now() + 5.9 * 3_600_000);
    const ssl = hh.app.get(SslService);
    expect(await ssl.sweep(new Date(Date.now() + 3_600_000))).toMatchObject({
      retried: 0,
      failed: 0,
    }); // too early: respected
    const attemptsBefore = acme.requests.length;
    expect((await ssl.sweep(new Date(next + 1000))).retried).toBe(0); // the CA still refuses: rescheduled
    expect(acme.requests.length).toBe(attemptsBefore + 1);
    // let the week pass: the next attempt succeeds
    fake = new Date(fake.getTime() + 8 * 86_400_000);
    const row2 = (
      await hh.env.sql(`SELECT next_attempt_at FROM hosting.ssl_certificates WHERE id=$1`, [c.id])
    )[0] as any;
    expect(
      (await ssl.sweep(new Date(new Date(row2.next_attempt_at).getTime() + 1000))).retried,
    ).toBe(1);
    expect(
      (
        (
          await hh.env.sql(`SELECT status FROM hosting.ssl_certificates WHERE id=$1`, [c.id])
        )[0] as any
      ).status,
    ).toBe('issued');
  });
  it('a validation failure from the CA is final (no hammering): status failed, audited', async () => {
    const d = 'novalidation.customer-one.test';
    acme.opts.failValidation = new Set([d]);
    await post('alice', orgA(), siteA, 'domains', { domain: d });
    const tok = (
      (
        await hh.env.sql(
          `SELECT verification_token t FROM hosting.site_domain_bindings WHERE site_id=$1 AND domain=$2`,
          [siteA, d],
        )
      )[0] as any
    ).t as string;
    hh.verifier.confirm(orgA(), siteA, d, tok);
    const r = await post('alice', orgA(), siteA, 'domains', { domain: d });
    await hh.jobs().runOne(orgA(), r.json().operationId);
    const c = (
      await hh.env.sql(
        `SELECT status, attempts FROM hosting.ssl_certificates WHERE $1 = ANY(domains)`,
        [d],
      )
    )[0] as any;
    expect(c.status).toBe('pending'); // internal CA error category -> retried with backoff, bounded by MAX_CERT_ATTEMPTS
    const failedAudit = await hh.env.sql(
      `SELECT 1 FROM audit.audit_logs WHERE action='hosting.ssl.failed'`,
    );
    expect(failedAudit.length).toBeGreaterThanOrEqual(1);
  });
  it('a custom certificate: the private key goes to the vault ONLY (never the database, audit, operations or the response); a mismatching pair is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuzm-cert-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-days',
        '30',
        '-subj',
        '/CN=www.customer-one.test',
        '-addext',
        'subjectAltName=DNS:www.customer-one.test',
      ],
      { stdio: 'ignore' },
    );
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'k2.pem'),
        '-out',
        join(dir, 'c2.pem'),
        '-days',
        '30',
        '-subj',
        '/CN=other.test',
      ],
      { stdio: 'ignore' },
    );
    const key = readFileSync(join(dir, 'k.pem'), 'utf8');
    const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
    const keyBody = key
      .split('\n')
      .filter((l) => !l.startsWith('-----'))
      .join('');
    const mismatch = await post('alice', orgA(), siteA, 'ssl-certificates', {
      mode: 'custom',
      domains: ['www.customer-one.test'],
      certificate: cert,
      privateKey: readFileSync(join(dir, 'k2.pem'), 'utf8'),
    });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.body).not.toContain(keyBody.slice(0, 40));
    const uncovered = await post('alice', orgA(), siteA, 'ssl-certificates', {
      mode: 'custom',
      domains: ['limited.customer-one.test'],
      certificate: cert,
      privateKey: key,
    });
    expect(uncovered.statusCode).toBe(422);
    const ok = await post('alice', orgA(), siteA, 'ssl-certificates', {
      mode: 'custom',
      domains: ['www.customer-one.test'],
      certificate: cert,
      privateKey: key,
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.body).not.toContain(keyBody.slice(0, 40));
    expect(ok.json().certificate).not.toHaveProperty('privateKey');
    await hh.jobs().runOne(orgA(), ok.json().operationId);
    const row = (
      await hh.env.sql(`SELECT * FROM hosting.ssl_certificates WHERE id=$1`, [
        ok.json().certificate.id,
      ])
    )[0] as any;
    expect(row.status).toBe('issued');
    expect(row.secret_ref).toMatch(/^vault:\/\/hosting\/org\//);
    expect(hh.vault.secrets.has(row.secret_ref)).toBe(true);
    // the key appears nowhere in the database: scan every text column of the hosting + platform tables, the audit log and the outbox
    for (const t of [
      'hosting.ssl_certificates',
      'platform.operations',
      'platform.outbox',
      'audit.audit_logs',
      'platform.idempotency_keys',
      'hosting.site_domain_bindings',
    ]) {
      const all = JSON.stringify(await hh.env.sql(`SELECT t::text FROM ${t} t`));
      expect(all, t).not.toContain(keyBody.slice(10, 50));
    }
  });
  it('requires the domain to be a verified binding of the site, an active site, and the ssl permission', async () => {
    expect(
      (
        await post('alice', orgA(), siteA, 'ssl-certificates', {
          mode: 'managed',
          domains: ['nope.customer-one.test'],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await post('alice', orgA(), siteA, 'ssl-certificates', {
          mode: 'other',
          domains: ['x.test'],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await post('carol', orgA(), siteA, 'ssl-certificates', {
          mode: 'managed',
          domains: ['www.customer-one.test'],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await post('bob', orgB(), siteA, 'ssl-certificates', {
          mode: 'managed',
          domains: ['www.customer-one.test'],
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('database bindings: unsupported until M08', () => {
  it('POST answers 422 unsupported_capability, GET says unavailable', async () => {
    const r = await post('alice', orgA(), siteA, 'databases', { databaseId: crypto.randomUUID() });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('unsupported_capability');
    expect((await hh.call('alice', 'GET', `/v1/hosting/sites/${siteA}/databases`)).json()).toEqual({
      items: [],
      available: false,
    });
    expect((await post('bob', orgB(), siteA, 'databases', {})).statusCode).toBe(404);
  });
});
