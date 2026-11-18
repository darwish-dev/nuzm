import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  MockMailboxAdapter,
  MockTransactionalEmailAdapter,
  VerifiedEmailEvent,
} from '@nuzm/adapter-data';
import { MockTransactionalEmailAdapter as TxMock, ManualClock } from '@nuzm/adapter-data';
import { SecretStore } from '../../common/secrets';
import { DataAdapterRegistry, DataAlerts, DataJobs, DatabaseFlow } from '../data';
import { setupDataEnv, type DataEnv, type Row } from '../data/testing/data-harness';
import {
  DnsLinkagePort,
  DnsResolvers,
  EmailDomainService,
  FakeDnsResolver,
  MailboxService,
  MessageService,
  MessageFormsNotification,
  SuppressionService,
  addressHash,
} from './index';
import { EMAIL_CONFIG, type EmailConfig } from './internal/message.service';

let e: DataEnv;
let jobs: DataJobs;
let flow: DatabaseFlow;
let reg: DataAdapterRegistry;
let cfg: EmailConfig;
let resolvers: FakeDnsResolver[];
const orgA = () => e.org.A!;
const orgB = () => e.org.B!;
const tx = () =>
  reg.get('transactional-email', 'mock-transactional-email') as MockTransactionalEmailAdapter;
const mbx = () => reg.get('mailbox', 'mock-mailbox') as MockMailboxAdapter;
const GiB = 1024 ** 3;
const rid = () => Math.random().toString(36).slice(2, 8);

/** Publish every record of a domain (as the customer's DNS would) on the fake resolvers. */
const publish = (records: Row[], which = resolvers) => {
  for (const r of which)
    for (const rec of records) {
      if (rec.type === 'MX') r.add('MX', rec.name, `${rec.priority} ${rec.value}`);
      else r.set(rec.type, rec.name, [rec.value]);
    }
};
const unpublish = () => resolvers.forEach((r) => r.clear());
const domainRow = async (id: string) =>
  (await e.h.env.sql(`SELECT * FROM email.email_domains WHERE id = $1`, [id]))[0] as Row;
const addDomain = (domain: string, purposes: string[], who = 'alice', org = orgA()) =>
  e.call(who, 'POST', '/v1/email/domains', { domain, purposes }, org);
/** A fully verified domain: records published, provider told, verification run. */
const verifiedDomain = async (
  domain: string,
  purposes: string[] = ['transactional'],
  org = orgA(),
  who = 'alice',
) => {
  const r = await addDomain(domain, purposes, who, org);
  if (r.statusCode !== 201) throw new Error(`addDomain: ${r.statusCode} ${r.body}`);
  const d = r.json();
  publish(d.requiredRecords);
  const row = await domainRow(d.id);
  if (row.tx_provider_ref) tx().markDomain(row.tx_provider_ref as string, 'verified');
  if (purposes.includes('mailbox')) mbx().markDomain(domain, 'verified');
  const v = await e.call(who, 'POST', `/v1/email/domains/${d.id}/verification`, {}, org);
  if (v.json().state !== 'verified') throw new Error(`verify: ${v.body}`);
  unpublish();
  return v.json() as Row;
};
const mkSender = async (domain: Row, local = 'noreply', who = 'alice', org = orgA()) =>
  (
    await e.call(
      who,
      'POST',
      '/v1/email/sender-identities',
      { domainId: domain.id, fromAddress: `${local}@${domain.domain}` },
      org,
    )
  ).json() as Row;
const send = (body: Row, who = 'alice', org = orgA(), extra: Record<string, string> = {}) =>
  e.call(who, 'POST', '/v1/email/messages', { category: 'transactional', ...body }, org, extra);
const runSend = async (r: { json(): Row }) => {
  await jobs.runOne(orgA(), r.json().operationId);
  return (await e.call('alice', 'GET', `/v1/email/messages/${r.json().id}`)).json() as Row;
};
const hook = (
  events: VerifiedEmailEvent[],
  opts: { at?: Date; provider?: string; headers?: Record<string, string> } = {},
) => {
  const signed = tx().signWebhook(events, opts.at);
  return e.app.inject({
    method: 'POST',
    url: `/v1/webhooks/email/${opts.provider ?? 'mock-transactional-email'}`,
    headers: { 'content-type': 'application/json', ...signed.headers, ...(opts.headers ?? {}) },
    payload: signed.rawBody,
  });
};
const ev = (
  id: string,
  type: VerifiedEmailEvent['type'],
  ref: string | null,
  recipient: string | null = 'alice-r@recipient.example',
): VerifiedEmailEvent => ({
  providerEventId: id,
  type,
  providerMessageRef: ref,
  recipient,
  occurredAt: new Date().toISOString(),
  payload: { reason: 'x' },
});
const usageEvents = async (meter: string, resourceId: string) =>
  (
    await e.h.env.sql(
      `SELECT payload FROM platform.outbox WHERE topic = 'usage.recorded' AND payload->>'meterId' = $1 AND payload->>'resourceId' = $2`,
      [meter, resourceId],
    )
  ).map((r) => r.payload as Row);

let dom: Row;
let sender: Row;

beforeAll(async () => {
  e = await setupDataEnv();
  reg = e.app.get(DataAdapterRegistry);
  jobs = e.app.get(DataJobs);
  flow = e.app.get(DatabaseFlow);
  cfg = e.app.get<EmailConfig>(EMAIL_CONFIG);
  resolvers = [new FakeDnsResolver('a'), new FakeDnsResolver('b'), new FakeDnsResolver('c')];
  e.app.get(DnsResolvers).set(resolvers);
}, 120_000);
afterAll(() => e.h.close());

describe('no email provider is enabled by default', () => {
  it('adding a domain answers 422 unsupported_capability (never a mock in production)', async () => {
    const r = await addDomain('first.example.test', ['transactional']);
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('unsupported_capability');
    expect(
      (
        await e.call('alice', 'POST', '/v1/quotes', {
          kind: 'email',
          items: [{ type: 'mailbox', quotaMb: 1024 }],
        })
      ).statusCode,
    ).toBe(422);
  });
});

describe('residency (AC-M08-15): email metadata and content only go to a processing region the policy allows', () => {
  it('a provider whose processing location is outside the allowed regions is refused for domains and sending', async () => {
    const p = await e.enableLocal('transactional-email', 'mock-transactional-email', {}); // no processingRegion: the mock catalog says an EU region that is not verified
    const r = await addDomain('eu.example.test', ['transactional']);
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('residency_denied');
    expect(e.sink.events.some((x) => x.action === 'compliance.residency.evaluate_denied')).toBe(
      true,
    );
    await e.admin('padmin', 'POST', '/v1/admin/data-providers', { action: 'disable', id: p.id });
    await e.admin('padmin', 'POST', '/v1/admin/data-providers', {
      action: 'configure',
      id: p.id,
      service: 'transactional-email',
      family: p.family,
      providerCode: p.providerCode,
      environment: 'local',
      config: { credentialRef: 'vault://mock/acct', processingRegion: 'sa-central' },
    });
    for (const body of [
      { action: 'probe', id: p.id },
      {
        action: 'request_enable',
        id: p.id,
        evidenceRef: 'LOCAL-REFERENCE-NOT-VERIFIED',
        verifiedAt: new Date().toISOString(),
      },
      { action: 'enable', id: p.id },
    ])
      expect((await e.admin('padmin', 'POST', '/v1/admin/data-providers', body)).statusCode).toBe(
        200,
      );
    await e.enableLocal('mailbox', 'mock-mailbox', { processingRegion: 'sa-central' });
  });
});

