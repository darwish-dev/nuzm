import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  link,
  chmod,
  lstat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executionGateway as eg } from '@nuzm/domain';
import { AgentStartRefused, assembleAgent } from './agent';
import {
  CommandRefused,
  DEFAULT_BINARIES,
  NodeCommandRunner,
  RecordingCommandRunner,
  RefusedCommandRunner,
} from './command-runner';
import { parseAgentConfig } from './config';
import {
  forceRemoveTree,
  listOutputs,
  readFileConfined,
  UnsafePath,
  writeFileConfined,
} from './fs-safe';
import { treeDigest, verifyImages } from './image';
import { buildOciBundle, SECCOMP_ALLOW, SECCOMP_NEVER } from './oci';
import { planNetwork } from './network';
import { inodeCapFor, XfsProjectQuotaDriver } from './quota';
import { parseRunscList, parseRunscStats, RunscLauncher, runscGlobalFlags } from './runsc-launcher';
import { createAgentRig } from './testing';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nuzm-agent-unit-'));
});
afterEach(async () => {
  await forceRemoveTree(dir);
});

describe('confined file operations', () => {
  const opts = { dirMode: 0o777, fileMode: 0o666 };
  it('writes new files inside the root only; refuses traversal, absolute paths, overwrite and a symlinked parent', async () => {
    await writeFileConfined(dir, 'a/b/c.txt', 'x', opts);
    expect(await readFile(join(dir, 'a/b/c.txt'), 'utf8')).toBe('x');
    for (const bad of ['../x', '/etc/x', 'a/../../x', 'a//b', ''])
      await expect(writeFileConfined(dir, bad, 'x', opts)).rejects.toThrow(UnsafePath);
    await expect(writeFileConfined(dir, 'a/b/c.txt', 'y', opts)).rejects.toThrow(UnsafePath); // no overwrite
    await mkdir(join(dir, 'outside'));
    await symlink(join(dir, 'outside'), join(dir, 'ln'));
    await expect(writeFileConfined(dir, 'ln/pwn.txt', 'x', opts)).rejects.toThrow(UnsafePath);
    expect(await lstat(join(dir, 'outside')).then(() => true)).toBe(true);
    await expect(readFile(join(dir, 'outside/pwn.txt'))).rejects.toThrow();
  });
  it('a planted symlink as the final component is not followed, on write or read', async () => {
    await writeFile(join(dir, 'secret.txt'), 'TOP-SECRET');
    await symlink(join(dir, 'secret.txt'), join(dir, 'leak'));
    await expect(writeFileConfined(dir, 'leak', 'x', opts)).rejects.toThrow(UnsafePath);
    await expect(readFileConfined(dir, 'leak', 100)).rejects.toThrow(UnsafePath);
  });
  it('reads only a regular, singly-linked file within the byte cap', async () => {
    await writeFile(join(dir, 'f.txt'), 'hello');
    expect(await readFileConfined(dir, 'f.txt', 5)).toBe('hello');
    await expect(readFileConfined(dir, 'f.txt', 4)).rejects.toMatchObject({ code: 'too_large' });
    await link(join(dir, 'f.txt'), join(dir, 'g.txt'));
    await expect(readFileConfined(dir, 'f.txt', 100)).rejects.toMatchObject({
      code: 'not_a_regular_file',
    });
    await expect(readFileConfined(dir, 'nope', 100)).rejects.toMatchObject({ code: 'not_found' });
    await mkdir(join(dir, 'd'));
    await expect(readFileConfined(dir, 'd', 100)).rejects.toMatchObject({
      code: 'not_a_regular_file',
    });
  });
  it('lists output roots reporting symlinks and hard links, never following them, and bounds the walk', async () => {
    await mkdir(join(dir, 'dist/sub'), { recursive: true });
    await writeFile(join(dir, 'dist/a.js'), 'a');
    await writeFile(join(dir, 'dist/sub/b.js'), 'bb');
    await symlink('/etc/passwd', join(dir, 'dist/l'));
    await link(join(dir, 'dist/a.js'), join(dir, 'dist/a2.js'));
    await writeFile(join(dir, 'other.txt'), 'not listed');
    const { files, truncated } = await listOutputs(dir, ['dist', 'build']);
    const k = Object.fromEntries(files.map((f) => [f.path, f.kind]));
    expect(k).toMatchObject({
      dist: 'dir',
      'dist/sub': 'dir',
      'dist/sub/b.js': 'file',
      'dist/l': 'symlink',
      'dist/a.js': 'hardlink',
      'dist/a2.js': 'hardlink',
    });
    expect(k['other.txt']).toBeUndefined();
    expect(truncated).toBe(false);
    expect((await listOutputs(dir, ['dist'], 2)).truncated).toBe(true);
  });
  it('removes a tree a hostile run made unremovable and reports false only if it truly remains', async () => {
    await mkdir(join(dir, 't/locked'), { recursive: true });
    await writeFile(join(dir, 't/locked/f'), 'x');
    await chmod(join(dir, 't/locked'), 0o000);
    await symlink('/', join(dir, 't/rootlink')); // must not be followed
    expect(await forceRemoveTree(join(dir, 't'))).toBe(true);
    expect(await lstat(join(dir, 't')).catch(() => null)).toBeNull();
    expect(await forceRemoveTree(join(dir, 'absent'))).toBe(true);
  });
});

