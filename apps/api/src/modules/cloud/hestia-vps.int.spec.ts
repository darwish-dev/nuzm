import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { SecretStore } from '../../common/secrets';
import { NodesService } from '../hosting';
import { PanelInstallService } from './index';
import type { PanelDnsPort, PanelNodePort } from './index';
import { ComputeKit, SSH_KEY, type Row } from './testing/compute-kit';

/**
 * S04: a VPS that installs HestiaCP. The whole path against the mock provider and a fake node registry (the real hosting registry is covered in the node test below):
 * ordering (panel choice, verified images only, order snapshot), the bootstrap (pinned installer, single-use registration, address match), the stages, resume,
 * capacity hold without a region fallback, duplicates, timeouts and tenant isolation. Everything is NOT VERIFIED against a real provider or a real Hestia.
 */
const SHA = 'a'.repeat(64);
const CFG = {
  panelVersion: '1.10.9',
  installerBaseUrl: 'https://raw.githubusercontent.com/hestiacp/hestiacp/release/install',
  installerSha256: { ubuntu: SHA, debian: 'b'.repeat(64) },
  panelDomain: 'vps.nuzm.test',
  callbackBaseUrl: 'https://api.nuzm.test',
  controlPlaneIps: ['203.0.113.10'],
  placements: [{ provider: 'mock', region: 'mock-sa-1' }],
  readinessAttempts: 2,
};
const KEY = 'ABCDEFGHIJKLMNOP:abcdefghijklmnopqrstuvwxyz012345';
const PIN = Array.from({ length: 32 }, (_, i) =>
  (i + 10).toString(16).toUpperCase().padStart(2, '0'),
).join(':');
const UBUNTU = 'mock-ubuntu-2404';

class FakeNodes implements PanelNodePort {
  registered: Row[] = [];
  retired: string[] = [];
  health: 'healthy' | 'unhealthy' = 'healthy';
  profile: 'read_only' | 'too_broad' = 'read_only';
  ids = new Map<string, string>();
  async registerNode(a: Parameters<PanelNodePort['registerNode']>[0]) {
    this.registered.push(a as unknown as Row);
    const id = this.ids.get(a.instanceId) ?? uuidv7();
    this.ids.set(a.instanceId, id);
    return { nodeId: id };
  }
  async retire(id: string) {
    this.retired.push(id);
  }
  async check() {
    return { health: this.health, panelVersion: '1.10.9', profile: this.profile } as const;
  }
}
class FakeDns implements PanelDnsPort {
  ok = true;
  calls: { host: string; addresses: string[] }[] = [];
  async ensureARecords(host: string, addresses: string[]) {
    this.calls.push({ host, addresses });
    return this.ok
      ? ({ ok: true } as const)
      : ({ ok: false, code: 'panel_dns_not_configured' } as const);
  }
}

const k = new ComputeKit();
const nodes = new FakeNodes();
const dns = new FakeDns();
let A = '';
let B = '';
let panel: PanelInstallService;
let store: SecretStore;