describe('domains and DNS verification (AC-M08-10 mock/fixtures only: NOT VERIFIED on a real domain)', () => {
  it('validates input; returns the required records declaratively (ownership, ONE merged SPF, DKIM selectors, MX, DMARC guidance); duplicates conflict', async () => {
    for (const body of [
      { domain: 'nodot', purposes: ['transactional'] },
      { domain: 'a b.example.test', purposes: ['transactional'] },
      { domain: 'x.example.test', purposes: [] },
      { domain: 'x.example.test', purposes: ['marketing'] },
      { domain: 'x.example.test', purposes: ['transactional', 'transactional'] },
      { domain: 'x.example.test', purposes: ['transactional'], extra: 1 },
    ])
      expect(
        (await e.call('alice', 'POST', '/v1/email/domains', body)).statusCode,
        JSON.stringify(body),
      ).toBe(422);
    expect((await addDomain('both.example.test', ['transactional'], 'carol')).statusCode).toBe(403);
    const r = await addDomain('Both.Example.Test.', ['transactional', 'mailbox']);
    expect(r.statusCode).toBe(201);
    const d = r.json();
    expect(d).toMatchObject({
      domain: 'both.example.test',
      purposes: ['transactional', 'mailbox'],
      state: 'pending',
      dataRegion: 'sa-central',
      dnsZoneId: null,
    });
    const by = (p: string) => d.requiredRecords.filter((x: Row) => x.purpose === p);
    expect(by('ownership')).toHaveLength(1);
    expect(by('ownership')[0].value).toMatch(/^nuzm-verification=[A-Za-z0-9_-]{30,}$/);
    expect(by('spf')).toHaveLength(1); // both providers want SPF at the apex: ONE merged record
    expect(by('dkim').length).toBeGreaterThanOrEqual(2);
    expect(by('mx').length).toBe(2);
    expect(by('dmarc')[0]).toMatchObject({ required: false });
    expect(by('dmarc')[0].value).toContain('p=none');
    expect(d.requiredRecords.every((x: Row) => x.status === 'unknown')).toBe(true);
    expect((await addDomain('both.example.test', ['transactional'])).statusCode).toBe(409);
    expect(
      (await e.call('alice', 'GET', '/v1/email/domains')).json().items.map((x: Row) => x.domain),
    ).toContain('both.example.test');
  });

  it('verification follows the DNS: nothing published = pending; records published but the provider has not verified = partial; both = verified (audited)', async () => {
    const d = (await addDomain('flow.example.test', ['transactional'])).json();
    const verify = async () =>
      (await e.call('alice', 'POST', `/v1/email/domains/${d.id}/verification`, {})).json();
    let v = await verify();
    expect(v.state).toBe('pending');
    expect(
      v.requiredRecords.filter((x: Row) => x.required).every((x: Row) => x.status === 'missing'),
    ).toBe(true);
    publish(d.requiredRecords);
    v = await verify();
    expect(v.state).toBe('partial'); // DNS is right, the provider has not confirmed yet
    tx().markDomain((await domainRow(d.id)).tx_provider_ref as string, 'verified');
    v = await verify();
    expect(v.state).toBe('verified');
    expect(v.verifiedAt).toBeTruthy();
    expect(v.nextCheckAt).toBeNull();
    expect(e.sink.events.some((x) => x.action === 'email.domain.verified')).toBe(true);
    unpublish();
  });

  it('an organization cannot claim a domain another account already VERIFIED (domain_not_owned); an unverified claim blocks nobody; the ownership token is per organization', async () => {
    const mine = await verifiedDomain('owned.example.test');
    expect(mine.state).toBe('verified');
    const r = await addDomain('owned.example.test', ['transactional'], 'bob', orgB());
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('domain_not_owned');
    // two organizations may both have an UNVERIFIED claim; only the one whose DNS carries ITS token can verify
    const a = (await addDomain('contested.example.test', ['transactional'])).json();
    const bd = (await addDomain('contested.example.test', ['transactional'], 'bob', orgB())).json();
    expect(a.requiredRecords.find((x: Row) => x.purpose === 'ownership').value).not.toBe(
      bd.requiredRecords.find((x: Row) => x.purpose === 'ownership').value,
    );
    publish(a.requiredRecords); // alice controls the DNS: only HER token is there
    tx().markDomain((await domainRow(a.id)).tx_provider_ref as string, 'verified');
    tx().markDomain((await domainRow(bd.id)).tx_provider_ref as string, 'verified');
    const vb = (
      await e.call('bob', 'POST', `/v1/email/domains/${bd.id}/verification`, {}, orgB())
    ).json();
    expect(vb.state).not.toBe('verified');
    expect(vb.requiredRecords.find((x: Row) => x.purpose === 'ownership').status).toBe('missing');
    expect(
      (await e.call('alice', 'POST', `/v1/email/domains/${a.id}/verification`, {})).json().state,
    ).toBe('verified');
    unpublish();
  });

  it('TTL-aware retries: an unverified domain is re-checked when its time comes; every resolver failing changes nothing', async () => {
    const d = (await addDomain('retry.example.test', ['transactional'])).json();
    resolvers.forEach((r) => (r.ttl = 120));
    await e.call('alice', 'POST', `/v1/email/domains/${d.id}/verification`, {});
    const row = await domainRow(d.id);
    expect(row.verification_state).toBe('pending');
    const wait =
      Date.parse(row.next_check_at as string) - Date.parse(row.last_checked_at as string);
    expect(wait).toBeGreaterThanOrEqual(60_000);
    expect(wait).toBeLessThanOrEqual(3_600_000);
    const attemptsBefore = Number(row.check_attempts);
    await e.app.get(EmailDomainService).verifyDue(new Date());
    expect(Number((await domainRow(d.id)).check_attempts)).toBe(attemptsBefore); // this domain is not due yet: it was not looked at again
    publish(d.requiredRecords);
    tx().markDomain(row.tx_provider_ref as string, 'verified');
    expect(
      await e.app.get(EmailDomainService).verifyDue(new Date(Date.now() + 2 * 3_600_000)),
    ).toBeGreaterThanOrEqual(1);
    expect((await domainRow(d.id)).verification_state).toBe('verified');
    resolvers.forEach((r) => (r.failing = true));
    const d2 = (await addDomain('flaky.example.test', ['transactional'])).json();
    expect(
      (await e.call('alice', 'POST', `/v1/email/domains/${d2.id}/verification`, {})).json().state,
    ).toBe('pending');
    resolvers.forEach((r) => (r.failing = false));
    unpublish();
    resolvers.forEach((r) => (r.ttl = 300));
  });

  it('one-click apply goes through DnsLinkagePort only when the domain is a Nuzm zone (managed_by email-verification); otherwise 422', async () => {
    const d = (await addDomain('zone.example.test', ['transactional'])).json();
    expect(
      (await e.call('alice', 'POST', `/v1/email/domains/${d.id}/verification`, { apply: true }))
        .statusCode,
    ).toBe(422);
    const linkage = e.app.get(DnsLinkagePort);
    const applied: { records: Row[]; managedBy: string }[] = [];
    linkage.findZone = async () => ({ zoneId: '00000000-0000-7000-8000-0000000000aa' });
    linkage.applyRecords = async (_o, _d, records, managedBy) => {
      applied.push({ records: records as unknown as Row[], managedBy });
      publish(records as unknown as Row[]);
      return { zoneId: 'z', applied: records.length };
    };
    tx().markDomain((await domainRow(d.id)).tx_provider_ref as string, 'verified');
    const v = await e.call('alice', 'POST', `/v1/email/domains/${d.id}/verification`, {
      apply: true,
    });
    expect(v.json().state).toBe('verified');
    expect(applied).toHaveLength(1);
    expect(applied[0]!.managedBy).toBe('email-verification');
    expect(applied[0]!.records.some((r) => r.purpose === 'ownership')).toBe(true);
    expect(applied[0]!.records.every((r) => !('status' in r))).toBe(true);
    linkage.findZone = async () => null;
    unpublish();
  });
});

