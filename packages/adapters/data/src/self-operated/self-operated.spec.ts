import { describe, expect, it } from 'vitest';
import { DATABASE_CASES, runConformance } from '../conformance';
import { selfOperatedSubject, ctx } from '../test-kit';
import {
  AGENT_COMMANDS,
  AgentRefusedError,
  CommandVerifier,
  signCommand,
  type SignedCommand,
} from './agent-protocol';
import { fleetKey } from './fake-node';
import { createHmac } from 'node:crypto';

describe('self-operated-database family against the shared database conformance suite (compute + agent are FAKES: NOT VERIFIED)', () => {
  for (const engine of ['postgresql', 'mysql'] as const)
    it(`passes every database case for ${engine}`, async () => {
      const report = await runConformance(
        DATABASE_CASES,
        () => selfOperatedSubject(engine).subject,
      );
      expect(report.results.filter((r) => r.status === 'fail')).toEqual([]);
      expect(report.liveStatus).toBe('NOT VERIFIED');
    });

  it("keeps backups in a system bucket of the instance's own data_region, and no node is reachable without TLS", async () => {
    const { subject, fleet } = selfOperatedSubject();
    const a = subject.adapter;
    const created = await a.create(ctx, {
      engine: 'postgresql',
      version: '16',
      providerRegionId: 'sa-central',
      planRef: 'mock-db-s',
      storageGb: 20,
      name: 'x',
      network: { access: 'private' },
      tags: {},
      idempotencyToken: 't1',
    });
    const ref = created.providerRef!;
    expect(fleet.nodes.get(ref)?.tls).toBe(true);
    await a.backup(ctx, ref, { type: 'manual', idempotencyToken: 'b1' });
    expect(fleet.archive.objects).toHaveLength(1);
    expect(fleet.archive.objects[0]).toMatchObject({
      bucket: 'nz-sys-sa-central-backups',
      region: 'sa-central',
    });
  });

  it('refuses an unsupported major version and an unknown region/plan without touching compute', async () => {
    const { subject, compute } = selfOperatedSubject();
    const base = {
      engine: 'postgresql' as const,
      providerRegionId: 'sa-central',
      planRef: 'mock-db-s',
      storageGb: 20,
      name: 'x',
      network: { access: 'private' as const },
      tags: {},
      idempotencyToken: 't2',
    };
    const bad = await subject.adapter.create(ctx, { ...base, version: '9' });
    expect(bad.status).toBe('failed');
    expect(
      (await subject.adapter.create(ctx, { ...base, version: '16', providerRegionId: 'nowhere' }))
        .status,
    ).toBe('failed');
    expect(
      (await subject.adapter.create(ctx, { ...base, version: '16', planRef: 'nope' })).status,
    ).toBe('failed');
    expect(compute.billableCount()).toBe(0);
  });

  it('a node that was created but could not be bootstrapped is uncertain; replaying create completes it without a second node', async () => {
    const { subject, fleet, compute } = selfOperatedSubject();
    fleet.failOnce('bootstrap');
    const req = {
      engine: 'postgresql' as const,
      version: '16',
      providerRegionId: 'sa-central',
      planRef: 'mock-db-s',
      storageGb: 20,
      name: 'x',
      network: { access: 'private' as const },
      tags: {},
      idempotencyToken: 't3',
    };
    const first = await subject.adapter.create(ctx, req);
    expect(first.status).toBe('uncertain');
    const second = await subject.adapter.create(ctx, req);
    expect(['succeeded', 'accepted']).toContain(second.status);
    expect(compute.billableCount()).toBe(1);
  });
});