describe('agent configuration (fail closed)', () => {
  const base = () => ({
    nodeId: 'node-1',
    endpointId: 'ep-node-1',
    runtimeClass: 'gvisor-runsc',
    launcher: 'runsc',
    listen: { host: '10.0.0.5', port: 8443 },
    metrics: { host: '127.0.0.1', port: 9100 },
    tls: {
      keyFile: '/etc/nuzm/k.pem',
      certFile: '/etc/nuzm/c.pem',
      caFile: '/etc/nuzm/ca.pem',
      clientFingerprints: ['a'.repeat(64)],
    },
    trustedControlKeys: {
      cp1: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----',
    },
    workspaceRoot: '/var/lib/nuzm/workspaces',
    stateDir: '/var/lib/nuzm/state',
    auditFile: '/var/log/nuzm/agent.jsonl',
    toolchainDir: '/opt/nuzm/toolchain',
    images: { [`sha256:${'a'.repeat(64)}`]: '/opt/nuzm/images/a' },
    egress: { proxyAddr: '10.200.0.1:3128', allowHosts: ['registry.npmjs.org'] },
    runsc: { path: '/usr/local/bin/runsc', rootDir: '/run/nuzm/runsc', platform: 'systrap' },
  });
  const errs = (o: Record<string, unknown>) => {
    const r = parseAgentConfig({ ...base(), ...o });
    return r.ok ? [] : r.errors;
  };
  it('accepts a complete real-node config and applies the documented defaults', () => {
    const r = parseAgentConfig(base());
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.config).toMatchObject({
        quota: 'xfs-project',
        maxSlots: 4,
        sandboxUid: 10001,
        outputRoots: ['dist', 'build', 'out', 'coverage', 'reports'],
      });
  });
  it.each([
    ['a wildcard listener', { listen: { host: '0.0.0.0', port: 8443 } }, 'listen_wildcard_refused'],
    ['an unknown member', { debug: true }, 'unknown_member:debug'],
    [
      'the real launcher with a measuring-only quota',
      { quota: 'accounting' },
      'real_launcher_requires_xfs_project_quota',
    ],
    [
      'a simulated launcher on a routable address',
      { launcher: 'simulated', quota: 'accounting' },
      'simulated_launcher_requires_loopback_listener',
    ],
    ['a non-gVisor class', { runtimeClass: 'runc' }, 'runtimeClass_not_gvisor_runsc'],
    [
      'a metrics listener off loopback',
      { metrics: { host: '0.0.0.0', port: 9100 } },
      'metrics_must_be_loopback',
    ],
    [
      'no pinned client fingerprints',
      { tls: { ...base().tls, clientFingerprints: [] } },
      'tls_client_fingerprints_required',
    ],
    ['no trusted control key', { trustedControlKeys: {} }, 'trusted_control_keys_required'],
    [
      'a private key where a public key belongs',
      { trustedControlKeys: { cp1: `${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\nx` } },
      'trusted_control_key_invalid:cp1',
    ],
    [
      'an image tag instead of a digest',
      { images: { 'node:22': '/opt/x' } },
      'image_entry_invalid',
    ],
    ['a relative path', { workspaceRoot: 'workspaces' }, 'workspaceRoot_invalid'],
    ['a path with ..', { stateDir: '/var/../etc' }, 'stateDir_invalid'],
    [
      'an egress host that is an IP',
      { egress: { proxyAddr: '10.200.0.1:3128', allowHosts: ['169.254.169.254'] } },
      'egress_allowHosts_invalid',
    ],
    ['a sandbox uid in the system range', { sandboxUid: 0 }, 'sandbox_ids_invalid'],
  ])('refuses %s', (_n, over, code) =>
    expect(errs(over as Record<string, unknown>)).toContain(code),
  );
  it('a real launcher refuses to assemble anywhere but the attested Linux node (R5)', async () => {
    const r = parseAgentConfig(base());
    if (!r.ok) throw new Error('config');
    await expect(
      assembleAgent(r.config, {
        platform: 'darwin',
        verifiedImages: { [`sha256:${'a'.repeat(64)}`]: '/x' },
      }),
    ).rejects.toThrow(AgentStartRefused);
    await expect(
      assembleAgent(r.config, {
        platform: 'darwin',
        verifiedImages: { [`sha256:${'a'.repeat(64)}`]: '/x' },
      }),
    ).rejects.toThrow(/not_the_attested_node:not_linux/);
  });
  it('an image whose rootfs does not hash to its digest stops the agent', async () => {
    const r = parseAgentConfig({
      ...base(),
      launcher: 'simulated',
      quota: 'accounting',
      listen: { host: '127.0.0.1', port: 8443 },
      images: { [`sha256:${'a'.repeat(64)}`]: dir },
    });
    if (!r.ok) throw new Error(r.errors.join());
    await writeFile(join(dir, 'f'), 'x');
    await expect(assembleAgent(r.config, { runner: new RefusedCommandRunner() })).rejects.toThrow(
      /image_mismatch/,
    );
  });
});