beforeAll(async () => {
  process.env.HESTIA_VPS_CONFIG = JSON.stringify(CFG);
  await k.init();
  A = k.orgA;
  B = k.orgB;
  await k.sql(
    `INSERT INTO billing.entitlements (id, scope, source, kind, org_id, meter_group, limit_value, allowance, mode)
     VALUES (gen_random_uuid(), 'org_override', 'override', 'meter_limit', $1, 'compute_instances', 100000, 0, 'hard'),
            (gen_random_uuid(), 'org_override', 'override', 'meter_limit', $1, 'compute_vcpu', 1000000, 0, 'hard')`,
    [A],
  );
  // the Hestia VPS flag is ON for organization A only (default off, CLAUDE.md §4)
  await k.sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'cloud.hestia_vps', $1, 'true'::jsonb)`,
    [A],
  );
  panel = k.app.get(PanelInstallService);
  // the install service keeps its collaborators in `d`; the test swaps in the fakes (DNS has no owner decision yet, the real registry has its own test below)
  (panel as unknown as { d: { nodes: PanelNodePort; dns: PanelDnsPort } }).d.nodes = nodes;
  (panel as unknown as { d: { nodes: PanelNodePort; dns: PanelDnsPort } }).d.dns = dns;
  store = k.app.get(SecretStore);
});
afterAll(() => k.close());

const approve = async (ref = UBUNTU, region = 'mock-sa-1') =>
  k.sql(
    `INSERT INTO compute.panel_image_approvals (id, account_id, provider_region_id, image_ref, panel_kind, panel_version, os_id, os_version, evidence_kind, evidence_note, approved_by)
     VALUES (gen_random_uuid(), $1, $2, $3, 'hestia', '1.10.9', 'ubuntu', '24.04', 'mock', 'test fixture', gen_random_uuid())
     ON CONFLICT (account_id, provider_region_id, image_ref, panel_kind, panel_version) DO UPDATE SET revoked_at = NULL`,
    [k.accountId, region, ref],
  );
const revokeAll = () =>
  k.sql(`UPDATE compute.panel_image_approvals SET revoked_at = now() WHERE revoked_at IS NULL`);

const spec = async (mail = false, over: Record<string, unknown> = {}) => ({
  spec: {
    imageId: await k.imageId('mock-sa-1', UBUNTU),
    count: 1,
    panel: { kind: 'hestia', template: { id: mail ? 'hestia-web-mail' : 'hestia-web', mail } },
    ...over,
  },
});
const order = async (mail = false, name = 'hv-1') => {
  const c = await k.createInstance('alice', A, await spec(mail), name);
  const op = await k.runOp(A, c.operationId);
  return { ...c, op };
};
const prow = async (instanceId: string) =>
  (await k.sql(`SELECT * FROM compute.panel_installs WHERE instance_id = $1`, [instanceId]))[0]!;
const secretOf = async (instanceId: string) => {
  const r = await prow(instanceId);
  return (JSON.parse(await store.get(r.registration_secret_ref)) as { secret: string }).secret;
};
const post = (url: string, secret: string, payload: object, ip = '192.0.2.1') =>
  k.app.inject({
    method: 'POST',
    url,
    remoteAddress: ip,
    headers: { authorization: `Bearer ${secret}` },
    payload,
  });
const ipOf = async (instanceId: string) =>
  ((await k.instanceRow(instanceId)).public_ips as string[])[0]!;
const registerBody = (r: Row, over: Record<string, unknown> = {}) => ({
  panelVersion: '1.10.9',
  host: r.panel_host,
  port: 8083,
  tlsFingerprintSha256: PIN,
  accessKey: KEY,
  ...over,
});
/** the server's side of a successful install: booted, then registered from its own address */
const bootAndRegister = async (instanceId: string) => {
  const secret = await secretOf(instanceId);
  expect((await post('/v1/bootstrap/panel/events', secret, { phase: 'booted' })).statusCode).toBe(
    204,
  );
  const r = await prow(instanceId);
  return post('/v1/bootstrap/panel/register', secret, registerBody(r), await ipOf(instanceId));
};
const settle = async (instanceId: string, n = 4) => {
  const r = await prow(instanceId);
  for (let i = 0; i < n; i++) await panel.advance(r.id);
  return prow(instanceId);
};
const panelDto = async (who: string, org: string, id: string) =>
  k.call(who, 'GET', `/v1/compute/instances/${id}/panel`, org);

describe('ordering: only verified images, the explicit choice, the order snapshot', () => {
  it('Hestia is offered only on images an administrator verified (cloud-init stated, supported OS, sold placement, flag on)', async () => {
    const offers = (await k.call('alice', 'GET', '/v1/offers?country=SA', A)).json().items as Row[];
    const offerId = offers[0]!.offerId as string;
    const before = (await k.call('alice', 'GET', `/v1/offers/${offerId}/images`, A)).json();
    expect(before.items.every((i: Row) => i.hestia === false)).toBe(true);
    expect(before.panels.hestia.available).toBe(false);
    await approve();
    const after = (await k.call('alice', 'GET', `/v1/offers/${offerId}/images`, A)).json();
    expect(after.items.filter((i: Row) => i.hestia).map((i: Row) => i.name)).toEqual([
      'Ubuntu 24.04 64 bit',
    ]);
    expect(after.panels.hestia).toMatchObject({
      available: true,
      templates: ['hestia-web', 'hestia-web-mail'],
    });
    expect(JSON.stringify(after)).not.toMatch(/mock-ubuntu-2404|installer|sha256/); // no provider reference, no installer detail
    // organization B has the flag off: nothing is offered to it
    const b = (await k.call('bob', 'GET', `/v1/offers?country=SA`, B)).json().items as Row[];
    if (b[0]) {
      const imgs = (await k.call('bob', 'GET', `/v1/offers/${b[0].offerId}/images`, B)).json();
      expect(imgs.items.every((i: Row) => i.hestia === false)).toBe(true);
    }
  });

  it('a quote is refused for an unverified image, an unlisted placement, a missing or inconsistent mail choice, count > 1, and a disabled organization', async () => {
    await approve();
    const q = (over: Record<string, unknown>, who = 'alice', org = A) => k.quote(who, org, over);
    // unverified image (the provider's other images carry no cloud-init statement / no approval)
    const other = await k.imageId('mock-sa-1', 'mock-debian');
    let r = await q({ spec: { ...(await spec()).spec, imageId: other } });
    expect(r.statusCode).toBe(422);
    // no template / mail missing / mismatch
    r = await q({
      spec: { imageId: await k.imageId('mock-sa-1', UBUNTU), count: 1, panel: { kind: 'hestia' } },
    });
    expect(r.statusCode).toBe(422);
    r = await q({
      spec: {
        imageId: await k.imageId('mock-sa-1', UBUNTU),
        count: 1,
        panel: { kind: 'hestia', template: { id: 'hestia-web' } },
      },
    });
    expect(r.statusCode).toBe(422);
    expect(r.body).toMatch(/explicit choice|mail/);
    r = await q({
      spec: {
        imageId: await k.imageId('mock-sa-1', UBUNTU),
        count: 1,
        panel: { kind: 'hestia', template: { id: 'hestia-web', mail: true } },
      },
    });
    expect(r.statusCode).toBe(422);
    r = await q(await spec(false, { count: 2 }));
    expect(r.statusCode).toBe(422);
    // the placement is not one that is sold for Hestia: refused, and never silently moved elsewhere
    const saved = process.env.HESTIA_VPS_CONFIG;
    process.env.HESTIA_VPS_CONFIG = JSON.stringify({
      ...CFG,
      placements: [{ provider: 'alibaba', region: 'me-central-1' }],
    });
    try {
      r = await q(await spec());
      expect(r.statusCode).toBe(422);
      expect(r.body).toMatch(/unsupported_capability/);
    } finally {
      process.env.HESTIA_VPS_CONFIG = saved;
    }
    // no digest for the OS: that OS is not sold
    process.env.HESTIA_VPS_CONFIG = JSON.stringify({
      ...CFG,
      installerSha256: { debian: 'b'.repeat(64) },
    });
    try {
      expect((await q(await spec())).statusCode).toBe(422);
    } finally {
      process.env.HESTIA_VPS_CONFIG = saved;
    }
    // organization B: flag off
    const bq = await q({ spec: (await spec()).spec }, 'bob', B);
    expect(bq.statusCode).toBe(422);
    expect(bq.body).toMatch(/unsupported_capability|not enabled/);
  });

  it('the choice is stored in the order snapshot (image, template, region, provider plan, pinned installer) and the install row is bound to the order', async () => {
    await approve();
    const c = await k.createInstance('alice', A, await spec(true), 'snap-1');
    const quote = (
      await k.sql(`SELECT preferences FROM commerce.quotes WHERE id = $1`, [c.quoteId])
    )[0]!;
    const snap = quote.preferences.compute.panel;
    expect(snap).toMatchObject({
      kind: 'hestia',
      template: { id: 'hestia-web-mail', mail: true },
      panelVersion: '1.10.9',
      installerSha256: SHA,
      osId: 'ubuntu',
      osVersion: '24.04',
      providerRegionId: 'mock-sa-1',
      imageRef: UBUNTU,
    });
    expect(snap.installerUrl).toBe(`${CFG.installerBaseUrl}/hst-install-ubuntu.sh`);
    const row = await prow(c.instanceId);
    expect(row).toMatchObject({
      order_id: (await k.instanceRow(c.instanceId)).order_id,
      provider_region_id: 'mock-sa-1',
      plan_ref: snap.planRef,
      image_ref: UBUNTU,
      template: { id: 'hestia-web-mail', mail: true },
      installer_sha256: SHA,
      stage: 'create_server',
    });
    expect(row.panel_host).toMatch(/^p-[0-9a-f]{16}\.vps\.nuzm\.test$/);
    expect(row.registration_hash).toMatch(/^[0-9a-f]{64}$/);
    // one install (hence one server) per order and per instance: the database refuses a second
    await expect(
      k.sql(
        `INSERT INTO compute.panel_installs (id, org_id, instance_id, order_id, panel_kind, provider_key, provider_region_id, plan_ref, image_ref, image_name, os_id, os_version, template, panel_version, installer_url, installer_sha256, panel_host, registration_id, registration_hash)
         SELECT gen_random_uuid(), org_id, instance_id, order_id, panel_kind, provider_key, provider_region_id, plan_ref, image_ref, image_name, os_id, os_version, template, panel_version, installer_url, installer_sha256, panel_host, gen_random_uuid(), registration_hash FROM compute.panel_installs WHERE id = $1`,
        [row.id],
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('the server and its bootstrap', () => {
  it('provisions ONE server whose user data pins the installer by digest, is identical on every retry and carries no more than the single-use secret', async () => {
    await approve();
    const before = k.mock.provisionCalls();
    const c = await order(false, 'hv-boot');
    expect(c.op.state).toBe('succeeded');
    expect(k.mock.provisionCalls() - before).toBe(1);
    const inst = await k.instanceRow(c.instanceId);
    expect(inst).toMatchObject({ status: 'running', panel_kind: 'hestia' });
    const mockInst = [...k.mock.instances.values()].find((i) => i.token === inst.provision_token)!;
    const ud = mockInst.userData!;
    expect(ud.startsWith('#cloud-config')).toBe(true);
    expect(Buffer.byteLength(ud)).toBeLessThan(32 * 1024); // Alibaba: ≤ 32 KB before Base64
    expect(ud).toContain(`echo '${SHA}  hst-install.sh' | sha256sum -c`); // integrity check BEFORE the installer runs
    expect(ud).toContain(`${CFG.installerBaseUrl}/hst-install-ubuntu.sh`);
    expect(ud.indexOf('sha256sum -c')).toBeLessThan(ud.indexOf('bash hst-install.sh'));
    const row = await prow(c.instanceId);
    expect(ud).toContain(`--hostname ${row.panel_host}`);
    expect(ud).toContain('--exim no');
    expect(ud).toContain('--interactive no');
    expect(ud).toContain('nuzm-readonly');
    expect(ud).toContain('v-list-sys-info,v-list-sys-php,v-list-web-templates-backend'); // the read-only profile: nothing that changes the server
    // the customer's SSH key and the secret are in it; nothing else about the organization, the order or Nuzm's records
    expect(ud).toContain('ssh-ed25519');
    for (const leak of [A, B, row.registration_hash, inst.order_id, inst.quote_id, KEY])
      expect(ud).not.toContain(leak as string);
    expect(ud).toContain(await secretOf(c.instanceId));
    // a retry sends byte-identical user data (Alibaba rejects a replayed ClientToken whose parameters changed)
    expect(await panel.userDataFor(A, c.instanceId, [SSH_KEY])).toBe(ud);
    // the boot window starts with the server
    expect(row).toMatchObject({ stage: 'waiting_boot', server_ref: inst.provider_ref });
    expect(row.registration_expires_at).not.toBeNull();
    expect(row.server_addresses).toEqual(inst.public_ips);
  });

  it('a mail-enabled template installs the mail services; a web-only one does not', async () => {
    await approve();
    const c = await order(true, 'hv-mail');
    const inst = await k.instanceRow(c.instanceId);
    const ud = [...k.mock.instances.values()].find(
      (i) => i.token === inst.provision_token,
    )!.userData!;
    expect(ud).toContain('--exim yes');
    expect(ud).toContain('--dovecot yes');
    expect(ud).toContain('--named no'); // no public DNS server on a customer VPS
  });

  it('the whole install: boot → register (single use, address-matched) → DNS → node → readiness → ready; the panel link is read-only and outside the shared network', async () => {
    await approve();
    nodes.registered = [];
    const c = await order(false, 'hv-full');
    const row0 = await prow(c.instanceId);
    const secret = await secretOf(c.instanceId);
    // no / wrong credential
    expect(
      (
        await k.app.inject({
          method: 'POST',
          url: '/v1/bootstrap/panel/events',
          payload: { phase: 'booted' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await post('/v1/bootstrap/panel/events', `nzr1.${row0.registration_id}.${'x'.repeat(43)}`, {
          phase: 'booted',
        })
      ).statusCode,
    ).toBe(401);
    expect((await post('/v1/bootstrap/panel/events', secret, { phase: 'nope' })).statusCode).toBe(
      422,
    );
    // the server reports its boot
    expect((await post('/v1/bootstrap/panel/events', secret, { phase: 'booted' })).statusCode).toBe(
      204,
    );
    expect((await prow(c.instanceId)).stage).toBe('installing_panel');
    // a registration from an address that is NOT the server's address as the provider reports it is refused and the secret survives
    const bad = await post(
      '/v1/bootstrap/panel/register',
      secret,
      registerBody(row0),
      '198.51.100.77',
    );
    expect(bad.statusCode).toBe(403);
    expect((await prow(c.instanceId)).registration_consumed_at).toBeNull();
    expect(
      k.sink.events.some(
        (e) =>
          e.action === 'compute.panel_registration.rejected' && e.resource?.id === c.instanceId,
      ),
    ).toBe(true);
    // wrong host / port / key shape are refused
    const ip = await ipOf(c.instanceId);
    expect(
      (
        await post(
          '/v1/bootstrap/panel/register',
          secret,
          registerBody(row0, { host: 'evil.example.com' }),
          ip,
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (await post('/v1/bootstrap/panel/register', secret, registerBody(row0, { port: 9999 }), ip))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await post(
          '/v1/bootstrap/panel/register',
          secret,
          registerBody(row0, { accessKey: 'x:y' }),
          ip,
        )
      ).statusCode,
    ).toBe(422);
    // the real registration
    const ok = await post('/v1/bootstrap/panel/register', secret, registerBody(row0), ip);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('registered');
    const done = await settle(c.instanceId);
    expect(done.stage).toBe('ready');
    expect(done).toMatchObject({ panel_link: 'connected', panel_version_seen: '1.10.9' });
    expect(done.registration_consumed_at).not.toBeNull();
    expect(done.registration_source_ip).toBe(ip);
    // the secret is gone from the vault and replaying it is refused; the same server repeating the same registration after a lost answer is accepted once more
    await expect(store.get(row0.registration_secret_ref)).rejects.toThrow();
    const other = await post(
      '/v1/bootstrap/panel/register',
      secret,
      registerBody(row0, { accessKey: 'ZZZZZZZZZZZZZZZZ:zzzzzzzzzzzzzzzzzzzzzzzz' }),
      ip,
    );
    expect(other.statusCode).toBe(409);
    const again = await post('/v1/bootstrap/panel/register', secret, registerBody(row0), ip);
    expect(again.json().status).toBe('already_registered');
    expect(
      (await post('/v1/bootstrap/panel/register', secret, registerBody(row0), '198.51.100.77'))
        .statusCode,
    ).toBe(409);
    // DNS and the node were asked for with the provider's addresses, the fixed FQDN and the sealed key reference — never the key itself
    expect(dns.calls.at(-1)).toMatchObject({ host: row0.panel_host, addresses: [ip] });
    const reg = nodes.registered.find((n) => n.instanceId === c.instanceId)!;
    expect(reg).toMatchObject({
      orgId: A,
      panelHost: row0.panel_host,
      panelPort: 8083,
      tlsPinSha256: PIN,
      panelVersion: '1.10.9',
    });
    expect(String(reg.keyRef)).toMatch(/^vault:\/\//);
    expect(JSON.stringify(reg)).not.toContain(KEY);
    expect(
      JSON.stringify(await k.sql(`SELECT * FROM compute.panel_installs WHERE id = $1`, [done.id])),
    ).not.toContain(KEY);
    expect(JSON.stringify(k.sink.events)).not.toContain(KEY);
    // the customer's view
    const dto = (await panelDto('alice', A, c.instanceId)).json();
    expect(dto).toMatchObject({
      stage: 'ready',
      ready: true,
      panelLink: 'connected',
      attention: null,
      holdReason: null,
    });
    expect(dto.steps.every((s: Row) => s.state === 'done')).toBe(true);
    expect(dto.adminPasswordFile).toBe('/root/.nuzm-panel-admin-password');
    expect(JSON.stringify(dto)).not.toMatch(/registration|secret|installerSha|mock-i-/);
    const inst = (await k.call('alice', 'GET', `/v1/compute/instances/${c.instanceId}`, A)).json();
    expect(inst).toMatchObject({ panelKind: 'hestia', status: 'running' });
    expect(inst.panel.stage).toBe('ready');
    // another organization cannot see it
    expect((await panelDto('bob', B, c.instanceId)).statusCode).toBe(404);
  });

  it('two concurrent registrations with the same secret: exactly one wins (single use under concurrency)', async () => {
    await approve();
    const c = await order(false, 'hv-race');
    const r0 = await prow(c.instanceId);
    const secret = await secretOf(c.instanceId);
    await post('/v1/bootstrap/panel/events', secret, { phase: 'booted' });
    const ip = await ipOf(c.instanceId);
    const keys = [
      'AAAAAAAAAAAAAAAA:aaaaaaaaaaaaaaaaaaaaaaaa',
      'BBBBBBBBBBBBBBBB:bbbbbbbbbbbbbbbbbbbbbbbb',
    ];
    const rs = await Promise.all(
      keys.map((accessKey) =>
        post('/v1/bootstrap/panel/register', secret, registerBody(r0, { accessKey }), ip),
      ),
    );
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('a registration after the window ended is refused (410); the install needs attention and resumes on the SAME server with a new window', async () => {
    await approve();
    const c = await order(false, 'hv-expired');
    const secret = await secretOf(c.instanceId);
    const r0 = await prow(c.instanceId);
    await post('/v1/bootstrap/panel/events', secret, { phase: 'booted' });
    await k.sql(
      `UPDATE compute.panel_installs SET registration_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [r0.id],
    );
    const ip = await ipOf(c.instanceId);
    expect(
      (await post('/v1/bootstrap/panel/register', secret, registerBody(r0), ip)).statusCode,
    ).toBe(410);
    await panel.advance(r0.id);
    expect(await prow(c.instanceId)).toMatchObject({
      stage: 'needs_attention',
      attention_code: 'registration_expired',
      resume_stage: 'installing_panel',
    });
    const calls = k.mock.provisionCalls();
    const retry = await k.call(
      'alice',
      'POST',
      `/v1/compute/instances/${c.instanceId}/panel/retry`,
      A,
    );
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({
      action: 'rerun_bootstrap',
      command: 'sudo bash /usr/local/sbin/nuzm-bootstrap.sh',
    });
    expect(k.mock.provisionCalls()).toBe(calls); // the same server: never a second one
    expect((await prow(c.instanceId)).stage).toBe('installing_panel');
    expect(
      (await post('/v1/bootstrap/panel/register', secret, registerBody(r0), ip)).statusCode,
    ).toBe(200);
    expect((await settle(c.instanceId)).stage).toBe('ready');
  });
});