describe('node-agent protocol: signed, allow-listed, bound to one node, short-lived, single-use', () => {
  const key = fleetKey('proto');
  const t0 = Date.parse('2026-11-18T08:00:00Z');
  const mk = (now = t0) => new CommandVerifier(key, 'node-1', () => now);
  const ok = (cmd: (typeof AGENT_COMMANDS)[number], args: Record<string, unknown>, at = t0) =>
    signCommand(key, 'node-1', cmd, args, at);
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof AgentRefusedError) return e.refusal;
      throw e;
    }
    return 'accepted';
  };
  const resign = (c: SignedCommand, patch: Partial<SignedCommand>): SignedCommand => {
    const n = { ...c, ...patch };
    const body = JSON.stringify(
      {
        v: n.v,
        nodeRef: n.nodeRef,
        cmd: n.cmd,
        args: n.args,
        nonce: n.nonce,
        issuedAt: n.issuedAt,
        expiresAt: n.expiresAt,
      },
      (_k, x) =>
        x && typeof x === 'object' && !Array.isArray(x)
          ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
          : x,
    );
    return { ...n, sig: createHmac('sha256', key).update(body).digest('hex') };
  };

  it('accepts a valid command once; a replay of the same nonce is refused', () => {
    const v = mk();
    const c = ok('status', {});
    expect(v.verify(c)).toMatchObject({ cmd: 'status' });
    expect(refusal(() => v.verify(c))).toBe('replayed');
  });
  it('refuses a tampered command, a wrong key, a command for another node, and expired or future commands', () => {
    expect(
      refusal(() =>
        mk().verify({ ...ok('drop_role', { credentialId: 'a' }), args: { credentialId: 'b' } }),
      ),
    ).toBe('bad_signature');
    expect(
      refusal(() => mk().verify(signCommand(fleetKey('other'), 'node-1', 'status', {}, t0))),
    ).toBe('bad_signature');
    expect(refusal(() => mk().verify(signCommand(key, 'node-2', 'status', {}, t0)))).toBe(
      'wrong_node',
    );
    expect(refusal(() => mk(t0 + 61_000).verify(ok('status', {})))).toBe('expired');
    expect(refusal(() => mk(t0).verify(ok('status', {}, t0 + 60_000)))).toBe('not_yet_valid');
  });
  it('refuses any command that is not on the allow-list, even with a valid signature (no shell, no free-form SQL)', () => {
    for (const cmd of ['exec', 'shell', 'sql', 'psql', 'rm', 'ssh', '']) {
      const c = resign(ok('status', {}), { cmd });
      expect(
        refusal(() => mk().verify(c)),
        cmd,
      ).toBe('not_allowed');
    }
  });
  it('validates arguments strictly: unknown keys, injection characters, TLS off and public-style values are refused', () => {
    const boot = {
      engine: 'postgresql',
      version: '16',
      listen: 'private',
      tlsRequired: true,
      archiveBucket: 'nz-sys-sa-central-backups',
      dataRegion: 'sa-central',
    };
    expect(refusal(() => mk().verify(ok('bootstrap', boot)))).toBe('accepted');
    expect(refusal(() => mk().verify(ok('bootstrap', { ...boot, tlsRequired: false })))).toBe(
      'bad_arguments',
    );
    expect(refusal(() => mk().verify(ok('bootstrap', { ...boot, extra: 'x' })))).toBe(
      'bad_arguments',
    );
    expect(refusal(() => mk().verify(ok('bootstrap', { ...boot, listen: 'public' })))).toBe(
      'bad_arguments',
    );
    for (const role of [
      "app'; DROP TABLE users;--",
      'a b',
      'app$(id)',
      '`id`',
      '../etc',
      'a\nb',
      'x'.repeat(70),
    ])
      expect(
        refusal(() =>
          mk().verify(ok('create_role', { role, credentialId: 'c1', keepPrevious: false })),
        ),
        role,
      ).toBe('bad_arguments');
    expect(
      refusal(() =>
        mk().verify(ok('create_role', { role: 'app', credentialId: 'c1', keepPrevious: false })),
      ),
    ).toBe('accepted');
  });
  it('the allow-list is exactly the documented set', () => {
    expect([...AGENT_COMMANDS].sort()).toEqual([
      'apply_patch',
      'base_backup',
      'bootstrap',
      'create_role',
      'drop_role',
      'integrity_check',
      'list_backups',
      'list_roles',
      'restore_in_place',
      'restore_new',
      'status',
      'usage',
    ]);
  });
});