describe('the only door to a process', () => {
  const id = (nodeId = 'node-1', rc = 'gvisor-runsc') =>
    JSON.stringify({ nodeId, runtimeClass: rc });
  const proof = (o: Partial<{ platform: string; read: () => Promise<string> }> = {}) => ({
    platform: o.platform ?? 'linux',
    nodeId: 'node-1',
    readFile: o.read ?? (async () => id()),
  });
  it('refuses on a Mac, without an identity file, for another node and for another runtime class', async () => {
    await expect(NodeCommandRunner.create(proof({ platform: 'darwin' }))).rejects.toMatchObject({
      code: 'not_linux',
    });
    await expect(
      NodeCommandRunner.create(
        proof({
          read: async () => {
            throw new Error('ENOENT');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'node_identity_file_missing' });
    await expect(
      NodeCommandRunner.create(proof({ read: async () => id('node-2') })),
    ).rejects.toMatchObject({ code: 'node_identity_mismatch' });
    await expect(
      NodeCommandRunner.create(proof({ read: async () => id('node-1', 'runc') })),
    ).rejects.toMatchObject({ code: 'node_runtime_class_mismatch' });
  });
  it('on the attested node it starts only allow-listed absolute binaries, as argv, without a shell and with a scrubbed environment', async () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const fakeSpawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      const handlers: Record<string, (...a: unknown[]) => void> = {};
      const child = {
        stdout: { on() {} },
        stderr: { on() {} },
        stdin: { end() {} },
        pid: 1,
        kill() {},
        on(ev: string, f: (...a: unknown[]) => void) {
          handlers[ev] = f;
          if (ev === 'close') queueMicrotask(() => f(0, null));
          return child;
        },
      };
      return child;
    }) as never;
    const runner = await NodeCommandRunner.create(proof(), DEFAULT_BINARIES, fakeSpawn);
    await runner.run([DEFAULT_BINARIES.ip, 'netns', 'add', 'nz-1']);
    expect(calls[0]).toMatchObject({ cmd: '/usr/sbin/ip', args: ['netns', 'add', 'nz-1'] });
    expect(calls[0]!.opts.shell).toBe(false);
    expect(Object.keys(calls[0]!.opts.env as object).sort()).toEqual(['LANG', 'PATH']);
    for (const bad of [
      ['/bin/sh', '-c', 'id'],
      ['sh'],
      ['ip', 'link'],
      ['/usr/bin/curl', 'http://x'],
      ['runsc'],
      [],
    ])
      await expect(runner.run(bad as string[]), bad.join(' ')).rejects.toBeInstanceOf(
        CommandRefused,
      );
    await expect(runner.run([DEFAULT_BINARIES.ip, 'a\0b'])).rejects.toMatchObject({
      code: 'argv_invalid',
    });
    expect(calls).toHaveLength(1);
  });
  it('the recording and refusing runners start nothing', async () => {
    const rec = new RecordingCommandRunner();
    await rec.run(['/usr/local/bin/runsc', '--version']);
    expect(rec.argvs()).toEqual([['/usr/local/bin/runsc', '--version']]);
    await expect(new RefusedCommandRunner().run()).rejects.toBeInstanceOf(CommandRefused);
    expect(() => new RefusedCommandRunner().spawn()).toThrow(CommandRefused);
  });
});

