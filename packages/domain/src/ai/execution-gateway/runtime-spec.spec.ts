import { describe, expect, it } from 'vitest';
import {
  ACCEPTABLE_RUNTIME_CLASSES,
  RefusingRuntime,
  buildRuntimeSpec,
  decideExec,
  validateRuntimeSpec,
  type RuntimeSpec,
} from './index';

const d = decideExec(
  { orgId: 'o', runId: 'r1', profile: 'install-deps' },
  { orgId: 'o', runId: 'r1', enabledProfiles: ['install-deps'], projectScripts: [] },
);
if (!d.allowed) throw new Error('decision');
const base = (over: Partial<Parameters<typeof buildRuntimeSpec>[0]> = {}) =>
  buildRuntimeSpec({
    decision: d,
    orgId: 'o',
    runId: 'r1',
    runtimeClass: 'gvisor-runsc',
    image: 'registry.nuzm.internal/sandbox-node:22',
    egressAllow: ['registry.npmjs.org'],
    ...over,
  });

describe('buildRuntimeSpec / validateRuntimeSpec', () => {
  it('the spec built from a decision satisfies the baseline', () => {
    const s = base();
    expect(validateRuntimeSpec(s)).toEqual([]);
    expect(s).toMatchObject({
      privileged: false,
      readOnlyRootFs: true,
      capabilitiesDrop: ['ALL'],
      seccomp: 'default-deny',
      workspaceId: 'ws-r1',
      cwd: '/work',
      network: { class: 'registry-only', ownNamespace: true, egressProxyOnly: true },
      egressAllow: [{ host: 'registry.npmjs.org', port: 443 }],
      limits: { swapMb: 0 },
    });
    expect(s.user.uid).not.toBe(0);
  });
  it('carries the decision argv and env unchanged and nothing else', () => {
    const s = base();
    expect(s.argv).toEqual(d.argv);
    expect(s.env).toEqual(d.env);
  });
  it('every acceptable class passes; plain runc and unknown classes are refused', () => {
    for (const c of ACCEPTABLE_RUNTIME_CLASSES)
      expect(validateRuntimeSpec(base({ runtimeClass: c }))).toEqual([]);
    for (const c of ['runc', 'docker', '', 'none'])
      expect(validateRuntimeSpec(base({ runtimeClass: c }))).toContain(
        'runtime_class_not_isolating',
      );
  });
  const weaken: [string, (s: RuntimeSpec) => RuntimeSpec, string][] = [
    ['privileged', (s) => ({ ...s, privileged: true }), 'privileged'],
    ['host network', (s) => ({ ...s, hostNetwork: true }), 'host_network'],
    ['host pid', (s) => ({ ...s, hostPid: true }), 'host_pid'],
    ['host ipc', (s) => ({ ...s, hostIpc: true }), 'host_ipc'],
    ['writable root', (s) => ({ ...s, readOnlyRootFs: false }), 'root_fs_writable'],
    ['new privileges', (s) => ({ ...s, noNewPrivileges: false }), 'new_privileges_allowed'],
    ['caps kept', (s) => ({ ...s, capabilitiesDrop: ['NET_RAW'] }), 'capabilities_not_dropped'],
    ['seccomp off', (s) => ({ ...s, seccomp: 'unconfined' }), 'seccomp_unconfined'],
    ['root user', (s) => ({ ...s, user: { uid: 0, gid: 0 } }), 'runs_as_root'],
    [
      'shared netns',
      (s) => ({ ...s, network: { ...s.network, ownNamespace: false } }),
      'network_namespace_shared',
    ],
    [
      'no proxy',
      (s) => ({ ...s, network: { ...s.network, egressProxyOnly: false } }),
      'egress_not_via_proxy',
    ],
    [
      'docker socket',
      (s) => ({
        ...s,
        mounts: [
          ...s.mounts,
          { source: 'workspace', target: '/var/run/docker.sock', readOnly: false },
        ],
      }),
      'mount_target_not_allowed',
    ],
    [
      'host root',
      (s) => ({
        ...s,
        mounts: [...s.mounts, { source: 'workspace', target: '/', readOnly: false }],
      }),
      'mount_target_not_allowed',
    ],
    [
      '/proc',
      (s) => ({
        ...s,
        mounts: [...s.mounts, { source: 'workspace', target: '/proc', readOnly: false }],
      }),
      'mount_target_not_allowed',
    ],
    [
      'writable toolchain',
      (s) => ({
        ...s,
        mounts: s.mounts.map((m) => (m.source === 'toolchain' ? { ...m, readOnly: false } : m)),
      }),
      'toolchain_writable',
    ],
    [
      'no scratch',
      (s) => ({ ...s, mounts: s.mounts.filter((m) => m.source !== 'scratch') }),
      'no_writable_scratch',
    ],
    [
      'no memory limit',
      (s) => ({ ...s, limits: { ...s.limits, memoryMb: 0 } }),
      'limit_missing_memoryMb',
    ],
    ['no pids limit', (s) => ({ ...s, limits: { ...s.limits, pids: NaN } }), 'limit_missing_pids'],
    ['swap', (s) => ({ ...s, limits: { ...s.limits, swapMb: 512 } }), 'swap_allowed'],
    ['LD_PRELOAD', (s) => ({ ...s, env: { ...s.env, LD_PRELOAD: '/x' } }), 'env_invalid'],
    [
      'other run workspace',
      (s) => ({ ...s, workspaceId: 'ws-other' }),
      'workspace_not_bound_to_run',
    ],
    ['empty argv', (s) => ({ ...s, argv: [] }), 'argv_empty'],
  ];
  it.each(weaken)('refuses a weaker spec: %s', (_n, fn, reason) => {
    expect(validateRuntimeSpec(fn(base()))).toContain(reason);
  });
});

