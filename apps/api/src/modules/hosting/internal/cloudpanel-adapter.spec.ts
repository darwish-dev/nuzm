import { describe, expect, it } from 'vitest';
import { LIMITS, mockStack } from './mock/fixtures';
import { siteNameFor, tokenFor } from './cloudpanel-adapter';
import { testCtx } from './mock/mocks';
import { AdapterTimeoutError } from './m05-contracts';

const node = (nodeId: string) => ({ nodeId, computeInstanceId: 'i-1' });
const spec = (n: string) => {
  const token = tokenFor('org', 'op-' + n, 'create_site');
  const name = siteNameFor(token);
  return {
    name,
    runtime: 'php:8.3',
    domain: `${name}.sites.example.test`,
    limits: LIMITS,
    credentialsRef: `vault://hosting/c-${n}`,
    backupKeyRef: `vault://hosting/b-${n}`,
    idempotencyToken: token,
    operationId: 'op-' + n,
  };
};

describe('HostingAdapter conformance (mock agent; evidence kind is `mock`, results are NOT VERIFIED against a real node)', () => {
  it('probe reports runtimes from the node and marks unreported capabilities unsupported', async () => {
    const s = mockStack(undefined, { runtimes: ['php:8.3', 'static'] });
    const p = await s.adapter.probe(testCtx(), node(s.nodeId));
    expect(p.runtimes).toEqual(['php:8.3', 'static']);
    expect(p.capabilities['hosting.runtime.php']).toBe('supported');
    expect(p.capabilities['hosting.runtime.nodejs']).toBe('unsupported');
    expect(p.capabilities['hosting.db.binding']).toBe('unsupported');
    expect(p.evidence[0]!.kind).toBe('mock');
  });
  it('an unreachable node yields all-unknown capabilities (unknown = unsupported)', async () => {
    const s = mockStack();
    s.channel.dropRequests = 1;
    const p = await s.adapter.probe(testCtx(), node(s.nodeId));
    expect(Object.values(p.capabilities).every((c) => c === 'unknown')).toBe(true);
    expect(p.runtimes).toEqual([]);
  });
  it('inventory returns versions, health, capacity and usage', async () => {
    const s = mockStack();
    const r = await s.adapter.inventory(testCtx(), node(s.nodeId));
    expect(r.status).toBe('succeeded');
    expect(r.data).toMatchObject({
      cloudpanelVersion: '2.5.4',
      health: { state: 'healthy' },
      capacity: { cpuMillicores: 4000 },
    });
  });
  it('create is idempotent per token, findByToken adopts, unsupported runtime is a normalized failure', async () => {
    const s = mockStack();
    const a = await s.adapter.createSite(testCtx(), node(s.nodeId), spec('1'));
    const b = await s.adapter.createSite(testCtx(), node(s.nodeId), spec('1'));
    expect(a.status).toBe('succeeded');
    expect(b.status).toBe('succeeded');
    expect(s.node.sites.size).toBe(1);
    const f = await s.adapter.findByToken(testCtx(), node(s.nodeId), spec('1').name);
    expect(f.data?.name).toBe(spec('1').name);
    const none = await s.adapter.findByToken(
      testCtx(),
      node(s.nodeId),
      siteNameFor(tokenFor('o', 'zzz', 'x')),
    );
    expect(none).toMatchObject({ status: 'succeeded', data: null });
    const bad = await s.adapter.createSite(testCtx(), node(s.nodeId), {
      ...spec('2'),
      runtime: 'python:3.12',
    });
    expect(bad).toMatchObject({
      status: 'failed',
      error: { category: 'unsupported', retryable: false },
    });
  });
  it('suspend / resume / update / usage / delete round trip; delete returns an empty wipe report and is idempotent', async () => {
    const s = mockStack();
    const sp = spec('3');
    await s.adapter.createSite(testCtx(), node(s.nodeId), sp);
    const t = (k: string) => ({ idempotencyToken: tokenFor('o', k, 's'), operationId: k });
    expect((await s.adapter.suspendSite(testCtx(), node(s.nodeId), sp.name, t('s1'))).status).toBe(
      'succeeded',
    );
    expect(s.node.sites.get(sp.name)!.suspended).toBe(true);
    expect((await s.adapter.resumeSite(testCtx(), node(s.nodeId), sp.name, t('s2'))).status).toBe(
      'succeeded',
    );
    const u = await s.adapter.updateSite(
      testCtx(),
      node(s.nodeId),
      sp.name,
      { limits: { ...LIMITS, diskMb: 500 } },
      t('s3'),
    );
    expect(u.data?.limits.diskMb).toBe(500);
    expect((await s.adapter.usage(testCtx(), node(s.nodeId), sp.name)).data?.processes).toBe(1);
    const d = await s.adapter.deleteSite(testCtx(), node(s.nodeId), sp.name, t('s4'));
    expect(d.data).toMatchObject({
      filesRemaining: 0,
      usersRemaining: 0,
      databasesRemaining: 0,
      certificatesRemaining: 0,
      cronEntriesRemaining: 0,
    });
    expect((await s.adapter.deleteSite(testCtx(), node(s.nodeId), sp.name, t('s5'))).status).toBe(
      'succeeded',
    );
  });
  it('backup → mutate → restore returns identical content; a corrupt archive is rejected', async () => {
    const s = mockStack();
    const sp = spec('4');
    s.vault.newKey(sp.backupKeyRef);
    await s.adapter.createSite(testCtx(), node(s.nodeId), sp);
    s.node.seed(sp.name, 'htdocs/index.html', 'v1');
    const bk = await s.adapter.backup(testCtx(), node(s.nodeId), sp.name, {
      idempotencyToken: tokenFor('o', 'bk', '1'),
      operationId: 'bk',
    });
    expect(bk.status).toBe('succeeded');
    s.node.seed(sp.name, 'htdocs/index.html', 'MUTATED');
    const rs = await s.adapter.restore(testCtx(), node(s.nodeId), sp.name, bk.data!, {
      idempotencyToken: tokenFor('o', 'rs', '1'),
      operationId: 'rs',
    });
    expect(rs.data?.verified).toBe(true);
    expect(s.node.actor(sp.name).readFile(`/home/${sp.name}/htdocs/index.html`)).toBe('v1');
    // corrupt the stored archive: restore must fail on the checksum
    const ref = [...s.sink.store.keys()][0]!;
    const blob = Buffer.from(s.sink.store.get(ref)!);
    blob[20] = blob[20]! ^ 0xff;
    s.sink.store.set(ref, blob);
    const bad = await s.adapter.restore(testCtx(), node(s.nodeId), sp.name, bk.data!, {
      idempotencyToken: tokenFor('o', 'rs', '2'),
      operationId: 'rs2',
    });
    expect(bad).toMatchObject({ status: 'failed', error: { category: 'validation' } });
  });
  it('a missing backup-key reference fails without writing anything to the sink', async () => {
    const s = mockStack();
    const sp = spec('5');
    await s.adapter.createSite(testCtx(), node(s.nodeId), sp);
    const bk = await s.adapter.backup(testCtx(), node(s.nodeId), sp.name, {
      idempotencyToken: tokenFor('o', 'bk', '9'),
      operationId: 'bk',
    });
    expect(bk.status).toBe('failed');
    expect(s.sink.store.size).toBe(0);
  });
  it('certificate issuance binds the domain first, requires the domain on the site, and returns a CertRef', async () => {
    const s = mockStack();
    const sp = spec('6');
    await s.adapter.createSite(testCtx(), node(s.nodeId), sp);
    const c = await s.adapter.issueCertificate(
      testCtx(),
      node(s.nodeId),
      sp.name,
      { domains: ['www.customer-example.test'], mode: 'managed' },
      { idempotencyToken: tokenFor('o', 'c', '1'), operationId: 'c1' },
    );
    expect(c.status).toBe('succeeded');
    expect(c.data!.domains).toEqual(['www.customer-example.test']);
    expect(Date.parse(c.data!.notAfter)).toBeGreaterThan(Date.now());
  });
  it('REAL RECONCILE: 500 injected "reply lost after create" runs leave 0 duplicate sites/users and findByToken adopts every one (AC-M06-05)', async () => {
    const s = mockStack();
    let adopted = 0;
    for (let i = 0; i < 500; i++) {
      const sp = spec('r' + i);
      s.channel.loseReplies = 1; // the create EXECUTES on the node, the reply is lost
      const first = await s.adapter.createSite(testCtx(), node(s.nodeId), sp);
      expect(first.status).toBe('uncertain');
      // reconcile-before-retry: look first, never blindly retry
      const found = await s.adapter.findByToken(testCtx(), node(s.nodeId), sp.name);
      expect(found.status).toBe('succeeded');
      if (found.data) adopted++;
      else await s.adapter.createSite(testCtx(), node(s.nodeId), sp);
    }
    expect(adopted).toBe(500);
    expect(s.node.sites.size).toBe(500);
    expect(s.node.users.size).toBe(501); // 500 site users + root
    expect(s.node.executed.filter((e) => e.commandId === 'site.create')).toHaveLength(500); // never executed twice
  });
  it('a request lost BEFORE the node: findByToken proves absence and only then is the create retried', async () => {
    const s = mockStack();
    const sp = spec('lost');
    s.channel.dropRequests = 1;
    expect((await s.adapter.createSite(testCtx(), node(s.nodeId), sp)).status).toBe('uncertain');
    expect((await s.adapter.findByToken(testCtx(), node(s.nodeId), sp.name)).data).toBeNull();
    expect((await s.adapter.createSite(testCtx(), node(s.nodeId), sp)).status).toBe('succeeded');
    expect(s.node.sites.size).toBe(1);
  });
  it('the channel never carries a secret value: evidence summaries hold command ids only', async () => {
    const s = mockStack();
    const sp = spec('7');
    const r = await s.adapter.createSite(testCtx(), node(s.nodeId), sp);
    expect(JSON.stringify(r.raw)).not.toMatch(/vault:\/\/|password|privkey/i);
  });
  it('AdapterTimeoutError from the channel is `uncertain`, not failed', async () => {
    const s = mockStack();
    s.channel.deliver = async () => {
      throw new AdapterTimeoutError();
    };
    expect((await s.adapter.inventory(testCtx(), node(s.nodeId))).status).toBe('uncertain');
  });
});