const SPEC = (net: 'none' | 'registry-only' = 'none'): eg.RuntimeSpec =>
  eg.buildRuntimeSpec({
    decision: {
      argv: ['npm', 'test', '--silent'],
      cwd: 'pkg',
      env: { ...eg.EXEC_ENV },
      limits: {
        cpuSeconds: 120,
        wallSeconds: 180,
        memoryMb: 1024,
        pids: 128,
        outputKb: 256,
        diskMb: 512,
      },
      network: net,
    },
    orgId: 'org-1',
    runId: 'run-1',
    runtimeClass: 'gvisor-runsc',
    image: `sha256:${'a'.repeat(64)}`,
    egressAllow: net === 'registry-only' ? eg.registryHosts() : [],
  });
describe('OCI bundle for gVisor', () => {
  const bundle = (net: 'none' | 'registry-only' = 'none') =>
    buildOciBundle({
      spec: SPEC(net),
      rootfs: '/img/a',
      workDir: '/ws/w',
      scratchDir: '/ws/s',
      toolchainDir: '/opt/tc',
      netnsPath: net === 'none' ? undefined : '/var/run/netns/nz-1',
      cgroupsPath: '/nuzm/h1',
    }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- the OCI document is deliberately inspected untyped
  it('encodes the hardening the spec asks for', () => {
    const b = bundle();
    expect(b.root).toEqual({ path: '/img/a', readonly: true });
    expect(b.process).toMatchObject({
      terminal: false,
      noNewPrivileges: true,
      cwd: '/work/pkg',
      args: ['npm', 'test', '--silent'],
      user: { uid: 10001, gid: 10001 },
    });
    for (const set of Object.values(b.process.capabilities)) expect(set).toEqual([]);
    expect(b.process.env.sort()).toEqual(
      Object.entries(eg.EXEC_ENV)
        .map(([k, v]) => `${k}=${v}`)
        .sort(),
    );
    expect(b.linux.resources.memory).toEqual({
      limit: 1024 * 1024 * 1024,
      swap: 1024 * 1024 * 1024,
      disableOOMKiller: false,
    }); // swap == limit: no swap
    expect(b.linux.resources.pids.limit).toBe(128);
    expect(b.linux.namespaces.map((n: { type: string }) => n.type).sort()).toEqual([
      'ipc',
      'mount',
      'network',
      'pid',
      'uts',
    ]);
    expect(b.linux.seccomp.defaultAction).toBe('SCMP_ACT_ERRNO');
    expect(b.linux.maskedPaths).toContain('/proc/kcore');
  });
  it('mounts exactly workspace rw, scratch rw+noexec and toolchain ro, plus proc/dev/tmp; nothing from the host root', () => {
    const m = bundle().mounts as { destination: string; source: string; options: string[] }[];
    expect(m.map((x) => x.destination).sort()).toEqual([
      '/dev',
      '/proc',
      '/scratch',
      '/tmp',
      '/toolchain',
      '/work',
    ]);
    expect(m.find((x) => x.destination === '/toolchain')!.options).toContain('ro');
    expect(m.find((x) => x.destination === '/scratch')!.options).toEqual(
      expect.arrayContaining(['rw', 'noexec', 'nosuid', 'nodev']),
    );
    expect(m.find((x) => x.destination === '/work')!.options).toEqual(
      expect.arrayContaining(['rw', 'nosuid', 'nodev']),
    );
    for (const x of m)
      expect(['/', '/etc', '/root', '/var/run/docker.sock', '/run/containerd']).not.toContain(
        x.source,
      );
  });
  it('joins a pre-wired namespace only for registry-only, and a fresh empty one for none', () => {
    expect(
      bundle('none').linux.namespaces.find((n: { type: string }) => n.type === 'network'),
    ).toEqual({ type: 'network' });
    expect(
      bundle('registry-only').linux.namespaces.find((n: { type: string }) => n.type === 'network'),
    ).toEqual({ type: 'network', path: '/var/run/netns/nz-1' });
  });
  it('the seccomp allow-list never contains an attack-surface syscall, and clone cannot create namespaces', () => {
    const allow = new Set(SECCOMP_ALLOW);
    expect(SECCOMP_NEVER.filter((s) => allow.has(s))).toEqual([]);
    expect(allow.size).toBe(SECCOMP_ALLOW.length); // no duplicates
    const sc = bundle().linux.seccomp.syscalls;
    expect(sc.find((s: { names: string[] }) => s.names[0] === 'clone').args[0]).toMatchObject({
      op: 'SCMP_CMP_MASKED_EQ',
      value: 0,
      valueTwo: 0x7e020000,
    });
    expect(sc.find((s: { names: string[] }) => s.names[0] === 'clone3').errnoRet).toBe(38);
  });
});

describe('network plan', () => {
  const bin = { ip: DEFAULT_BINARIES.ip };
  it('class none wires nothing and runs runsc with --network=none', () => {
    expect(planNetwork(1, 'none', '10.200.0.1:3128', bin)).toEqual({
      setup: [],
      teardown: [],
      netnsName: null,
      netnsPath: null,
      runscNetwork: 'none',
    });
  });
  it('registry-only: one namespace per slot, one /32 route to the proxy, no default route, no firewall edits, full teardown', () => {
    const p = planNetwork(3, 'registry-only', '10.200.0.1:3128', bin);
    const flat = p.setup.map((c) => c.join(' '));
    expect(p.netnsName).toBe('nz-3');
    expect(p.runscNetwork).toBe('sandbox');
    expect(flat).toContain('/usr/sbin/ip -n nz-3 route add 10.200.0.1/32 via 10.201.3.1 dev vc-3');
    expect(flat.some((c) => /default|0\.0\.0\.0\/0/.test(c))).toBe(false);
    expect(flat.some((c) => /nft|iptables/.test(c))).toBe(false);
    expect(p.setup.every((c) => c[0] === bin.ip)).toBe(true);
    expect(p.teardown.map((c) => c.join(' '))).toEqual([
      '/usr/sbin/ip link del vh-3',
      '/usr/sbin/ip netns del nz-3',
    ]);
    expect(planNetwork(4, 'registry-only', '10.200.0.1:3128', bin).netnsName).not.toBe(p.netnsName);
  });
  it('refuses a bad slot or proxy address', () => {
    expect(() => planNetwork(0, 'registry-only', '10.200.0.1:3128', bin)).toThrow();
    expect(() => planNetwork(1, 'registry-only', 'proxy.local:3128', bin)).toThrow(
      'proxy_addr_invalid',
    );
  });
});

describe('RunscLauncher (recording runner: nothing is started)', () => {
  const mk = async (net: 'none' | 'registry-only' = 'none', maxSlots = 2) => {
    const runner = new RecordingCommandRunner();
    const stateDir = join(dir, 'state');
    await mkdir(stateDir);
    const l = new RunscLauncher({
      runner,
      binaries: DEFAULT_BINARIES,
      runscRoot: '/run/nuzm/runsc',
      stateDir,
      maxSlots,
      proxyAddr: '10.200.0.1:3128',
      platform: 'systrap',
    });
    const req = (h: string) => ({
      spec: SPEC(net),
      handle: h,
      workDir: '/ws/w',
      scratchDir: '/ws/s',
      rootfs: '/img/a',
      toolchainDir: '/opt/tc',
      maxOutputBytes: 1000,
    });
    return { runner, l, req, stateDir };
  };
  it('starts `runsc run` with the global flags, the bundle and a prefixed container id; writes the bundle', async () => {
    const { runner, l, req, stateDir } = await mk();
    const launched = await l.launch(req('h1'));
    const spawned = runner.calls.find((c) => c.spawned)!.argv;
    expect(spawned[0]).toBe('/usr/local/bin/runsc');
    expect(spawned).toEqual(
      expect.arrayContaining([
        '--platform=systrap',
        '--network=none',
        '--root',
        '/run/nuzm/runsc',
        'run',
        '--bundle',
        join(stateDir, 'bundles/h1'),
        'nz-h1',
      ]),
    );
    expect(spawned.indexOf('run')).toBeGreaterThan(spawned.indexOf('--network=none')); // global flags before the subcommand
    const cfg = JSON.parse(await readFile(join(stateDir, 'bundles/h1/config.json'), 'utf8'));
    expect(cfg.root.readonly).toBe(true);
    expect(runscGlobalFlags({ root: 'r', platform: 'systrap', network: 'none' })).toContain(
      '--network=none',
    );
    runner.spawnedProcess().exit(0);
    expect((await launched.done).exitCode).toBe(0);
    await launched.cleanup();
  });
  it('captures output capped at the source and kills a flood', async () => {
    const { runner, l, req } = await mk();
    const launched = await l.launch(req('h2'));
    const p = runner.spawnedProcess();
    p.emit('out', 'a'.repeat(600));
    p.emit('out', 'b'.repeat(600)); // second chunk would pass the cap: dropped
    p.emit('out', 'c'.repeat(8000)); // past floodFactor x cap: the run is killed
    const r = await launched.done;
    expect(r.stdout.length).toBe(600);
    expect(r.truncated).toBe(true);
    expect(r.endedBy).toBe('output_flood');
    expect(runner.argvs().some((a) => a.includes('kill') && a.includes('SIGKILL'))).toBe(true);
    await launched.cleanup();
  });
  it('kill soft sends SIGTERM to the whole sandbox, hard SIGKILL; cleanup deletes the container, the network and the bundle, and frees the slot', async () => {
    const { runner, l, req, stateDir } = await mk('registry-only', 1);
    const launched = await l.launch(req('h3'));
    await expect(l.launch(req('h4'))).rejects.toMatchObject({ code: 'no_capacity' });
    await launched.kill('soft');
    await launched.kill('hard');
    const kills = runner.argvs().filter((a) => a.includes('kill'));
    expect(kills[0]).toEqual([
      '/usr/local/bin/runsc',
      '--root',
      '/run/nuzm/runsc',
      'kill',
      '--all',
      'nz-h3',
      'SIGTERM',
    ]);
    expect(kills[1]).toContain('SIGKILL');
    await launched.cleanup();
    const flat = runner.argvs().map((a) => a.join(' '));
    expect(flat).toContain('/usr/local/bin/runsc --root /run/nuzm/runsc delete --force nz-h3');
    expect(flat).toContain('/usr/sbin/ip link del vh-1');
    expect(flat).toContain('/usr/sbin/ip netns del nz-1');
    expect(await lstat(join(stateDir, 'bundles/h3')).catch(() => null)).toBeNull();
    const again = await l.launch(req('h5')); // the slot is free again
    await again.cleanup();
  });
  it('a failed network setup is torn down, leaves no bundle and releases the slot', async () => {
    const { runner, l, req, stateDir } = await mk('registry-only', 1);
    runner.on((a) => a.includes('veth'), { code: 2, stderr: 'boom' });
    await expect(l.launch(req('h6'))).rejects.toMatchObject({ code: 'platform_refused' });
    expect(runner.argvs().some((a) => a.includes('del'))).toBe(true);
    expect(await lstat(join(stateDir, 'bundles/h6')).catch(() => null)).toBeNull();
    // slot released: a later launch with a healthy runner works
    const ok = await new RunscLauncher({
      runner: new RecordingCommandRunner(),
      binaries: DEFAULT_BINARIES,
      runscRoot: '/r',
      stateDir,
      maxSlots: 1,
      proxyAddr: '10.200.0.1:3128',
      platform: 'systrap',
    }).launch(req('h7'));
    await ok.cleanup();
  });
  it('a cleanup that cannot delete the container or the network THROWS (the node is then quarantined), never silently succeeds', async () => {
    const { runner, l, req } = await mk();
    const launched = await l.launch(req('h8'));
    runner.on((a) => a.includes('delete'), { code: 1, stderr: 'device busy' });
    await expect(launched.cleanup()).rejects.toThrow('destroy_failed');
  });
  it('lists and kills stray sandboxes by prefix; parses stats and list output defensively', async () => {
    const { runner, l } = await mk();
    runner.on((a) => a.includes('list'), {
      stdout: JSON.stringify([{ id: 'nz-h-old' }, { id: 'nz-h-live' }, { id: 'someone-else' }]),
    });
    expect(await l.listStray(new Set(['h-live']))).toEqual(['nz-h-old']);
    expect(await l.killStray(['nz-h-old', 'not-ours'])).toBe(1);
    expect(parseRunscList('garbage')).toEqual([]);
    expect(
      parseRunscStats(
        JSON.stringify({
          data: {
            cpu: { usage: { total: 2e9 } },
            memory: { usage: { max: 3 * 1024 * 1024 } },
            pids: { current: 7 },
          },
        }),
        5,
        0,
      ),
    ).toEqual({ cpuSeconds: 2, memoryMb: 3, pids: 7, diskMb: 0, outputBytes: 5 });
    expect(parseRunscStats('nope', 0, 0)).toBeNull();
    expect(
      parseRunscStats(JSON.stringify({ data: { cpu: { usage: { total: 'x' } } } }), 0, 0),
    ).toBeNull();
  });
});

describe('image identity', () => {
  it('the tree digest is deterministic, content- and mode-sensitive, ignores mtime, and a device-like surprise changes it', async () => {
    await mkdir(join(dir, 'a/bin'), { recursive: true });
    await writeFile(join(dir, 'a/bin/node'), 'x', { mode: 0o755 });
    await symlink('bin/node', join(dir, 'a/n'));
    const d1 = await treeDigest(join(dir, 'a'));
    expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await treeDigest(join(dir, 'a'))).toBe(d1);
    await writeFile(join(dir, 'a/bin/node'), 'y', { mode: 0o755 });
    expect(await treeDigest(join(dir, 'a'))).not.toBe(d1);
    await writeFile(join(dir, 'a/bin/node'), 'x', { mode: 0o755 });
    expect(await treeDigest(join(dir, 'a'))).toBe(d1);
    await chmod(join(dir, 'a/bin/node'), 0o777);
    expect(await treeDigest(join(dir, 'a'))).not.toBe(d1);
  });
  it('verifyImages accepts the matching digest and reports every mismatch', async () => {
    await mkdir(join(dir, 'b'));
    await writeFile(join(dir, 'b/f'), 'x');
    const good = await treeDigest(join(dir, 'b'));
    const bad = `sha256:${'0'.repeat(64)}`;
    const r = await verifyImages({
      [good]: join(dir, 'b'),
      [bad]: join(dir, 'b'),
      [`sha256:${'1'.repeat(64)}`]: join(dir, 'missing'),
    });
    expect(Object.keys(r.verified)).toEqual([good]);
    expect(r.mismatched).toHaveLength(2);
  });
});