describe('RefusingRuntime', () => {
  it('starts nothing, reports itself unhealthy and non-isolating', async () => {
    const r = new RefusingRuntime();
    expect(r.isolation).toBe('none');
    await expect(r.start()).rejects.toThrow(/D-21/);
    await expect(r.kill()).rejects.toThrow();
    expect(await r.health()).toMatchObject({ ok: false, freeSlots: 0 });
  });

  describe('default-deny egress allowlist (NEEDS A REAL NODE to be enforced; here it is validated data)', () => {
    it('registry-only without an allowlist, with an over-long one, or with a bad entry is refused', () => {
      expect(validateRuntimeSpec(base({ egressAllow: [] }))).toContain('egress_allowlist_empty');
      expect(validateRuntimeSpec(base({ egressAllow: undefined }))).toContain(
        'egress_allowlist_empty',
      );
      const many = Array.from({ length: 9 }, (_, i) => `r${i}.example.org`);
      expect(validateRuntimeSpec(base({ egressAllow: many }))).toContain(
        'egress_allowlist_too_long',
      );
      for (const bad of [
        '10.0.0.1',
        '169.254.169.254',
        '[::1]',
        '*.npmjs.org',
        'localhost',
        'registry',
        'npm.internal',
        'a.local',
        'Registry.NPMJS.org',
        'user@registry.npmjs.org',
        'registry.npmjs.org:443',
        'registry.npmjs.org/x',
        '1.2.3.4.5',
      ])
        expect(validateRuntimeSpec(base({ egressAllow: [bad] })), bad).toContain(
          'egress_allow_entry_invalid',
        );
    });
    it('a spec weakened after the build is refused too (a non-443 port; a list on network none)', () => {
      const s = base();
      expect(
        validateRuntimeSpec({
          ...s,
          egressAllow: [{ host: 'registry.npmjs.org', port: 80 as never }],
        }),
      ).toContain('egress_allow_entry_invalid');
      const none = decideExec(
        { orgId: 'o', runId: 'r1', profile: 'typecheck' },
        { orgId: 'o', runId: 'r1', enabledProfiles: ['typecheck'], projectScripts: [] },
      );
      if (!none.allowed) throw new Error('decision');
      const n = buildRuntimeSpec({
        decision: none,
        orgId: 'o',
        runId: 'r1',
        runtimeClass: 'gvisor-runsc',
        image: 'x',
        egressAllow: ['registry.npmjs.org'],
      });
      expect(n.egressAllow).toEqual([]); // class none ignores the input
      expect(validateRuntimeSpec(n)).toEqual([]);
      expect(
        validateRuntimeSpec({ ...n, egressAllow: [{ host: 'registry.npmjs.org', port: 443 }] }),
      ).toContain('egress_allow_on_network_none');
    });
  });
});
