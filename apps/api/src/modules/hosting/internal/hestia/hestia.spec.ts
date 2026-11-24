import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryVault } from '../mock/mocks';
import { HestiaHostingAdapter } from './adapter';
import { HestiaClient, HttpHestiaChannel, type HestiaConnection } from './client';
import { HESTIA_COMMANDS, HestiaArgError, buildArgs } from './commands';
import { startHestiaMock } from './mock-server';

const NODE = { nodeId: '00000000-0000-7000-8000-0000000000aa', computeInstanceId: 'i-1' };
const ctx = {
  providerAccountId: 'p',
  credentialRef: 'vault://hosting/x',
  traceId: 't',
  deadlineMs: 1500,
};
const T = { idempotencyToken: 'a'.repeat(64), operationId: 'op-1' };
const LIMITS = { diskMb: 100, inodes: 5000, maxProcesses: 20, memoryMb: 256, bandwidthGbMonth: 10 };
const spec = (name: string, domain: string, runtime = 'php:8.3') => ({
  name,
  runtime,
  domain,
  limits: LIMITS,
  credentialsRef: `vault://hosting/sites/${name}`,
  backupKeyRef: `vault://hosting/backup/${name}`,
  ...T,
});

let mock: Awaited<ReturnType<typeof startHestiaMock>>;
let adapter: HestiaHostingAdapter;
let vault: MemoryVault;
let key = '';
beforeAll(async () => {
  mock = await startHestiaMock();
  key = mock.controls.hash;
  vault = new MemoryVault();
  const conn: HestiaConnection = {
    host: mock.host,
    port: mock.port,
    accessKeyRef: 'vault://hosting/nodes/key',
  };
  const client = new HestiaClient(
    { resolve: async () => conn },
    { accessKey: async () => key },
    new HttpHestiaChannel({ allowPlainLoopback: true }),
  );
  adapter = new HestiaHostingAdapter(client, {
    vault,
    evidenceKind: 'mock',
    packageFor: () => 'nuzm-starter',
    capacityOf: async () => ({ cpuMillicores: 4000, memoryMb: 8192, diskMb: 200000 }),
  });
});
afterAll(() => mock.close());

describe('command allow-list', () => {
  it('builds the documented argument order and refuses anything malformed without echoing the value', () => {
    expect(
      buildArgs(HESTIA_COMMANDS.addWebDomain, { user: 's-abcdef123456', domain: 'a.example.com' }),
    ).toEqual(['s-abcdef123456', 'a.example.com']);
    for (const bad of [
      { user: 'root', domain: 'a.example.com' },
      { user: 's-abcdef123456', domain: 'a.example.com; rm -rf /' },
      { user: 's-abcdef123456', domain: 'a.example.com', extra: 'x' },
      { user: 's-abcdef123456' },
    ]) {
      let msg = '';
      try {
        buildArgs(HESTIA_COMMANDS.addWebDomain, bad as Record<string, string>);
      } catch (e) {
        expect(e).toBeInstanceOf(HestiaArgError);
        msg = (e as Error).message;
      }
      expect(msg).not.toBe('');
      expect(msg).not.toContain('rm -rf');
    }
    // an optional argument cannot be skipped over (positional)
    expect(() =>
      buildArgs(HESTIA_COMMANDS.addWebDomain, {
        user: 's-abcdef123456',
        domain: 'a.example.com',
        restart: 'no',
        ip: undefined,
        aliases: 'x.example.com',
      } as never),
    ).toThrow(HestiaArgError);
  });
});