describe('disk quota driver', () => {
  const mk = () => {
    const runner = new RecordingCommandRunner();
    return {
      runner,
      q: new XfsProjectQuotaDriver(
        runner,
        DEFAULT_BINARIES.xfsQuota,
        '/var/lib/nuzm/workspaces',
        join(dir, 'projects.json'),
      ),
    };
  };
  it('sets a hard block and inode limit on a project for the workspace directory', async () => {
    const { runner, q } = mk();
    await q.apply('ws-r1', '/var/lib/nuzm/workspaces/ws-r1', 512);
    const cmds = runner.argvs().map((a) => a[3]);
    expect(cmds[0]).toBe('project -s -p /var/lib/nuzm/workspaces/ws-r1 10000');
    expect(cmds[1]).toBe(`limit -p bhard=512m bsoft=512m ihard=${inodeCapFor(512)} 10000`);
    await q.apply('ws-r2', '/var/lib/nuzm/workspaces/ws-r2', 64);
    expect(
      runner
        .argvs()
        .map((a) => a[3])
        .some((c) => c!.startsWith('project -s -p /var/lib/nuzm/workspaces/ws-r2 10001')),
    ).toBe(true);
    expect(q.enforcing).toBe(true);
  });
  it('a failing quota command fails workspace creation; a path with shell characters is refused; release clears the limit', async () => {
    const { runner, q } = mk();
    runner.on((a) => a[3]?.startsWith('limit') === true, { code: 1 });
    await expect(q.apply('ws-r1', '/ws/ws-r1', 64)).rejects.toThrow('quota_command_failed');
    await expect(q.apply('ws-r3', '/ws/a b; rm -rf /', 64)).rejects.toThrow('quota_path_unsafe');
    const ok = mk();
    await ok.q.apply('ws-r4', '/ws/ws-r4', 64);
    await ok.q.release('ws-r4');
    expect(ok.runner.argvs().at(-1)![3]).toMatch(/^limit -p bhard=0 bsoft=0 ihard=0 \d+$/);
    await ok.q.release('ws-unknown');
  });
});

describe('a rig workspace store really lives on disk and is gone after destroy', () => {
  it('create → files on disk → destroy → nothing remains (no workspace, no directory)', async () => {
    const rig = await createAgentRig();
    await rig.runtime.createWorkspace({
      workspaceId: 'ws-r1',
      orgId: 'o',
      runId: 'r1',
      diskMb: 64,
    });
    await rig.runtime.putFiles('ws-r1', new Map([['src/a.ts', 'x']]));
    expect(await readFile(join(rig.cfg.workspaceRoot, 'ws-r1/work/src/a.ts'), 'utf8')).toBe('x');
    await rig.runtime.destroyWorkspace('ws-r1');
    expect(await lstat(join(rig.cfg.workspaceRoot, 'ws-r1')).catch(() => null)).toBeNull();
    await rig.runtime.destroyWorkspace('ws-r1'); // idempotent
    await rig.dispose();
    await rm(rig.dir, { recursive: true, force: true });
  });
});