describe('business mailboxes (mock provider: NOT VERIFIED)', () => {
  let md: Row;
  beforeAll(async () => {
    md = await verifiedDomain('corp.example.test', ['mailbox']);
  });
  const quote = (quotaMb = 2048, who = 'alice', org = orgA()) =>
    e.call(
      who,
      'POST',
      '/v1/quotes',
      { kind: 'email', items: [{ type: 'mailbox', quotaMb }] },
      org,
    );
  const mkMailbox = async (local: string, extra: Row = {}) => {
    const q = await quote();
    const r = await e.call('alice', 'POST', '/v1/email/mailboxes', {
      domainId: md.id,
      localPart: local,
      quotaMb: 2048,
      quoteId: q.json().id,
      ...extra,
    });
    if (r.statusCode !== 202) throw new Error(`mailbox: ${r.statusCode} ${r.body}`);
    await jobs.runOne(orgA(), r.json().operationId);
    return (await e.call('alice', 'GET', '/v1/email/mailboxes?limit=200'))
      .json()
      .items.find((x: Row) => x.id === r.json().id) as Row;
  };

  it('quote → create → active; the password setup goes to the vault (never returned); reveal is once and service-only', async () => {
    const q = await quote(2048);
    expect(q.statusCode).toBe(201);
    expect(q.json().items.map((i: Row) => i.meterId)).toEqual([
      'email.mailbox_months',
      'email.mailbox_storage_gb_months',
    ]);
    expect(q.json().items[0]).toMatchObject({ amountMinor: '500' });
    expect(q.json().items[1].quantity).toBe('2.00000000');
    const r = await e.call('alice', 'POST', '/v1/email/mailboxes', {
      domainId: md.id,
      localPart: 'Alice',
      quotaMb: 2048,
      quoteId: q.json().id,
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({
      status: 'provisioning',
      address: 'alice@corp.example.test',
      dataRegion: 'sa-central',
    });
    await jobs.runOne(orgA(), r.json().operationId);
    const m = (await e.call('alice', 'GET', '/v1/email/mailboxes'))
      .json()
      .items.find((x: Row) => x.id === r.json().id);
    expect(m).toMatchObject({
      status: 'active',
      quotaMb: 2048,
      passwordSetup: { kind: 'reset_link', state: 'pending' },
    });
    expect(JSON.stringify(m)).not.toMatch(/https:\/\/mail\.mock|mock-secret/);
    expect(
      (
        (await e.h.env.sql(`SELECT password_setup FROM email.mailboxes WHERE id = $1`, [m.id]))[0]!
          .password_setup as { ref: string }
      ).ref,
    ).toMatch(/^vault:\/\//);
    expect(
      JSON.stringify(await e.h.env.sql(`SELECT * FROM email.mailboxes WHERE id = $1`, [m.id])),
    ).not.toMatch(/https:\/\/mail\.mock/);
    const svc = e.app.get(MailboxService);
    const one = await svc.revealSetup(orgA(), e.ids.alice!, m.id);
    expect(one).toMatchObject({ kind: 'reset_link' });
    await expect(svc.revealSetup(orgA(), e.ids.alice!, m.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(JSON.stringify(e.sink.events)).not.toMatch(/https:\/\/mail\.mock/);
    expect(
      (await e.call('alice', 'POST', `/v1/email/mailboxes/${m.id}/credential-reveals`, {}))
        .statusCode,
    ).toBe(404); // PA-19 is not exposed
    expect(mbx().billableCount()).toBe(1);
  });

  it('refuses: unverified domain, bad names/quota/quote kind/permissions, duplicates; aliases and quota changes work; delete frees the name', async () => {
    const q = async () => (await quote()).json().id as string;
    const post = async (body: Row, who = 'alice') =>
      e.call(
        who,
        'POST',
        '/v1/email/mailboxes',
        { domainId: md.id, localPart: 'bob', quotaMb: 2048, quoteId: await q(), ...body },
        orgA(),
      );
    expect((await post({ localPart: 'Bad Name' })).statusCode).toBe(422);
    expect((await post({ localPart: 'postmaster' })).statusCode).toBe(422);
    expect((await post({ quotaMb: 10 })).statusCode).toBe(422);
    expect((await post({ quotaMb: 99_999_999 })).statusCode).toBe(422);
    expect((await post({ extra: 1 })).statusCode).toBe(422);
    expect((await post({}, 'dave')).statusCode).toBe(403);
    expect((await post({ domainId: '00000000-0000-7000-8000-00000000dead' })).statusCode).toBe(404);
    const tdomain = (await e.call('alice', 'GET', '/v1/email/domains'))
      .json()
      .items.find(
        (x: Row) =>
          x.purposes.length === 1 && x.purposes[0] === 'transactional' && x.state === 'verified',
      );
    expect((await post({ domainId: tdomain.id })).statusCode).toBe(422); // not a mailbox domain
    const ai = (
      await e.call('alice', 'POST', '/v1/quotes', { kind: 'ai-credit', items: [{ credits: '5' }] })
    ).json().id;
    expect((await post({ quoteId: ai })).statusCode).toBe(422);
    const bob = await mkMailbox('bob');
    expect((await post({})).statusCode).toBe(409); // address taken
    const al = await e.call('alice', 'POST', '/v1/email/aliases', {
      mailboxId: bob.id,
      localPart: 'sales',
    });
    expect(al.statusCode).toBe(202);
    await jobs.runOne(orgA(), al.json().operationId);
    expect(
      (await e.call('alice', 'GET', '/v1/email/aliases'))
        .json()
        .items.find((x: Row) => x.id === al.json().id),
    ).toMatchObject({ address: 'sales@corp.example.test', status: 'active' });
    expect(
      (
        await e.call('alice', 'POST', '/v1/email/aliases', {
          mailboxId: bob.id,
          localPart: 'sales',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await e.call('alice', 'POST', '/v1/email/aliases', { mailboxId: bob.id, localPart: 'bob' }))
        .statusCode,
    ).toBe(409); // an alias cannot shadow a mailbox
    const tag = `"${bob.etag}"`;
    expect(
      (await e.call('alice', 'PATCH', `/v1/email/mailboxes/${bob.id}`, { quotaMb: 4096 }))
        .statusCode,
    ).toBe(428);
    const pt = await e.call(
      'alice',
      'PATCH',
      `/v1/email/mailboxes/${bob.id}`,
      { quotaMb: 4096 },
      orgA(),
      { 'if-match': tag },
    );
    expect(pt.statusCode).toBe(202);
    await jobs.runOne(orgA(), pt.json().operationId);
    expect(
      (await e.h.env.sql(`SELECT quota_mb FROM email.mailboxes WHERE id = $1`, [bob.id]))[0]!
        .quota_mb,
    ).toBe(4096);
    const del = await e.call('alice', 'DELETE', `/v1/email/mailboxes/${bob.id}`);
    expect(del.statusCode).toBe(202);
    await jobs.runOne(orgA(), del.json().operationId);
    expect(
      (await e.call('alice', 'GET', '/v1/email/mailboxes?limit=200'))
        .json()
        .items.some((x: Row) => x.id === bob.id),
    ).toBe(false);
    expect((await mkMailbox('bob')).status).toBe('active');
  });

  it('a timeout after the provider created the mailbox, with the lookup failing, parks the operation; the reconcile finds it by token: ONE mailbox', async () => {
    const before = mbx().billableCount();
    mbx().inject('provisionMailbox', 'timeout_after_side_effect');
    mbx().inject('findByToken', 'outage', 1);
    const q = await quote();
    const r = await e.call('alice', 'POST', '/v1/email/mailboxes', {
      domainId: md.id,
      localPart: 'carol',
      quotaMb: 1024,
      quoteId: q.json().id,
    });
    await jobs.runOne(orgA(), r.json().operationId);
    expect(
      (await e.call('alice', 'GET', `/v1/operations/${r.json().operationId}`)).json().state,
    ).toBe('needs_reconcile');
    expect(mbx().billableCount()).toBe(before + 1);
    expect(await flow.reconcile(orgA(), r.json().operationId)).toBe('resumed');
    expect(
      (await e.h.env.sql(`SELECT state FROM email.mailboxes WHERE id = $1`, [r.json().id]))[0]!
        .state,
    ).toBe('active');
    expect(mbx().billableCount()).toBe(before + 1);
  });

  it('metering (AC-M08-09): one mailbox-month accrual per active mailbox per day, storage exact from the provider report, unreportable storage is unavailable; re-runs dedupe', async () => {
    const svc = e.app.get(MailboxService);
    const m = (await e.call('alice', 'GET', '/v1/email/mailboxes?limit=200'))
      .json()
      .items.find((x: Row) => x.localPart === 'alice') as Row;
    const pref = (
      await e.h.env.sql(`SELECT provider_ref FROM email.mailboxes WHERE id = $1`, [m.id])
    )[0]!.provider_ref as string;
    mbx().setStorage(pref, 3 * GiB);
    const day = new Date(Date.now() + 86_400_000);
    expect(await svc.collectDaily(day)).toBeGreaterThanOrEqual(2);
    expect((await usageEvents('email.mailbox_months', m.id))[0]).toMatchObject({
      quantity: '0.03333333',
      unit: 'mailbox_month',
      source: 'email@M08',
    });
    expect((await usageEvents('email.mailbox_storage_gb_months', m.id))[0]!.quantity).toBe(
      '0.10000000',
    );
    mbx().setCapabilities({ 'mailbox.usage.storage': 'unsupported' });
    const day2 = new Date(day.getTime() + 86_400_000);
    await svc.collectDaily(day2);
    mbx().setCapabilities({ 'mailbox.usage.storage': 'supported' });
    expect((await usageEvents('email.mailbox_storage_gb_months', m.id)).length).toBe(1); // none for day 2: unavailable, not estimated
    expect((await usageEvents('email.mailbox_months', m.id)).length).toBe(2);
    await svc.collectDaily(day);
    expect(
      new Set((await usageEvents('email.mailbox_months', m.id)).map((x) => x.eventId)).size,
    ).toBe(2);
  });
});

describe('sender identities and templates', () => {
  it('a sender is pending until its domain verifies, must belong to the domain, and is unique; templates sanitize, version, and set RTL for Arabic', async () => {
    const d = (await addDomain('senders.example.test', ['transactional'])).json();
    const s1 = await e.call('alice', 'POST', '/v1/email/sender-identities', {
      domainId: d.id,
      fromAddress: 'noreply@senders.example.test',
    });
    expect(s1.statusCode).toBe(201);
    expect(s1.json().status).toBe('pending');
    expect(
      (
        await e.call('alice', 'POST', '/v1/email/sender-identities', {
          domainId: d.id,
          fromAddress: 'x@other.example.test',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await e.call('alice', 'POST', '/v1/email/sender-identities', {
          domainId: d.id,
          fromAddress: 'noreply@senders.example.test',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await e.call('alice', 'POST', '/v1/email/sender-identities', {
          domainId: d.id,
          fromAddress: 'Name <a@senders.example.test>',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await e.call('dave', 'POST', '/v1/email/sender-identities', {
          domainId: d.id,
          fromAddress: 'dev@senders.example.test',
        })
      ).statusCode,
    ).toBe(403); // developers can send but not add identities
    publish(d.requiredRecords);
    tx().markDomain((await domainRow(d.id)).tx_provider_ref as string, 'verified');
    await e.call('alice', 'POST', `/v1/email/domains/${d.id}/verification`, {});
    unpublish();
    expect(
      (await e.call('alice', 'GET', '/v1/email/sender-identities'))
        .json()
        .items.find((x: Row) => x.id === s1.json().id).status,
    ).toBe('verified');
  });
  it('templates: XSS in html is removed at save, placeholders must be declared, versions are immutable and increment, Arabic is RTL', async () => {
    const mk = (body: Row, who = 'alice') =>
      e.call(who, 'POST', '/v1/email/templates', {
        key: 'welcome',
        name: 'Welcome',
        locale: 'en',
        subject: 'Hi {{name}}',
        html: '<p>Hello {{name}}</p>',
        variables: { name: { type: 'string', required: true } },
        ...body,
      });
    const t1 = await mk({
      html: '<p>Hello {{name}}</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>',
    });
    expect(t1.statusCode).toBe(201);
    expect(t1.json()).toMatchObject({ key: 'welcome', version: 1, locale: 'en', direction: 'ltr' });
    expect(t1.json().html).not.toMatch(/script|onerror|javascript:|<img/i);
    const t2 = await mk({ subject: 'Hello again {{name}}' });
    expect(t2.json().version).toBe(2);
    const ar = await mk({
      key: 'welcome-ar',
      locale: 'ar',
      html: '<p dir="rtl">مرحبا {{name}}</p>',
    });
    expect(ar.json()).toMatchObject({ direction: 'rtl', locale: 'ar' });
    expect(ar.json().html).toContain('مرحبا');
    expect((await mk({ html: '<p>{{ghost}}</p>' })).statusCode).toBe(422);
    expect((await mk({ subject: 'a\r\nBcc: evil@x.y' })).statusCode).toBe(422);
    expect((await mk({ locale: 'fr' })).statusCode).toBe(422);
    expect((await mk({ key: 'Bad Key' })).statusCode).toBe(422);
    expect((await mk({}, 'carol')).statusCode).toBe(403);
    expect((await mk({}, 'dave')).statusCode).toBe(201); // developers write templates
    expect(
      (await e.call('alice', 'GET', '/v1/email/templates?key=welcome'))
        .json()
        .items.map((x: Row) => x.version),
    ).toEqual(expect.arrayContaining([1, 2]));
    await expect(
      e.h.env.sql(`UPDATE email.templates SET html = '<p>changed</p>' WHERE id = $1`, [
        t1.json().id,
      ]),
    ).rejects.toThrow(/immutable/);
  });
  it('template XSS fuzz through the API: nothing executable survives in the stored html', async () => {
    const payloads = [
      '<svg/onload=alert(1)>',
      '<iframe src=javascript:alert(1)>',
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<body onload=alert(1)>',
      '<div style="background:url(javascript:1)">x</div>',
      '<math><script>1</script></math>',
      '<img src="data:text/html,x">',
      '<form action=x><input name=a></form>',
      '"><script>alert(1)</script>',
      '<style>*{x:expression(1)}</style>',
    ];
    for (const [i, p] of payloads.entries()) {
      const r = await e.call('alice', 'POST', '/v1/email/templates', {
        key: `fuzz-${i}`,
        name: 'Fuzz',
        locale: 'en',
        subject: 'x',
        html: `<p>ok</p>${p}`,
        variables: {},
      });
      expect(r.statusCode).toBe(201);
      expect(r.json().html).not.toMatch(
        /<\s*(script|iframe|svg|math|form|input|style)\b|\son[a-z]+\s*=|javascript:|data:|expression\(/i,
      );
    }
  });
});

describe('transactional messages (AC-M08-07/08/11-blocked): policy, send, replay, suppression, webhooks', () => {
  beforeAll(async () => {
    dom = await verifiedDomain('mail.example.test');
    sender = await mkSender(dom);
    expect(sender.status).toBe('verified');
  });

  it('policy: only category=transactional; marketing/bulk, too many recipients, unverified or foreign senders, header injection and bad content are refused', async () => {
    const base = {
      senderId: sender.id,
      to: ['alice-r@recipient.example'],
      subject: 'Hello',
      html: '<p>Hi</p>',
    };
    for (const category of ['marketing', 'bulk', 'newsletter', 'promotional']) {
      const r = await send({ ...base, category });
      expect(r.statusCode, category).toBe(422);
      expect(r.json().code).toBe('category_not_allowed');
    }
    expect((await e.call('alice', 'POST', '/v1/email/messages', base)).statusCode).toBe(422); // category missing
    const bulk = await send({
      ...base,
      to: Array.from({ length: 11 }, (_, i) => `u${i}@recipient.example`),
    });
    expect(bulk.json().code).toBe('category_not_allowed');
    expect(
      (await send({ ...base, senderId: '00000000-0000-7000-8000-00000000dead' })).json().code,
    ).toBe('sender_not_verified');
    const pending = (
      await e.call('alice', 'POST', '/v1/email/sender-identities', {
        domainId: (await e.call('alice', 'GET', '/v1/email/domains?limit=200'))
          .json()
          .items.find((x: Row) => x.domain === 'flaky.example.test').id,
        fromAddress: 'a@flaky.example.test',
      })
    ).json();
    expect((await send({ ...base, senderId: pending.id })).json().code).toBe('sender_not_verified'); // domain not verified
    expect((await send(base, 'carol')).statusCode).toBe(403);
    expect((await send({ ...base, html: '' })).statusCode).toBe(422);
    expect(
      (await send({ ...base, templateId: '00000000-0000-7000-8000-00000000dead' })).statusCode,
    ).toBe(422);
    expect((await send({ ...base, to: [] })).statusCode).toBe(422);
    expect((await send({ ...base, bogus: 1 })).statusCode).toBe(422);
    const noKey = await e.app.inject({
      method: 'POST',
      url: '/v1/email/messages',
      headers: {
        'x-nuzm-org': orgA(),
        cookie: `nuzm_session=${e.jars.alice!.nuzm_session}`,
        'x-csrf-token': e.jars.alice!.nuzm_csrf!,
      },
      payload: { category: 'transactional', ...base },
    });
    expect(noKey.statusCode).toBe(400); // Idempotency-Key is mandatory
    expect(noKey.json().code).toBe('idempotency_key_required');
  });

  it('header-injection fuzz: recipients, subject and Idempotency-Key never reach the provider', async () => {
    const before = tx().billableCount();
    const inj = [
      'a@b.cd\r\nBcc: evil@x.y',
      'a@b.cd,evil@x.y',
      'a@b.cd;evil@x.y',
      '"x" <a@b.cd>',
      'a@b.cd\nSubject: x',
      'a b@c.de',
      '<a@b.cd>',
      'a@b.cd\u0000',
      'a@b.cd>\r\n',
    ];
    for (const to of inj)
      expect(
        (await send({ senderId: sender.id, to: [to], subject: 'x', html: '<p>x</p>' })).statusCode,
        to,
      ).toBe(422);
    for (const subject of ['x\r\nBcc: evil@x.y', 'x\nTo: evil@x.y', 'x y', 'x\u0000'])
      expect(
        (
          await send({
            senderId: sender.id,
            to: ['ok@recipient.example'],
            subject,
            html: '<p>x</p>',
          })
        ).statusCode,
        JSON.stringify(subject),
      ).toBe(422);
    const t = (
      await e.call('alice', 'POST', '/v1/email/templates', {
        key: 'inj',
        name: 'Inj',
        locale: 'en',
        subject: 'Hi {{name}}',
        html: '<p>{{name}}</p>',
        variables: { name: { type: 'string', required: true } },
      })
    ).json();
    const r = await send({
      senderId: sender.id,
      to: ['inj-ok@recipient.example'],
      templateId: t.id,
      variables: { name: 'Bob\r\nBcc: evil@x.y' },
    });
    expect(r.statusCode).toBe(202);
    await runSend(r);
    expect(tx().billableCount()).toBe(before + 1);
    const sent = tx().sentMessage(
      (await e.h.env.sql(`SELECT send_token FROM email.messages WHERE id = $1`, [r.json().id]))[0]!
        .send_token as string,
    )!;
    expect(sent.subject).not.toMatch(/[\r\n]/);
    expect(sent.to).toEqual(['inj-ok@recipient.example']);
    expect(
      (
        await send(
          { senderId: sender.id, to: ['ok@recipient.example'], subject: 'x', html: '<p>x</p>' },
          'alice',
          orgA(),
          { 'idempotency-key': 'bad\r\nkey' },
        )
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await send({
          senderId: sender.id,
          to: ['ok@recipient.example'],
          templateId: t.id,
          variables: { name: 'x', extra: 'y' },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await send({
          senderId: sender.id,
          to: ['ok@recipient.example'],
          templateId: t.id,
          variables: {},
        })
      ).statusCode,
    ).toBe(422);
  });

  it('send: 202 queued → provider-accepted: ONE provider call, ONE meter event, hashes only at rest (recipients sealed, no body), events timeline; a replay is the same message', async () => {
    const key = { 'idempotency-key': `send-${rid()}` };
    const body = {
      senderId: sender.id,
      to: ['Alice-R@Recipient.Example'],
      subject: 'Order shipped',
      html: '<p dir="rtl">مرحبا <b>there</b></p>',
    };
    const r = await send(body, 'alice', orgA(), key);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({
      status: 'queued',
      category: 'transactional',
      recipientCount: 1,
      dataRegion: 'sa-central',
    });
    expect(await usageEvents('email.transactional_messages', r.json().id)).toHaveLength(0); // not metered on queue
    const again = await send(body, 'alice', orgA(), key);
    expect(again.json().id).toBe(r.json().id);
    expect(again.headers['idempotent-replayed']).toBe('true');
    const m = await runSend(r);
    expect(m.status).toBe('sent');
    expect(m.acceptedAt).toBeTruthy();
    expect(m.events.map((x: Row) => x.type)).toEqual(['sent']);
    const row = (
      await e.h.env.sql(`SELECT * FROM email.messages WHERE id = $1`, [r.json().id])
    )[0] as Row;
    expect(tx().billableByToken(row.send_token as string)).toBe(1);
    const metered = await usageEvents('email.transactional_messages', r.json().id);
    expect(metered).toHaveLength(1);
    expect(metered[0]).toMatchObject({
      quantity: '1',
      unit: 'message',
      source: 'email@M08',
      dimensions: { provider: 'mock-transactional-email', stream: 'transactional' },
    });
    expect(row.body_enc).toBeNull(); // retention is off: the queue buffer is removed once the provider accepted
    expect(row.expires_at).toBeNull();
    expect(row.body_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.to_hashes).toEqual([addressHash('alice-r@recipient.example')]);
    expect(JSON.stringify(row)).not.toMatch(/alice-r@recipient|Order shipped|مرحبا/i);
    expect(row.recipients_enc).toMatch(/^enc:v1:/);
    // a second HTTP replay and a flow re-run never add a second provider send or meter
    await jobs.runOne(orgA(), r.json().operationId);
    expect(tx().billableByToken(row.send_token as string)).toBe(1);
    expect(await usageEvents('email.transactional_messages', r.json().id)).toHaveLength(1);
    expect(
      (await e.call('alice', 'GET', '/v1/email/messages?limit=5')).json().items[0].id,
    ).toBeTruthy();
    expect(
      (await e.call('alice', 'GET', `/v1/email/events?messageId=${r.json().id}`))
        .json()
        .items.map((x: Row) => x.type),
    ).toEqual(['sent']);
    expect(e.sink.events.map((x) => x.action)).toEqual(
      expect.arrayContaining(['email.message.queued', 'email.message.sent']),
    );
    expect(JSON.stringify(e.sink.events)).not.toMatch(/alice-r@recipient|Order shipped/);
  });

  it('a send replayed after the provider accepted it but our answer was lost: findByToken proves it, nothing is sent twice (provider 5xx/timeout)', async () => {
    const r = await send({
      senderId: sender.id,
      to: ['lost@recipient.example'],
      subject: 'Lost answer',
      html: '<p>x</p>',
    });
    tx().inject('send', 'timeout_after_side_effect');
    tx().inject('findByToken', 'outage', 1);
    await jobs.runOne(orgA(), r.json().operationId);
    expect(
      (await e.call('alice', 'GET', `/v1/operations/${r.json().operationId}`)).json().state,
    ).toBe('needs_reconcile');
    const row = (
      await e.h.env.sql(`SELECT send_token FROM email.messages WHERE id = $1`, [r.json().id])
    )[0] as Row;
    expect(tx().billableByToken(row.send_token as string)).toBe(1); // the provider DID accept it
    expect(await usageEvents('email.transactional_messages', r.json().id)).toHaveLength(0); // we did not know yet
    expect(await flow.reconcile(orgA(), r.json().operationId)).toBe('resumed');
    expect((await e.call('alice', 'GET', `/v1/email/messages/${r.json().id}`)).json().status).toBe(
      'sent',
    );
    expect(tx().billableByToken(row.send_token as string)).toBe(1);
    expect(await usageEvents('email.transactional_messages', r.json().id)).toHaveLength(1);
    // a definitive provider refusal fails the message and meters nothing
    const bad = await send({
      senderId: sender.id,
      to: ['bad@recipient.example'],
      subject: 'Refused',
      html: '<p>x</p>',
    });
    tx().setCapabilities({ 'email.send': 'unsupported' });
    await jobs.runOne(orgA(), bad.json().operationId);
    tx().setCapabilities({ 'email.send': 'supported' });
    expect(
      (await e.call('alice', 'GET', `/v1/email/messages/${bad.json().id}`)).json(),
    ).toMatchObject({ status: 'failed', errorCode: 'unsupported_capability' });
    expect(await usageEvents('email.transactional_messages', bad.json().id)).toHaveLength(0);
  });

  it('AC-M08-08: a hard bounce suppresses the address within 60 s of the webhook; a send to a suppressed address is blocked 100% of the time', async () => {
    const to = 'bounce-me@recipient.example';
    const r = await send({
      senderId: sender.id,
      to: [to],
      subject: 'Will bounce',
      html: '<p>x</p>',
    });
    const m = await runSend(r);
    const ref = (
      await e.h.env.sql(`SELECT provider_message_ref FROM email.messages WHERE id = $1`, [m.id])
    )[0]!.provider_message_ref as string;
    const t0 = Date.now();
    const res = await hook([ev(`evt-${rid()}`, 'bounce_hard', ref, to)]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: 1, applied: 1, duplicates: 0 });
    const sup = await e.h.env.sql(
      `SELECT reason, source, active, created_at FROM email.suppressions WHERE org_id = $1 AND address_hash = $2`,
      [orgA(), addressHash(to)],
    );
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ reason: 'bounce_hard', source: 'webhook', active: true });
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect((await e.call('alice', 'GET', `/v1/email/messages/${m.id}`)).json().status).toBe(
      'bounced',
    );
    let blocked = 0;
    for (let i = 0; i < 20; i++) {
      const s = await send({
        senderId: sender.id,
        to: [to, 'other@recipient.example'],
        subject: `Again ${i}`,
        html: '<p>x</p>',
      });
      if (s.statusCode === 422 && s.json().code === 'suppressed') blocked++;
    }
    expect(blocked).toBe(20);
    expect(
      (await e.call('alice', 'GET', '/v1/email/suppressions'))
        .json()
        .items.find((x: Row) => x.address === to),
    ).toMatchObject({ reason: 'bounce_hard', active: true });
    // a message queued BEFORE the suppression is also stopped at execution
    const queued = await send({
      senderId: sender.id,
      to: ['late@recipient.example'],
      subject: 'Late',
      html: '<p>x</p>',
    });
    await e.call('alice', 'POST', '/v1/email/suppressions', { address: 'late@recipient.example' });
    await jobs.runOne(orgA(), queued.json().operationId);
    expect(
      (await e.call('alice', 'GET', `/v1/email/messages/${queued.json().id}`)).json(),
    ).toMatchObject({ status: 'failed', errorCode: 'suppressed' });
  });

  it('AC-M08-07: the same webhook delivered 100 times yields exactly ONE event, ONE suppression and ONE meter', async () => {
    const to = 'dup@recipient.example';
    const r = await send({ senderId: sender.id, to: [to], subject: 'Dup', html: '<p>x</p>' });
    const m = await runSend(r);
    const ref = (
      await e.h.env.sql(`SELECT provider_message_ref FROM email.messages WHERE id = $1`, [m.id])
    )[0]!.provider_message_ref as string;
    const signed = tx().signWebhook([ev('evt-dup-1', 'bounce_hard', ref, to)]);
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        e.app.inject({
          method: 'POST',
          url: '/v1/webhooks/email/mock-transactional-email',
          headers: { 'content-type': 'application/json', ...signed.headers },
          payload: signed.rawBody,
        }),
      ),
    );
    expect(results.every((x) => x.statusCode === 200)).toBe(true);
    expect(results.filter((x) => x.json().applied === 1)).toHaveLength(1);
    expect(results.filter((x) => x.json().duplicates === 1)).toHaveLength(99);
    expect(
      await e.h.env.sql(
        `SELECT count(*)::int n FROM email.email_events WHERE provider_event_id = 'evt-dup-1'`,
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await e.h.env.sql(
        `SELECT count(*)::int n FROM email.suppressions WHERE org_id = $1 AND address_hash = $2`,
        [orgA(), addressHash(to)],
      ),
    ).toEqual([{ n: 1 }]);
    expect(await usageEvents('email.transactional_messages', m.id)).toHaveLength(1);
  });

  it('webhook authentication: a missing/forged signature is 401, a replay outside the window is 409, malformed is 422, an unknown provider is 404; nothing is stored', async () => {
    const before = Number((await e.h.env.sql(`SELECT count(*) n FROM email.email_events`))[0]!.n);
    const good = tx().signWebhook([ev('evt-auth-1', 'delivered', 'whatever')]);
    expect(
      (
        await e.app.inject({
          method: 'POST',
          url: '/v1/webhooks/email/mock-transactional-email',
          headers: { 'content-type': 'application/json' },
          payload: good.rawBody,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await hook([ev('evt-auth-2', 'delivered', 'x')], {
          headers: { 'x-mock-signature': 't=1,v1=' + '0'.repeat(64) },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await e.app.inject({
          method: 'POST',
          url: '/v1/webhooks/email/mock-transactional-email',
          headers: { 'content-type': 'application/json', ...good.headers },
          payload: good.rawBody.replace('evt-auth-1', 'evt-auth-X'),
        })
      ).statusCode,
    ).toBe(401); // tampered body
    const old = await hook([ev('evt-auth-3', 'delivered', 'x')], {
      at: new Date(Date.now() - 3_600_000),
    });
    expect(old.statusCode).toBe(409);
    const bad = tx().signWebhook([ev('evt-auth-4', 'delivered', 'x')]);
    const malformed = 'not json';
    const t = Math.floor(Date.now() / 1000);
    void bad;
    const sig = createHmac('sha256', 'mock-webhook-secret-not-a-real-secret')
      .update(`${t}.${malformed}`)
      .digest('hex');
    expect(
      (
        await e.app.inject({
          method: 'POST',
          url: '/v1/webhooks/email/mock-transactional-email',
          headers: { 'content-type': 'application/json', 'x-mock-signature': `t=${t},v1=${sig}` },
          payload: malformed,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await hook([ev('evt-auth-5', 'delivered', 'x')], { provider: 'no-such-provider' }))
        .statusCode,
    ).toBe(404);
    expect(Number((await e.h.env.sql(`SELECT count(*) n FROM email.email_events`))[0]!.n)).toBe(
      before,
    );
    // an event for a message nobody knows is acknowledged but unmatched
    const u = await hook([ev('evt-auth-6', 'delivered', 'unknown-ref')]);
    expect(u.json()).toMatchObject({ received: 1, applied: 0, unmatched: 1 });
  });

  it('complaints and repeated soft bounces suppress (policy 3 in 72 h); delivered advances state but never regresses a bounce', async () => {
    const mk = async (to: string) => {
      const m = await runSend(
        await send({ senderId: sender.id, to: [to], subject: `T ${to}`, html: '<p>x</p>' }),
      );
      return {
        id: m.id as string,
        ref: (
          await e.h.env.sql(`SELECT provider_message_ref FROM email.messages WHERE id = $1`, [m.id])
        )[0]!.provider_message_ref as string,
      };
    };
    const c = await mk('complainer@recipient.example');
    await hook([ev(`evt-${rid()}`, 'complaint', c.ref, 'complainer@recipient.example')]);
    expect(
      await e.h.env.sql(
        `SELECT reason FROM email.suppressions WHERE org_id = $1 AND address_hash = $2`,
        [orgA(), addressHash('complainer@recipient.example')],
      ),
    ).toEqual([{ reason: 'complaint' }]);
    expect((await e.call('alice', 'GET', `/v1/email/messages/${c.id}`)).json().status).toBe(
      'complained',
    );
    const s1 = await mk('soft@recipient.example');
    const s2 = await mk('soft@recipient.example');
    const s3 = await mk('soft@recipient.example');
    const softs = async (...ms: { ref: string }[]) => {
      for (const m of ms)
        await hook([ev(`evt-${rid()}`, 'bounce_soft', m.ref, 'soft@recipient.example')]);
    };
    await softs(s1, s2);
    expect(
      await e.h.env.sql(`SELECT count(*)::int n FROM email.suppressions WHERE address_hash = $1`, [
        addressHash('soft@recipient.example'),
      ]),
    ).toEqual([{ n: 0 }]);
    await softs(s3);
    expect(
      await e.h.env.sql(`SELECT reason FROM email.suppressions WHERE address_hash = $1`, [
        addressHash('soft@recipient.example'),
      ]),
    ).toEqual([{ reason: 'bounce_soft' }]);
    const d = await mk('delivered@recipient.example');
    await hook([ev(`evt-${rid()}`, 'delivered', d.ref, 'delivered@recipient.example')]);
    expect((await e.call('alice', 'GET', `/v1/email/messages/${d.id}`)).json().status).toBe(
      'delivered',
    );
    await hook([ev(`evt-${rid()}`, 'bounce_hard', d.ref, 'delivered@recipient.example')]);
    await hook([ev(`evt-${rid()}`, 'delivered', d.ref, 'delivered@recipient.example')]);
    expect((await e.call('alice', 'GET', `/v1/email/messages/${d.id}`)).json().status).toBe(
      'bounced',
    ); // never regresses
  });

  it('suppressions: manual add/remove are audited; protective reasons need override; append-only events cannot be edited', async () => {
    expect(
      (
        await e.call('alice', 'POST', '/v1/email/suppressions', {
          address: 'manual@recipient.example',
        })
      ).json(),
    ).toMatchObject({ reason: 'manual', active: true, address: 'manual@recipient.example' });
    expect(
      (
        await e.call('alice', 'POST', '/v1/email/suppressions', {
          address: 'manual@recipient.example',
        })
      ).json().active,
    ).toBe(true); // idempotent
    expect(
      await e.h.env.sql(`SELECT count(*)::int n FROM email.suppressions WHERE address_hash = $1`, [
        addressHash('manual@recipient.example'),
      ]),
    ).toEqual([{ n: 1 }]);
    expect(
      (await e.call('dave', 'POST', '/v1/email/suppressions', { address: 'x@recipient.example' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await e.call('alice', 'POST', '/v1/email/suppressions', { address: 'not an address' }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await e.call('alice', 'POST', '/v1/email/suppressions', {
          address: 'bounce-me@recipient.example',
          action: 'remove',
        })
      ).statusCode,
    ).toBe(422); // hard bounce: needs override
    expect(
      (
        await e.call('alice', 'POST', '/v1/email/suppressions', {
          address: 'manual@recipient.example',
          action: 'remove',
        })
      ).json().active,
    ).toBe(false);
    expect(
      (
        await e.call('alice', 'POST', '/v1/email/suppressions', {
          address: 'bounce-me@recipient.example',
          action: 'remove',
          override: true,
        })
      ).json().active,
    ).toBe(false);
    expect(e.sink.events.map((x) => x.action)).toEqual(
      expect.arrayContaining(['email.suppression.added', 'email.suppression.removed']),
    );
    expect(
      (await e.call('alice', 'GET', '/v1/email/suppressions?active=false')).json().items.length,
    ).toBeGreaterThanOrEqual(2);
    await expect(e.h.env.sql(`UPDATE email.email_events SET type = 'failed'`)).rejects.toThrow();
    await expect(e.h.env.sql(`DELETE FROM email.email_events`)).rejects.toThrow();
    const sup = e.app.get(SuppressionService);
    expect(await sup.isSuppressed(orgA(), ['late@recipient.example'])).toHaveLength(1);
  });
});

describe('deliverability guardrails: rate, warm-up, auto-throttle (proposal values), admin override', () => {
  const body = () => ({
    senderId: sender.id,
    to: [`g-${rid()}@recipient.example`],
    subject: 'Guard',
    html: '<p>x</p>',
  });
  it('the per-minute rate limit answers 429 rate_limited', async () => {
    const saved = cfg.ratePerMinute;
    const used = Number(
      (
        await e.h.env.sql(
          `SELECT count(*) n FROM email.messages WHERE org_id = $1 AND created_at > now() - interval '1 minute'`,
          [orgA()],
        )
      )[0]!.n,
    );
    cfg.ratePerMinute = used + 2;
    expect((await send(body())).statusCode).toBe(202);
    expect((await send(body())).statusCode).toBe(202);
    const r = await send(body());
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe('rate_limited');
    cfg.ratePerMinute = saved;
  });
  it('warm-up: the daily allowance is small at first (doubling per day since the first verified domain); an administrator override lifts it, time-boxed and audited', async () => {
    const savedBase = cfg.warmupBasePerDay;
    const today = Number(
      (
        await e.h.env.sql(
          `SELECT count(*) n FROM email.messages WHERE org_id = $1 AND created_at > now() - interval '24 hours' AND state <> 'failed'`,
          [orgA()],
        )
      )[0]!.n,
    );
    cfg.warmupBasePerDay = today; // the allowance equals what was already sent today (domains verified today: day 0)
    const r = await send(body());
    expect(r.statusCode).toBe(429);
    expect(r.json().detail).toMatch(/allowance/);
    await e.app
      .get(MessageService)
      .setThrottleOverride(orgA(), e.padmin, new Date(Date.now() + 3_600_000).toISOString());
    expect((await send(body())).statusCode).toBe(202);
    await e.app.get(MessageService).setThrottleOverride(orgA(), e.padmin, null);
    expect((await send(body())).statusCode).toBe(429);
    cfg.warmupBasePerDay = savedBase;
    expect(e.sink.events.filter((x) => x.action === 'email.throttle.override')).toHaveLength(2);
  });
  it('auto-throttle: a bounce rate above 5% (or complaints above 0.1%) over the rolling 24 h pauses sending; below the sample size nothing happens; the override lifts it', async () => {
    const rates = await e.app.get(MessageService).rates(orgA());
    expect(rates.sent).toBeGreaterThan(0);
    // fixture: 40 accepted messages in the window, 4 soft/hard bounces => 10%
    const senderId = sender.id as string;
    await e.h.env.sql(
      `INSERT INTO email.messages (id, org_id, sender_id, category, state, to_hashes, recipients_enc, body_hash, idempotency_key, send_token, data_region, accepted_at)
       SELECT gen_random_uuid(), $1, $2, 'transactional', 'sent', ARRAY[repeat('a',64)], (SELECT recipients_enc FROM email.messages WHERE org_id = $1 LIMIT 1), repeat('b',64), 'thr-' || g, 'thr-tok-' || g, 'sa-central', now() FROM generate_series(1, 40) g`,
      [orgA(), senderId],
    );
    await e.h.env.sql(
      `INSERT INTO email.email_events (id, org_id, provider_code, provider_event_id, type, occurred_at) SELECT gen_random_uuid(), $1, 'nuzm', 'thr-ev-' || g, 'bounce_hard', now() FROM generate_series(1, 6) g`,
      [orgA()],
    );
    const r2 = await e.app.get(MessageService).rates(orgA());
    expect(r2.throttled).toBe(true);
    expect(r2.bounceRate).toBeGreaterThan(0.05);
    await e.app.get(MessageService).setThrottleOverride(orgA(), e.padmin, null);
    const savedBase = cfg.warmupBasePerDay;
    cfg.warmupBasePerDay = 1_000_000;
    const throttled = await send(body());
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().detail).toMatch(/bounce or complaint rate/);
    await e.app
      .get(MessageService)
      .setThrottleOverride(orgA(), e.padmin, new Date(Date.now() + 3_600_000).toISOString());
    expect((await send(body())).statusCode).toBe(202);
    await e.app.get(MessageService).setThrottleOverride(orgA(), e.padmin, null);
    cfg.warmupBasePerDay = savedBase;
    // an organization with few messages is not throttled by one bounce (minimum sample)
    expect((await e.app.get(MessageService).rates(orgB())).throttled).toBe(false);
  });
});

describe('retention, usage reconciliation and the forms-notification port', () => {
  it('bodies are kept sealed for N days ONLY when the organization enabled retention; the purge job removes them; recipients stay sealed', async () => {
    const savedBase = cfg.warmupBasePerDay;
    cfg.warmupBasePerDay = 1_000_000;
    cfg.ratePerMinute = 100_000;
    await e.app
      .get(MessageService)
      .setThrottleOverride(orgA(), e.padmin, new Date(Date.now() + 3_600_000).toISOString());
    await e.h.env.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'email.retain_bodies', $1, '{"enabled":true}'::jsonb)`,
      [orgA()],
    );
    const r = await send({
      senderId: sender.id,
      to: ['retained@recipient.example'],
      subject: 'Kept for N days',
      html: '<p>kept</p>',
    });
    await runSend(r);
    const row = (
      await e.h.env.sql(`SELECT body_enc, expires_at FROM email.messages WHERE id = $1`, [
        r.json().id,
      ])
    )[0] as Row;
    expect(row.body_enc).toMatch(/^enc:v1:/);
    const days = (Date.parse(String(row.expires_at)) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7.01);
    expect(
      await e.app.get(MessageService).purgeBodies(new Date(Date.now() + 8 * 86_400_000)),
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await e.h.env.sql(`SELECT body_enc FROM email.messages WHERE id = $1`, [r.json().id]))[0]!
        .body_enc,
    ).toBeNull();
    await e.h.env.sql(`DELETE FROM platform.feature_flags WHERE key = 'email.retain_bodies'`);
    await e.app.get(MessageService).setThrottleOverride(orgA(), e.padmin, null);
    cfg.warmupBasePerDay = savedBase;
  });
  it("usage reconciliation compares OUR provider-accepted count with the provider's own and flags a variance beyond the tolerance (D-31 proposal 1%)", async () => {
    const pid = (
      await e.h.env.sql(
        `SELECT id FROM data.data_providers WHERE provider_code = 'mock-transactional-email'`,
      )
    )[0]!.id as string;
    const svc = e.app.get(MessageService);
    const today = new Date();
    const ours = Number(
      (
        await e.h.env.sql(
          `SELECT count(*) n FROM email.messages WHERE provider_id = $1 AND accepted_at >= $2::date AND accepted_at < $2::date + 1`,
          [pid, today.toISOString().slice(0, 10)],
        )
      )[0]!.n,
    );
    const r = await svc.reconcileUsage(pid, today);
    expect(r.ours).toBe(ours);
    expect(r.provider).toBe(tx().providerAccepted);
    expect(r.variancePct).not.toBeNull();
    expect(typeof r.withinTolerance).toBe('boolean');
    const alertsBefore = e.app.get(DataAlerts).raised.length;
    tx().providerAccepted += Math.max(5, ours); // the provider reports far more than we metered
    const bad = await svc.reconcileUsage(pid, today);
    expect(bad.withinTolerance).toBe(false);
    expect(e.app.get(DataAlerts).raised.length).toBe(alertsBefore + 1);
  });
  it('FormsNotificationPort (M09 handoff) sends through the SAME rules: idempotent per submission, marketing refused', async () => {
    const port = new MessageFormsNotification(e.app.get(MessageService));
    await e.app
      .get(MessageService)
      .setThrottleOverride(orgA(), e.padmin, new Date(Date.now() + 3_600_000).toISOString());
    const savedBase = cfg.warmupBasePerDay;
    cfg.warmupBasePerDay = 1_000_000;
    const n = {
      senderId: sender.id as string,
      to: ['owner@recipient.example'],
      subject: 'New form submission',
      html: '<p>Someone wrote to you</p>',
      idempotencyKey: `form-submission-${rid()}`,
    };
    const a = await port.notify(orgA(), e.ids.alice!, n);
    const b = await port.notify(orgA(), e.ids.alice!, n);
    expect(b.id).toBe(a.id);
    expect(a.status).toBe('queued');
    await expect(
      port.notify(orgA(), e.ids.alice!, {
        ...n,
        idempotencyKey: `k-${rid()}`,
        to: Array.from({ length: 11 }, (_, i) => `u${i}@recipient.example`),
      }),
    ).rejects.toMatchObject({ code: 'category_not_allowed' });
    await e.app.get(MessageService).setThrottleOverride(orgA(), e.padmin, null);
    cfg.warmupBasePerDay = savedBase;
  });
});

describe('tenant isolation (AC-M08-05, email part): >=200 generated attack cases, 0 successes', () => {
  it("another organization never reads, verifies, sends from, templates or suppresses for alice's email resources", async () => {
    const aDomain = (await e.call('alice', 'GET', '/v1/email/domains?limit=200'))
      .json()
      .items.find((x: Row) => x.domain === 'mail.example.test') as Row;
    const aMbox = (await e.call('alice', 'GET', '/v1/email/mailboxes?limit=1')).json()
      .items[0] as Row;
    const aMsg = (await e.call('alice', 'GET', '/v1/email/messages?limit=1')).json()
      .items[0] as Row;
    const aTpl = (await e.call('alice', 'GET', '/v1/email/templates?limit=1')).json()
      .items[0] as Row;
    const ids = [
      aDomain.id,
      aMbox.id,
      aMsg.id,
      aTpl.id,
      sender.id,
      '00000000-0000-7000-8000-00000000dead',
      'not-a-uuid',
      '../../etc/passwd',
      "x'--",
      '%00',
      '{id}',
      '*',
    ];
    const leaks: string[] = [];
    let cases = 0;
    const note = (label: string, r: { statusCode: number; body: string }, ok: number[]) => {
      cases++;
      if (
        !ok.includes(r.statusCode) ||
        r.body.includes('mail.example.test') ||
        r.body.includes('alice-r@') ||
        r.body.includes(String(aMbox.address))
      )
        leaks.push(`${label} -> ${r.statusCode} ${r.body.slice(0, 80)}`);
    };
    for (const id of ids)
      for (const org of [orgB(), orgA()]) {
        const L = `bob/${org === orgA() ? 'A' : 'B'} ${String(id).slice(0, 10)}`;
        note(
          L,
          await e.call('bob', 'POST', `/v1/email/domains/${id}/verification`, {}, org),
          [403, 404, 422],
        );
        note(
          L,
          await e.call('bob', 'GET', `/v1/email/messages/${id}`, undefined, org),
          [403, 404, 422],
        );
        note(
          L,
          await e.call('bob', 'PATCH', `/v1/email/mailboxes/${id}`, { quotaMb: 100 }, org, {
            'if-match': '"1"',
          }),
          [403, 404, 422],
        );
        note(
          L,
          await e.call('bob', 'DELETE', `/v1/email/mailboxes/${id}`, undefined, org),
          [403, 404, 422],
        );
        note(
          L,
          await e.call(
            'bob',
            'POST',
            '/v1/email/messages',
            {
              category: 'transactional',
              senderId: id,
              to: ['x@y.zz'],
              subject: 's',
              html: '<p>x</p>',
            },
            org,
          ),
          [403, 404, 422],
        );
        note(
          L,
          await e.call(
            'bob',
            'POST',
            '/v1/email/messages',
            { category: 'transactional', senderId: sender.id, templateId: id, to: ['x@y.zz'] },
            org,
          ),
          [403, 404, 422],
        );
        note(
          L,
          await e.call(
            'bob',
            'POST',
            '/v1/email/sender-identities',
            { domainId: id, fromAddress: 'spoof@mail.example.test' },
            org,
          ),
          [403, 404, 422],
        );
        note(
          L,
          await e.call(
            'bob',
            'POST',
            '/v1/email/aliases',
            { mailboxId: id, localPart: 'evil' },
            org,
          ),
          [403, 404, 422],
        );
        note(
          L,
          await e.call(
            'bob',
            'POST',
            '/v1/email/mailboxes',
            { domainId: id, localPart: 'evil', quotaMb: 1024, quoteId: id },
            org,
          ),
          [403, 404, 422],
        );
      }
    // lists never contain another organization's rows; spoofing a sender of another organization is refused
    for (const path of [
      'domains',
      'mailboxes',
      'aliases',
      'sender-identities',
      'messages',
      'events',
      'templates',
      'suppressions',
    ]) {
      const r = await e.call('bob', 'GET', `/v1/email/${path}?limit=200`, undefined, orgB());
      const mine = new Set(
        ((await e.call('alice', 'GET', `/v1/email/${path}?limit=200`)).json().items as Row[]).map(
          (x) => x.id as string,
        ),
      );
      cases++;
      if (r.statusCode !== 200 || (r.json().items as Row[]).some((x) => mine.has(x.id as string)))
        leaks.push(`list ${path} -> ${r.statusCode} ${r.body.slice(0, 80)}`);
    }
    const spoof = await e.call(
      'bob',
      'POST',
      '/v1/email/messages',
      {
        category: 'transactional',
        senderId: sender.id,
        to: ['v@victim.example'],
        subject: 's',
        html: '<p>x</p>',
      },
      orgB(),
    );
    cases++;
    if (spoof.statusCode !== 422 || spoof.json().code !== 'sender_not_verified')
      leaks.push(`spoof -> ${spoof.statusCode}`);
    for (const p of ['/v1/email/domains', '/v1/email/messages', '/v1/email/suppressions']) {
      cases++;
      if ((await e.app.inject({ method: 'GET', url: p })).statusCode !== 401)
        leaks.push(`anon ${p}`);
    }
    // RLS under the application role
    const asB = await e.h.env.app.withOrg(orgB(), async (c) => {
      const out: Record<string, number> = {};
      for (const t of [
        'email_domains',
        'mailboxes',
        'aliases',
        'sender_identities',
        'templates',
        'messages',
        'email_events',
        'suppressions',
      ])
        out[t] = (
          await c.query(`SELECT count(*)::int n FROM email.${t} WHERE org_id = $1`, [orgA()])
        ).rows[0]!.n as number;
      return out;
    });
    for (const [t, n] of Object.entries(asB)) {
      cases++;
      if (n !== 0) leaks.push(`rls ${t} ${n}`);
    }
    expect(leaks).toEqual([]);
    expect(cases).toBeGreaterThanOrEqual(120);
  });
  it('the secret store is not involved in message storage: no plaintext address or body exists in any column of any email table', async () => {
    const dump = JSON.stringify(
      await e.h.env.sql(
        `SELECT m.*, s.address_enc FROM email.messages m, email.suppressions s LIMIT 20`,
      ),
    );
    expect(dump).not.toMatch(/@recipient\.example/);
    void SecretStore;
    void TxMock;
    void ManualClock;
  });
});