describe('HestiaHostingAdapter against the mock panel (NOT VERIFIED vs vendor)', () => {
  it('probe: documented read commands decide the capabilities; runtimes are what the node reports; unsupported things stay unsupported', async () => {
    const r = await adapter.probe(ctx, NODE);
    expect(r.runtimes).toEqual(['php:8.2', 'php:8.3', 'static']);
    expect(r.capabilities['hosting.site.create']).toBe('supported');
    expect(r.capabilities['hosting.cert.issue']).toBe('supported');
    expect(r.capabilities['hosting.runtime.php']).toBe('supported');
    for (const c of [
      'hosting.backup.create',
      'hosting.backup.restore',
      'hosting.cert.install-custom',
      'hosting.runtime.nodejs',
      'hosting.db.binding',
    ] as const)
      expect(r.capabilities[c]).toBe('unsupported');
    expect(r.evidence.every((e) => e.kind === 'mock')).toBe(true);
  });

  it('inventory reports the panel version and takes physical capacity from the compute provider', async () => {
    const i = await adapter.inventory(ctx, NODE);
    expect(i.status).toBe('succeeded');
    expect(i.data).toMatchObject({
      panelKind: 'hestia',
      panelVersion: '1.9.4',
      capacity: { cpuMillicores: 4000, memoryMb: 8192 },
      usage: { sites: 0 },
    });
  });

  it('createSite: account, domain and PHP template; the password goes to the vault only; a replay changes nothing', async () => {
    const name = 's-aaaa11112222bbbb';
    const r = await adapter.createSite(ctx, NODE, spec(name, 'shop.example.com'));
    expect(r.status).toBe('succeeded');
    const u = mock.controls.users.get(name)!;
    expect(u.pkg).toBe('nuzm-starter');
    expect(u.domains.get('shop.example.com')?.backend).toBe('PHP-8_3');
    const stored = JSON.parse(vault.secrets.get(`vault://hosting/sites/${name}`)!.toString());
    expect(stored.password).toBe(u.password);
    expect(JSON.stringify(r)).not.toContain(u.password);
    const before = [...mock.controls.commands];
    expect((await adapter.createSite(ctx, NODE, spec(name, 'shop.example.com'))).status).toBe(
      'succeeded',
    );
    expect(mock.controls.users.size).toBe(1);
    expect(mock.controls.commands.slice(before.length)).not.toContain('v-add-user');
  });

  it('findByToken: found, and PROVABLY absent for a site that never existed', async () => {
    const f = await adapter.findByToken(ctx, NODE, 's-aaaa11112222bbbb');
    expect(f.data).toMatchObject({
      name: 's-aaaa11112222bbbb',
      domains: ['shop.example.com'],
      suspended: false,
      runtime: 'php:8.3',
    });
    const none = await adapter.findByToken(ctx, NODE, 's-neverexisted0000');
    expect(none).toMatchObject({ status: 'succeeded', data: null });
  });

  it('timeout AFTER the panel acted: createSite is uncertain; the reconcile finds the account and the retry creates nothing twice', async () => {
    const name = 's-cccc33334444dddd';
    mock.controls.inject('v-add-user', 'drop-after', 1);
    const r = await adapter.createSite(ctx, NODE, spec(name, 'late.example.com'));
    expect(r.status).toBe('uncertain');
    expect(mock.controls.users.has(name)).toBe(true);
    expect((await adapter.findByToken(ctx, NODE, name)).data?.name).toBe(name);
    expect((await adapter.createSite(ctx, NODE, spec(name, 'late.example.com'))).status).toBe(
      'succeeded',
    );
    expect([...mock.controls.users.keys()].filter((k) => k === name)).toHaveLength(1);
  });

  it('timeout BEFORE the panel acted: uncertain, provably absent, and the retry succeeds once', async () => {
    const name = 's-eeee55556666ffff';
    mock.controls.inject('v-add-user', 'drop', 1);
    expect((await adapter.createSite(ctx, NODE, spec(name, 'early.example.com'))).status).toBe(
      'uncertain',
    );
    expect((await adapter.findByToken(ctx, NODE, name)).data).toBeNull();
    expect((await adapter.createSite(ctx, NODE, spec(name, 'early.example.com'))).status).toBe(
      'succeeded',
    );
  });

  it('documented return codes become normalized errors: an unknown package is not_found, a taken domain is a conflict', async () => {
    const odd = new HestiaHostingAdapter(
      new HestiaClient(
        { resolve: async () => ({ host: mock.host, port: mock.port, accessKeyRef: 'k' }) },
        { accessKey: async () => key },
        new HttpHestiaChannel({ allowPlainLoopback: true }),
      ),
      { vault, evidenceKind: 'mock', packageFor: () => 'no-such-package' },
    );
    const r = await odd.createSite(ctx, NODE, spec('s-gggg77778888hhhh', 'pkg.example.com'));
    expect(r.status).toBe('failed');
    expect(r.error?.category).toBe('not_found');
    const dup = await adapter.createSite(ctx, NODE, spec('s-iiii99990000jjjj', 'shop.example.com'));
    expect(dup.status).toBe('failed');
    expect(dup.error?.category).toBe('conflict');
  });

  it('a wrong access key is an auth failure that reveals nothing', async () => {
    const bad = new HestiaHostingAdapter(
      new HestiaClient(
        { resolve: async () => ({ host: mock.host, port: mock.port, accessKeyRef: 'k' }) },
        { accessKey: async () => 'WRONG:wrong-secret-value' },
        new HttpHestiaChannel({ allowPlainLoopback: true }),
      ),
      { vault, evidenceKind: 'mock' },
    );
    const h = await bad.health(ctx, NODE);
    expect(h.state).toBe('degraded');
    expect(JSON.stringify(h)).not.toContain('wrong-secret-value');
  });

  it('suspend and resume are idempotent; usage converts Hestia megabytes', async () => {
    const name = 's-aaaa11112222bbbb';
    expect((await adapter.suspendSite(ctx, NODE, name, T)).status).toBe('succeeded');
    expect((await adapter.suspendSite(ctx, NODE, name, T)).status).toBe('succeeded'); // E_SUSPENDED is fine
    expect((await adapter.findByToken(ctx, NODE, name)).data?.suspended).toBe(true);
    expect((await adapter.resumeSite(ctx, NODE, name, T)).status).toBe('succeeded');
    expect((await adapter.resumeSite(ctx, NODE, name, T)).status).toBe('succeeded');
    const u = await adapter.usage(ctx, NODE, name);
    expect(u.data).toMatchObject({
      diskBytes: 12 * 1024 * 1024,
      bandwidthBytesMonth: 3 * 1024 * 1024,
    });
  });

  it('updateSite binds a domain and switches the PHP version on every domain', async () => {
    const name = 's-aaaa11112222bbbb';
    const r = await adapter.updateSite(
      ctx,
      NODE,
      name,
      { domains: ['www.shop.example.com'], runtime: 'php:8.2' },
      T,
    );
    expect(r.status).toBe('succeeded');
    const u = mock.controls.users.get(name)!;
    expect([...u.domains.keys()].sort()).toEqual(['shop.example.com', 'www.shop.example.com']);
    expect([...u.domains.values()].every((d) => d.backend === 'PHP-8_2')).toBe(true);
  });

  it('issues a managed certificate, reads only the expiry, and never keeps the private key', async () => {
    const name = 's-aaaa11112222bbbb';
    const c = await adapter.issueCertificate(
      ctx,
      NODE,
      name,
      { domains: ['shop.example.com'], mode: 'managed' },
      T,
    );
    expect(c.status).toBe('succeeded');
    expect(c.data?.notAfter).toBe('2027-02-20T10:00:00.000Z');
    expect(JSON.stringify(c)).not.toContain('PRIVATE-KEY');
    const again = await adapter.issueCertificate(
      ctx,
      NODE,
      name,
      { domains: ['shop.example.com'], mode: 'managed' },
      T,
    );
    expect(again.status).toBe('succeeded'); // E_EXISTS is fine: a retry after a lost answer
    const custom = await adapter.issueCertificate(
      ctx,
      NODE,
      name,
      { domains: ['shop.example.com'], mode: 'custom' },
      T,
    );
    expect(custom.error?.category).toBe('unsupported');
  });

  it('delete removes the account and proves it: a second delete is fine, the wipe report is empty', async () => {
    const name = 's-aaaa11112222bbbb';
    const d = await adapter.deleteSite(ctx, NODE, name, T);
    expect(d.status).toBe('succeeded');
    expect(d.data).toMatchObject({ usersRemaining: 0, vhostsRemaining: 0 });
    expect(mock.controls.users.has(name)).toBe(false);
    expect((await adapter.deleteSite(ctx, NODE, name, T)).status).toBe('succeeded');
  });

  it('without an off-server store, backups and restores are unsupported (never faked)', async () => {
    const name = 's-aaaa11112222bbbb';
    expect((await adapter.backup(ctx, NODE, name, T)).error?.category).toBe('unsupported');
    const ref = { backupId: 'b', sizeBytes: 1, checksum: 'a'.repeat(64), manifest: [] };
    expect((await adapter.restore(ctx, NODE, name, ref, T)).error?.category).toBe('unsupported');
  });
});