describe('failures and resume', () => {
  it('a failed integrity check stops everything and is never retried on that server; other bootstrap failures resume by re-running the script (no wipe, no new server)', async () => {
    await approve();
    const c = await order(false, 'hv-fail');
    const secret = await secretOf(c.instanceId);
    const calls = k.mock.provisionCalls();
    await post('/v1/bootstrap/panel/events', secret, { phase: 'failed', code: 'integrity_failed' });
    expect(await prow(c.instanceId)).toMatchObject({
      stage: 'needs_attention',
      attention_code: 'integrity_failed',
    });
    const dto = (await panelDto('alice', A, c.instanceId)).json();
    expect(dto.attention).toMatchObject({ code: 'integrity_failed', resumable: 'support' });
    const no = await k.call(
      'alice',
      'POST',
      `/v1/compute/instances/${c.instanceId}/panel/retry`,
      A,
    );
    expect(no.statusCode).toBe(409);
    expect(k.mock.provisionCalls()).toBe(calls);

    const d = await order(false, 'hv-fail2');
    const s2 = await secretOf(d.instanceId);
    await post('/v1/bootstrap/panel/events', s2, { phase: 'failed', code: 'install_failed' });
    expect((await panelDto('alice', A, d.instanceId)).json().attention).toMatchObject({
      code: 'bootstrap_install_failed',
      resumable: 'server',
    });
    const before = (await prow(d.instanceId)).registration_expires_at as Date;
    const retry = await k.call(
      'alice',
      'POST',
      `/v1/compute/instances/${d.instanceId}/panel/retry`,
      A,
    );
    expect(retry.json().action).toBe('rerun_bootstrap');
    expect(
      ((await prow(d.instanceId)).registration_expires_at as Date).getTime(),
    ).toBeGreaterThanOrEqual(before.getTime());
    expect(
      await k.sql(`SELECT 1 FROM cloud.resources WHERE created_by_operation_id = $1`, [
        d.operationId,
      ]),
    ).toHaveLength(1);
    // nothing to resume on a healthy install
    expect(
      (await k.call('alice', 'POST', `/v1/compute/instances/${d.instanceId}/panel/retry`, A))
        .statusCode,
    ).toBe(409);
  });

  it('boot timeout, DNS not configured and readiness failures need attention and resume from their own stage; a key broader than read-only is refused', async () => {
    await approve();
    // boot timeout
    const c = await order(false, 'hv-boot-timeout');
    k.advance(21 * 60_000);
    await panel.advance((await prow(c.instanceId)).id);
    expect(await prow(c.instanceId)).toMatchObject({
      stage: 'needs_attention',
      attention_code: 'boot_timeout',
      resume_stage: 'waiting_boot',
    });
    expect(
      (await k.call('alice', 'POST', `/v1/compute/instances/${c.instanceId}/panel/retry`, A)).json()
        .action,
    ).toBe('continued');
    expect((await prow(c.instanceId)).stage).toBe('waiting_boot');

    // DNS has no owner decision yet: the install waits, resumable once it is configured
    dns.ok = false;
    const d = await order(false, 'hv-dns');
    expect((await bootAndRegister(d.instanceId)).statusCode).toBe(200);
    expect((await settle(d.instanceId)).attention_code).toBe('panel_dns_not_configured');
    dns.ok = true;
    expect(
      (await k.call('alice', 'POST', `/v1/compute/instances/${d.instanceId}/panel/retry`, A)).json()
        .action,
    ).toBe('continued');
    expect((await settle(d.instanceId)).stage).toBe('ready');

    // readiness fails (panel unreachable) → needs attention → recovers on retry
    nodes.health = 'unhealthy';
    const e = await order(false, 'hv-ready');
    expect((await bootAndRegister(e.instanceId)).statusCode).toBe(200);
    expect(await settle(e.instanceId, 6)).toMatchObject({
      stage: 'needs_attention',
      attention_code: 'readiness_failed',
      resume_stage: 'readiness',
    });
    nodes.health = 'healthy';
    await k.call('alice', 'POST', `/v1/compute/instances/${e.instanceId}/panel/retry`, A);
    expect((await settle(e.instanceId)).stage).toBe('ready');

    // a key that can run more than the read-only profile is never accepted as ready
    nodes.profile = 'too_broad';
    const f = await order(false, 'hv-broad');
    await bootAndRegister(f.instanceId);
    expect(await settle(f.instanceId)).toMatchObject({
      stage: 'needs_attention',
      attention_code: 'panel_permissions_too_broad',
    });
    nodes.profile = 'read_only';
  });

  it('stop and restart are refused while the installer runs; after ready they stay available through the provider even when the panel link is lost', async () => {
    await approve();
    const c = await order(false, 'hv-link');
    const stop = await k.call('alice', 'POST', `/v1/compute/instances/${c.instanceId}/actions`, A, {
      type: 'stop',
    });
    expect(stop.statusCode).toBe(409);
    expect((await bootAndRegister(c.instanceId)).statusCode).toBe(200);
    expect((await settle(c.instanceId)).stage).toBe('ready');
    // the customer (root) breaks the link: the panel does not answer
    nodes.health = 'unhealthy';
    await k.sql(
      `UPDATE compute.panel_installs SET panel_link_checked_at = now() - interval '1 hour' WHERE instance_id = $1`,
      [c.instanceId],
    );
    await panel.advance((await prow(c.instanceId)).id);
    expect((await prow(c.instanceId)).panel_link).toBe('lost');
    const dto = (await panelDto('alice', A, c.instanceId)).json();
    expect(dto).toMatchObject({ stage: 'ready', panelLink: 'lost' });
    // provider actions are unaffected
    const act = await k.call('alice', 'POST', `/v1/compute/instances/${c.instanceId}/actions`, A, {
      type: 'stop',
    });
    expect(act.statusCode).toBe(202);
    await k.runOp(A, act.json().operationId);
    expect((await k.instanceRow(c.instanceId)).status).toBe('stopped');
    const start = await k.call(
      'alice',
      'POST',
      `/v1/compute/instances/${c.instanceId}/actions`,
      A,
      { type: 'start' },
    );
    await k.runOp(A, start.json().operationId);
    expect((await k.instanceRow(c.instanceId)).status).toBe('running');
    // the link comes back
    nodes.health = 'healthy';
    await k.sql(
      `UPDATE compute.panel_installs SET panel_link_checked_at = now() - interval '1 hour' WHERE instance_id = $1`,
      [c.instanceId],
    );
    await panel.advance((await prow(c.instanceId)).id);
    expect((await prow(c.instanceId)).panel_link).toBe('connected');
  });

  it('a timeout AFTER the provider created the server: reconcile adopts it (one create) and the install continues from the adopted server', async () => {
    await approve();
    const c = await k.createInstance('alice', A, await spec(false), 'hv-uncertain');
    const callsBefore = k.mock.provisionLog.length;
    k.mock.inject({ op: 'provision', kind: 'timeout_after_side_effect' });
    expect((await k.runOp(A, c.operationId)).state).toBe('needs_reconcile');
    expect((await prow(c.instanceId)).stage).toBe('create_server'); // nothing is claimed about a server nobody has confirmed
    const row = await k.instanceRow(c.instanceId);
    expect((await k.reconciler.reconcileResource(row.rid)).result).toBe('adopted');
    expect(k.mock.provisionLog.length - callsBefore).toBe(1);
    const p = await prow(c.instanceId);
    expect(p).toMatchObject({ stage: 'waiting_boot' });
    expect(p.server_ref).toMatch(/^mock-i-/);
    expect((await bootAndRegister(c.instanceId)).statusCode).toBe(200);
    expect((await settle(c.instanceId)).stage).toBe('ready');
  });

  it('a duplicate queue message after the server exists creates no second server', async () => {
    await approve();
    const c = await order(false, 'hv-dup');
    const calls = k.mock.provisionCalls();
    await k.prov.run(A, c.operationId, 'second-worker'); // the same message again: the operation is already finished
    await k.prov.run(A, c.operationId, 'third-worker');
    expect(k.mock.provisionCalls()).toBe(calls);
    expect(
      await k.sql(`SELECT 1 FROM cloud.resources WHERE created_by_operation_id = $1`, [
        c.operationId,
      ]),
    ).toHaveLength(1);
  });
});

describe('no capacity in the sold region: the order is held, never moved', () => {
  const plans = (availability: 'available' | 'sold_out') => [
    {
      planRef: 'mock.small',
      vcpu: 1,
      memoryMb: 2048,
      diskGb: 40,
      hourlyMinor: '12',
      currency: 'SAR',
      availability,
    },
    {
      planRef: 'mock.medium',
      vcpu: 2,
      memoryMb: 4096,
      diskGb: 80,
      hourlyMinor: '24',
      currency: 'SAR',
      availability,
    },
  ];

  it('holds with a clear reason for the customer and the administration, keeps the region and the cost authorization, and completes in the SAME region when capacity returns', async () => {
    await approve();
    const c = await k.createInstance('alice', A, await spec(false), 'hv-held');
    const before = k.mock.provisionCalls();
    k.mock.setPlans(plans('sold_out'));
    try {
      const op = await k.runOp(A, c.operationId);
      expect(op.state).toBe('pending'); // deferred, not failed
      expect(op.next_run_at.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
      expect(k.mock.provisionCalls()).toBe(before + 1); // one refused attempt, nothing created
      expect(k.mock.billableByToken((await k.instanceRow(c.instanceId)).provision_token)).toBe(0);
      const inst = await k.instanceRow(c.instanceId);
      expect(inst).toMatchObject({
        status: 'held',
        hold_reason: 'provider_capacity_unavailable',
        rstate: 'PROVISIONING',
        provider_ref: null,
      });
      const dto = (await k.call('alice', 'GET', `/v1/compute/instances/${c.instanceId}`, A)).json();
      expect(dto).toMatchObject({
        status: 'held',
        holdReason: 'provider_capacity_unavailable',
        panelKind: 'hestia',
      });
      expect(dto.panel).toMatchObject({
        stage: 'held',
        holdReason: 'provider_capacity_unavailable',
      });
      expect(dto.panel.steps[0].state).toBe('failed');
      // the region of the order is the sold one and no other region was tried
      expect(
        (
          await k.sql(`SELECT provider_region_id FROM cloud.resources WHERE id = $1`, [inst.rid])
        )[0]!.provider_region_id,
      ).toBe('mock-sa-1');
      expect(
        [...k.mock.instances.values()].filter((i) => i.token === inst.provision_token),
      ).toHaveLength(0);
      // the administration sees it
      const adm = (await k.admin('pa', 'GET', '/v1/admin/compute/panel-installs?stage=held')).json()
        .items as Row[];
      expect(adm.find((i) => i.instanceId === c.instanceId)).toMatchObject({
        stage: 'held',
        region: 'mock-sa-1',
      });
      expect(
        k.sink.events.some(
          (e) => e.action === 'instance.create.held' && e.resource?.id === c.instanceId,
        ),
      ).toBe(true);
      // the cost authorization stays until the order is served or cancelled
      expect(
        await k.sql(
          `SELECT 1 FROM commerce.authorization_releases r JOIN commerce.authorizations a ON a.id = r.authorization_id WHERE a.order_id = $1`,
          [inst.order_id],
        ),
      ).toHaveLength(0);
    } finally {
      k.mock.setPlans(plans('available'));
    }
    await k.sql(`UPDATE platform.operations SET next_run_at = now() WHERE id = $1`, [
      c.operationId,
    ]);
    const done = await k.runOp(A, c.operationId);
    expect(done.state).toBe('succeeded');
    expect(await k.instanceRow(c.instanceId)).toMatchObject({
      status: 'running',
      hold_reason: null,
    });
    expect(await prow(c.instanceId)).toMatchObject({ stage: 'waiting_boot' });
    expect(k.mock.provisionCalls()).toBe(before + 2);
    expect(k.mock.billableByToken((await k.instanceRow(c.instanceId)).provision_token)).toBe(1);
  });

  it('cancelling a held order releases the cost authorization and fails the order (no charge)', async () => {
    await approve();
    const c = await k.createInstance('alice', A, await spec(false), 'hv-held-cancel');
    k.mock.setPlans(plans('sold_out'));
    try {
      await k.runOp(A, c.operationId);
      const got = await k.call('alice', 'GET', `/v1/compute/instances/${c.instanceId}`, A);
      expect(got.json().status).toBe('held');
      const del = await k.call(
        'alice',
        'DELETE',
        `/v1/compute/instances/${c.instanceId}`,
        A,
        undefined,
        { 'if-match': String(got.headers.etag) },
      );
      expect(del.statusCode).toBe(202);
      const inst = await k.instanceRow(c.instanceId);
      expect(inst.status).toBe('failed');
      expect(
        (await k.sql(`SELECT status FROM commerce.orders WHERE id = $1`, [inst.order_id]))[0]!
          .status,
      ).toBe('failed');
      expect(
        await k.sql(
          `SELECT 1 FROM commerce.authorization_releases r JOIN commerce.authorizations a ON a.id = r.authorization_id WHERE a.order_id = $1`,
          [inst.order_id],
        ),
      ).toHaveLength(1);
      expect(
        (await k.sql(`SELECT state FROM platform.operations WHERE id = $1`, [c.operationId]))[0]!
          .state,
      ).toBe('cancelled');
      expect(k.mock.billableByToken(inst.provision_token)).toBe(0);
    } finally {
      k.mock.setPlans(plans('available'));
    }
  });
});

describe('approvals (admin) and the execution-time re-check', () => {
  it('only an image with provider-stated cloud-init and a Hestia-supported OS can be approved; the approval can be withdrawn', async () => {
    await revokeAll();
    const plain = await k.imageId('mock-sa-1', 'mock-ubuntu'); // no cloud-init statement, no version in the name
    const body = { evidenceKind: 'mock', evidenceNote: 'fixture run in CI' };
    expect(
      (await k.admin('pa', 'PUT', `/v1/admin/compute/panel-images/${plain}`, body)).statusCode,
    ).toBe(422);
    const good = await k.imageId('mock-sa-1', UBUNTU);
    expect(
      (
        await k.admin('pa', 'PUT', `/v1/admin/compute/panel-images/${good}`, {
          evidenceKind: 'nope',
          evidenceNote: 'x',
        })
      ).statusCode,
    ).toBe(422);
    const ok = await k.admin('pa', 'PUT', `/v1/admin/compute/panel-images/${good}`, body);
    expect(ok.statusCode).toBe(200);
    const list = (
      await k.admin(
        'pa',
        'GET',
        `/v1/admin/compute/panel-images?accountId=${k.accountId}&regionId=mock-sa-1`,
      )
    ).json().items as Row[];
    const item = list.find((i) => i.imageId === good)!;
    expect(item).toMatchObject({
      cloudInit: true,
      os: { id: 'ubuntu', version: '24.04', supportedByHestia: true },
      approval: { panelVersion: '1.10.9', evidenceKind: 'mock', revoked: false },
    });
    expect(list.find((i) => i.imageId === plain)!.cloudInit).toBeNull();
    // a customer cannot reach the admin surface
    expect(
      (await k.call('alice', 'PUT', `/v1/admin/compute/panel-images/${good}`, A, body)).statusCode,
    ).toBeGreaterThanOrEqual(401);
    // withdraw: no longer offered
    expect(
      (await k.admin('pa', 'DELETE', `/v1/admin/compute/panel-image-approvals/${item.approval.id}`))
        .statusCode,
    ).toBe(204);
    expect((await k.quote('alice', A, await spec())).statusCode).toBe(422);
    expect(k.sink.events.some((e) => e.action === 'compute.panel_image.approved')).toBe(true);
    expect(k.sink.events.some((e) => e.action === 'compute.panel_image.revoked')).toBe(true);
  });

  it('an approval withdrawn between the quote and the execution releases the order without creating anything', async () => {
    await approve();
    const c = await k.createInstance('alice', A, await spec(false), 'hv-toctou');
    await revokeAll();
    const before = k.mock.provisionCalls();
    const op = await k.runOp(A, c.operationId);
    expect(op.state).toBe('failed');
    expect(op.error.code).toBe('panel_not_offered');
    expect(k.mock.provisionCalls()).toBe(before);
    const inst = await k.instanceRow(c.instanceId);
    expect(inst.status).toBe('failed');
    expect(
      await k.sql(
        `SELECT 1 FROM commerce.authorization_releases r JOIN commerce.authorizations a ON a.id = r.authorization_id WHERE a.order_id = $1`,
        [inst.order_id],
      ),
    ).toHaveLength(1);
  });
});

describe('the customer VPS is outside the shared-hosting network (real node registry)', () => {
  it('registers as customer_vps, owned by the organization, never active, and retires with the server', async () => {
    const n = k.app.get(NodesService);
    const instanceId = `cvps-${Date.now()}`;
    const { nodeId } = await n.registerCustomerVps({
      orgId: A,
      instanceId,
      name: `vps-${Date.now()}`,
      region: 'mock-sa-1',
      dataRegion: 'sa',
      panelHost: 'p-0123456789abcdef.vps.nuzm.test',
      panelPort: 8083,
      tlsPinSha256: PIN,
      keyRef: 'vault://dev/hosting-panel-vps-test',
      panelVersion: '1.10.9',
    });
    const row = (await k.sql(`SELECT * FROM hosting.nodes WHERE id = $1`, [nodeId]))[0]!;
    expect(row).toMatchObject({
      network_class: 'customer_vps',
      owner_org_id: A,
      status: 'maintenance',
      panel_host: 'p-0123456789abcdef.vps.nuzm.test',
      panel_key_ref: 'vault://dev/hosting-panel-vps-test',
    });
    // idempotent per compute instance
    expect(
      (
        await n.registerCustomerVps({
          orgId: A,
          instanceId,
          name: 'other-name',
          region: 'mock-sa-1',
          dataRegion: 'sa',
          panelHost: 'p-0123456789abcdef.vps.nuzm.test',
          panelPort: 8083,
          tlsPinSha256: PIN,
          keyRef: 'vault://dev/hosting-panel-vps-test',
          panelVersion: '1.10.9',
        })
      ).nodeId,
    ).toBe(nodeId);
    // another organization cannot take the same compute instance over
    await expect(
      n.registerCustomerVps({
        orgId: B,
        instanceId,
        name: 'x-name',
        region: 'mock-sa-1',
        dataRegion: 'sa',
        panelHost: 'p-0123456789abcdef.vps.nuzm.test',
        panelPort: 8083,
        tlsPinSha256: PIN,
        keyRef: 'vault://dev/x',
        panelVersion: null,
      }),
    ).rejects.toThrow();
    // the database refuses to make it a placement target for shared sites
    await expect(
      k.sql(`UPDATE hosting.nodes SET status = 'active' WHERE id = $1`, [nodeId]),
    ).rejects.toThrow(/nodes_customer_vps_never_shared/);
    await n.retireCustomerVps(nodeId);
    expect(
      (await k.sql(`SELECT status FROM hosting.nodes WHERE id = $1`, [nodeId]))[0]!.status,
    ).toBe('retired');
  });
});
