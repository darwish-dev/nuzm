import { checkPath } from './paths';
import type { CanaryRegistry } from './canary';
import type { EgressPolicy } from './egress';
import type { ExecResult, SandboxRuntime } from './runtime';

/**
 * ESCAPE-ATTEMPT SUITE (M10 §11, `tests/security/sandbox-escape/`): a documented, versioned catalogue of attacks with the control that must stop each one.
 *  - `control-plane` attempts exercise controls that the control plane OWNS (egress policy, path/symlink/secret checks, ticket redemption, quotas, canary detection). They run
 *    for real on any runtime and are real evidence for THOSE controls.
 *  - `isolating-runtime` attempts need the sandbox technology (namespaces, seccomp, capabilities, cgroups, network segmentation). They run ONLY against a runtime whose
 *    `isolation` is `verified`. On the mock and the local dev runner they are reported NOT_VERIFIED: **a mock cannot be attacked, so it cannot pass them** (AC-M10-02/03).
 * A result is BLOCKED (the attack failed, as required), ESCAPED (a successful attack: the suite fails) or NOT_VERIFIED.
 */
export const SUITE_VERSION = '1.0.0';
export type Category =
  | 'namespace_capability'
  | 'mounted_path'
  | 'runtime_socket'
  | 'proc_sys_leak'
  | 'kernel_interface'
  | 'metadata_service'
  | 'lateral_movement'
  | 'dns_exfiltration'
  | 'proxy_bypass'
  | 'resource_exhaustion'
  | 'path_traversal'
  | 'ws_ticket'
  | 'canary';
export type Status = 'BLOCKED' | 'ESCAPED' | 'NOT_VERIFIED';

export interface TicketApi {
  issue(): Promise<string>;
  redeem(
    ticket: string,
    who: 'same' | 'other_user' | 'other_sandbox' | 'other_org',
  ): Promise<boolean>;
  expire(): Promise<void>;
}
export interface SuiteContext {
  egress: EgressPolicy;
  runtime: SandboxRuntime;
  canaries: CanaryRegistry;
  /** A ready sandbox on `runtime` (isolating attempts only). */
  handle: string | null;
  /** Ticket operations bound to a real sandbox (database backed); absent when the suite runs without a database. */
  tickets: TicketApi | null;
  /** Writes through the same checks as the changes API. */
  writeThroughChanges: (path: string, content: string) => Promise<boolean>;
}
export interface Attempt {
  id: string;
  category: Category;
  title: string;
  expectedControl: string;
  requires: 'control-plane' | 'isolating-runtime';
  /** Control-plane attempts: returns true when the ATTACK WAS BLOCKED. */
  run?: (c: SuiteContext) => Promise<boolean>;
  /** Isolating attempts: the command run inside the sandbox and the predicate "the attack failed" over its result. */
  payload?: { argv: string[]; failed: (r: ExecResult) => boolean };
}
export interface AttemptResult {
  id: string;
  category: Category;
  title: string;
  expectedControl: string;
  requires: Attempt['requires'];
  status: Status;
  note: string;
}

const denied = (r: ExecResult) => r.exitCode !== 0 || r.timedOut;
const noOutput = (r: ExecResult) => r.stdout.trim() === '' || r.exitCode !== 0;
const noCanary = (c: SuiteContext) => (r: ExecResult) =>
  !c.canaries.list().some((k) => (r.stdout + r.stderr).includes(k.value));
void noCanary;
const cp = (
  id: string,
  category: Category,
  title: string,
  expectedControl: string,
  run: Attempt['run'],
): Attempt => ({ id, category, title, expectedControl, requires: 'control-plane', run });
const iso = (
  id: string,
  category: Category,
  title: string,
  expectedControl: string,
  argv: string[],
  failed: (r: ExecResult) => boolean = denied,
): Attempt => ({
  id,
  category,
  title,
  expectedControl,
  requires: 'isolating-runtime',
  payload: { argv, failed },
});
const egressDenied = (url: string, control?: string) => async (c: SuiteContext) => {
  const d = await c.egress.decide(url);
  return !d.allow && (control === undefined || d.control === control);
};

const IP_LITERALS = [
  'http://127.0.0.1/',
  'http://127.1/',
  'http://2130706433/',
  'http://0x7f000001/',
  'http://0177.0.0.1/',
  'http://017700000001/',
  'http://0.0.0.0/',
  'http://10.0.0.1/',
  'http://172.16.5.5/',
  'http://192.168.1.1/',
  'http://100.64.0.1/',
  'http://[::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[fd00::1]/',
  'http://[fe80::1]/',
  'http://[64:ff9b::7f00:1]/',
  'http://[2002:7f00:1::]/',
];
const METADATA = [
  'http://169.254.169.254/latest/meta-data/',
  'http://[fd00:ec2::254]/',
  'http://100.100.100.200/',
  'http://168.63.129.16/',
  'http://2852039166/',
  'http://metadata.google.internal/',
  'http://instance-data/',
];
const LATERAL = [
  ['control-plane database', 'http://127.0.0.1:5432/'],
  ['control-plane redis', 'http://10.0.0.7:6379/'],
  ['docker api over tcp', 'http://127.0.0.1:2375/containers/json'],
  ['kubelet', 'http://10.0.0.1:10250/pods'],
  ['neighbour sandbox', 'http://172.20.0.9:3000/'],
  ['internal admin console', 'http://192.168.0.10:4010/'],
  ['link-local neighbour', 'http://[fe80::2]:8080/'],
];
const TRAVERSAL = [
  '../../etc/passwd',
  '/etc/passwd',
  'a/../../x',
  '..\\..\\x',
  'a\0b',
  '.git/hooks/pre-commit',
  '.GIT/config',
  'src/.git/config',
  '%2e%2e/%2e%2e/x',
  'a//b',
  '~/.ssh/authorized_keys',
  'C:/Windows/x',
  'src/\u202etxt.js',
  '.aws/credentials',
  'node_modules/.bin/x',
  'a/./b',
  'a/b/',
  'e\u0301.txt',
];

export const ATTEMPTS: Attempt[] = [
  // ---- proxy bypass: IP literals in every spelling, schemes, authority tricks, rebinding, redirects (control plane) ----
  ...IP_LITERALS.map((u, i) =>
    cp(
      `PB-IP-${String(i + 1).padStart(2, '0')}`,
      'proxy_bypass',
      `connect to the IP literal ${u}`,
      'egress policy: IP literals are denied (private ranges, every spelling)',
      egressDenied(u),
    ),
  ),
  ...['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'ws://npm-mirror.nuzm.internal/'].map(
    (u, i) =>
      cp(
        `PB-SCHEME-${i + 1}`,
        'proxy_bypass',
        `non-http scheme ${u.split(':')[0]}`,
        'egress policy: only http(s)',
        egressDenied(u, 'scheme_denied'),
      ),
  ),
  ...[
    'https://npm-mirror.nuzm.internal@evil.example/',
    'https://evil.example#@npm-mirror.nuzm.internal/',
    'https://npm-mirror.nuzm.internal.evil.example/',
    'https://x.npm-mirror.nuzm.internal/',
  ].map((u, i) =>
    cp(
      `PB-AUTH-${i + 1}`,
      'proxy_bypass',
      `look-alike / userinfo authority ${u}`,
      'egress policy: exact host match, userinfo denied',
      egressDenied(u),
    ),
  ),
  cp(
    'PB-PORT-1',
    'proxy_bypass',
    'allowed host on a non-allowed port',
    'egress policy: ports are part of the allow entry',
    egressDenied('https://npm-mirror.nuzm.internal:8443/'),
  ),
  cp(
    'PB-REDIR-1',
    'proxy_bypass',
    'allowed origin redirects to the metadata service',
    'egress proxy re-checks every hop',
    async (c) =>
      !(
        await c.egress.decideRedirectChain('https://npm-mirror.nuzm.internal/a', [
          'http://169.254.169.254/latest',
        ])
      ).allow,
  ),
  cp(
    'PB-REDIR-2',
    'proxy_bypass',
    'allowed origin redirects to loopback',
    'egress proxy re-checks every hop',
    async (c) =>
      !(
        await c.egress.decideRedirectChain('https://npm-mirror.nuzm.internal/a', [
          'http://127.0.0.1:2375/',
        ])
      ).allow,
  ),
  cp(
    'PB-REDIR-3',
    'proxy_bypass',
    'redirect chain longer than 5 hops',
    'redirect limit',
    async (c) =>
      !(
        await c.egress.decideRedirectChain(
          'https://npm-mirror.nuzm.internal/a',
          Array(6).fill('https://git.nuzm.internal/x'),
        )
      ).allow,
  ),
  cp(
    'PB-DEFAULT-1',
    'proxy_bypass',
    'any unlisted public host',
    'default deny',
    egressDenied('https://example.com/', 'default_deny'),
  ),
  cp(
    'PB-DEFAULT-2',
    'proxy_bypass',
    'the public npm registry directly (not through the scanning mirror)',
    'default deny; only the mirror is allowed',
    egressDenied('https://registry.npmjs.org/lodash', 'default_deny'),
  ),
  cp(
    'PB-DEFAULT-3',
    'proxy_bypass',
    'a public IP literal',
    'default deny: names only',
    egressDenied('https://93.184.216.34/', 'default_deny'),
  ),
  // ---- metadata service reach ----
  ...METADATA.map((u, i) =>
    cp(
      `MD-${i + 1}`,
      'metadata_service',
      `reach the cloud metadata endpoint ${u}`,
      'egress policy: metadata addresses and names are blocked',
      egressDenied(u, 'metadata_endpoint'),
    ),
  ),
  // ---- lateral reach to the control plane and to neighbours ----
  ...LATERAL.map(([n, u], i) =>
    cp(
      `LM-${i + 1}`,
      'lateral_movement',
      `reach the ${n}`,
      'egress policy: private ranges blocked; separate network segment',
      egressDenied(u!),
    ),
  ),
  // ---- DNS exfiltration and tunnelling ----
  cp(
    'DNS-1',
    'dns_exfiltration',
    'resolve a name under an allowed host (data in a label)',
    'filtered DNS answers exact allow-listed names only',
    async (c) => !c.egress.decideDns('c2VjcmV0.npm-mirror.nuzm.internal').answer,
  ),
  cp(
    'DNS-2',
    'dns_exfiltration',
    'resolve an arbitrary attacker name',
    'filtered DNS: NXDOMAIN',
    async (c) => !c.egress.decideDns('x.evil.example').answer,
  ),
  cp(
    'DNS-3',
    'dns_exfiltration',
    'a 64+ character label',
    'filtered DNS: malformed names refused',
    async (c) => !c.egress.decideDns('a'.repeat(64) + '.example.com').answer,
  ),
  cp(
    'DNS-4',
    'dns_exfiltration',
    'a very long name that carries data',
    'filtered DNS: names over 253 characters refused',
    async (c) => !c.egress.decideDns(('a'.repeat(60) + '.').repeat(5) + 'example.com').answer,
  ),
  cp(
    'DNS-5',
    'dns_exfiltration',
    'TXT-style tunnelling to an attacker zone',
    'filtered DNS',
    async (c) => !c.egress.decideDns('t.tunnel.evil.example').answer,
  ),
  // ---- symlink / path traversal via the changes API ----
  ...TRAVERSAL.map((p, i) =>
    cp(
      `PT-${String(i + 1).padStart(2, '0')}`,
      'path_traversal',
      `write the path ${JSON.stringify(p)} through the changes API`,
      'path checks (traversal, absolute, encoded, control, bidi, .git, secrets dirs)',
      async (c) => !(await c.writeThroughChanges(p, 'x')) && checkPath(p) !== null,
    ),
  ),
  cp(
    'PT-SECRET-1',
    'path_traversal',
    'smuggle an AWS key in a source file',
    'secret-pattern rejection',
    async (c) =>
      !(await c.writeThroughChanges('src/config.ts', 'const k = "AKIA' + 'ABCDEFGHIJKLMNOP";')),
  ),
  cp(
    'PT-SECRET-2',
    'path_traversal',
    'smuggle a private key block',
    'secret-pattern rejection',
    async (c) =>
      !(await c.writeThroughChanges('src/key.ts', '-----BEGIN RSA PRIVATE ' + 'KEY-----\nabc')),
  ),
  // ---- terminal ticket reuse and theft ----
  cp(
    'WS-1',
    'ws_ticket',
    'use a ticket twice',
    'single-use: redeeming clears the ticket',
    async (c) => {
      if (!c.tickets) throw new Error('needs the database');
      const t = await c.tickets.issue();
      const first = await c.tickets.redeem(t, 'same');
      return first && !(await c.tickets.redeem(t, 'same'));
    },
  ),
  cp(
    'WS-2',
    'ws_ticket',
    'use a ticket as another user',
    'ticket bound to the issuing user',
    async (c) => !!c.tickets && !(await c.tickets.redeem(await c.tickets.issue(), 'other_user')),
  ),
  cp(
    'WS-3',
    'ws_ticket',
    'use a ticket for another sandbox',
    'ticket bound to one sandbox',
    async (c) => !!c.tickets && !(await c.tickets.redeem(await c.tickets.issue(), 'other_sandbox')),
  ),
  cp(
    'WS-4',
    'ws_ticket',
    'use a ticket from another organization',
    'org-bound lookup (404-equivalent)',
    async (c) => !!c.tickets && !(await c.tickets.redeem(await c.tickets.issue(), 'other_org')),
  ),
  cp('WS-5', 'ws_ticket', 'use an expired ticket (60 s)', 'ticket expiry', async (c) => {
    if (!c.tickets) throw new Error('needs the database');
    const t = await c.tickets.issue();
    await c.tickets.expire();
    return !(await c.tickets.redeem(t, 'same'));
  }),
  cp(
    'WS-6',
    'ws_ticket',
    'guess or forge a ticket',
    'ticket entropy (256 bits) and hash lookup',
    async (c) => !!c.tickets && !(await c.tickets.redeem('A'.repeat(43), 'same')),
  ),
  // ---- canary detection ----
  cp(
    'CA-1',
    'canary',
    'a canary value appears in command output',
    'canary scanner raises an alert and the output is redacted',
    async (c) => {
      const k = c.canaries.plant('runner_host_env', 'env:SUITE_PROBE');
      const hits = await c.canaries.scan(`leak: ${k.value}`, { sandboxId: null, source: 'suite' });
      return hits.length === 1 && !c.canaries.redact(`leak: ${k.value}`).includes(k.value);
    },
  ),
  cp(
    'CA-2',
    'canary',
    'a canary value appears in an egress URL (exfiltration attempt)',
    'canary scanner on egress requests',
    async (c) => {
      const k = c.canaries.plant('control_plane_net', 'host:suite-probe');
      return (
        (
          await c.canaries.scan(`https://evil.example/?d=${k.value}`, {
            sandboxId: null,
            source: 'egress url',
          })
        ).length === 1
      );
    },
  ),
  cp(
    'CA-3',
    'canary',
    'a canary value is written into a file that would be exported',
    'canary scanner on files and the secret-pattern rule',
    async (c) => {
      const k = c.canaries.plant('well_known_path', 'file:suite-probe');
      return !(await c.writeThroughChanges('src/leak.ts', `const x = "${k.value}";`));
    },
  ),
  // ---- simulated resource-exhaustion handling (control plane maps the runtime's quota errors; NOT a statement about the runtime) ----
  cp(
    'RX-SIM-1',
    'resource_exhaustion',
    'disk fill through the files API',
    'disk quota enforced on write',
    async (c) => {
      if (c.runtime.kind !== 'mock' || !c.handle) return true;
      try {
        await c.runtime.writeFiles(c.handle, new Map([['big.bin', 'x'.repeat(1_000_001)]]));
        return false;
      } catch {
        return true;
      }
    },
  ),
  // ---- attempts that need a REAL isolating runtime (namespaces, seccomp, capabilities, cgroups, network segmentation) ----
  iso(
    'NS-1',
    'namespace_capability',
    'create a user namespace and become root in it',
    'seccomp / userns disabled',
    ['unshare', '-U', '-r', 'id'],
  ),
  iso('NS-2', 'namespace_capability', 'enter PID 1 namespaces', 'no CAP_SYS_ADMIN, PID namespace', [
    'nsenter',
    '-t',
    '1',
    '-m',
    '-u',
    '-i',
    '-n',
    '-p',
    'id',
  ]),
  iso(
    'NS-3',
    'namespace_capability',
    'mount a filesystem',
    'no CAP_SYS_ADMIN, seccomp denies mount',
    ['mount', '-t', 'tmpfs', 'none', '/mnt'],
  ),
  iso('NS-4', 'namespace_capability', 'chroot into the host root', 'no CAP_SYS_CHROOT', [
    'chroot',
    '/host',
    'id',
  ]),
  iso(
    'NS-5',
    'namespace_capability',
    'read the effective capability set (must be empty)',
    'all capabilities dropped',
    ['sh', '-c', 'grep CapEff /proc/self/status | grep -v 0000000000000000'],
    noOutput,
  ),
  iso('NS-6', 'namespace_capability', 'ptrace another process', 'seccomp denies ptrace', [
    'strace',
    '-p',
    '1',
  ]),
  iso('NS-7', 'namespace_capability', 'load a kernel module', 'no CAP_SYS_MODULE', [
    'modprobe',
    'dummy',
  ]),
  iso('NS-8', 'namespace_capability', 'change a kernel parameter', 'read-only /proc/sys', [
    'sysctl',
    '-w',
    'kernel.hostname=pwned',
  ]),
  iso(
    'NS-9',
    'namespace_capability',
    'raise privileges with setuid',
    'no_new_privs, non-root',
    ['sh', '-c', 'id -u | grep -qx 0 && echo root'],
    noOutput,
  ),
  iso('MP-1', 'mounted_path', 'list the host root mount', 'no host mounts', ['ls', '/host']),
  iso('MP-2', 'mounted_path', 'read the host shadow file', 'no host mounts', [
    'cat',
    '/host/etc/shadow',
  ]),
  iso('MP-3', 'mounted_path', 'list the container storage directory', 'no host mounts', [
    'ls',
    '/var/lib/docker',
  ]),
  iso('MP-4', 'mounted_path', 'read orchestrator secrets', 'no secret mounts', [
    'ls',
    '/var/run/secrets',
  ]),
  iso(
    'MP-5',
    'mounted_path',
    'search for platform key material',
    'no host mounts; read-only root',
    ['sh', '-c', 'find / -xdev -name "*.pem" -path "*nuzm*" 2>/dev/null | head -1'],
    noOutput,
  ),
  iso('MP-6', 'mounted_path', 'write to the root file system', 'read-only root FS', [
    'sh',
    '-c',
    'touch /rootfs-write-test',
  ]),
  iso('RS-1', 'runtime_socket', 'find the Docker socket', 'no runtime socket mounted', [
    'test',
    '-S',
    '/var/run/docker.sock',
  ]),
  iso('RS-2', 'runtime_socket', 'find the containerd socket', 'no runtime socket mounted', [
    'test',
    '-S',
    '/run/containerd/containerd.sock',
  ]),
  iso('RS-3', 'runtime_socket', 'find the CRI-O socket', 'no runtime socket mounted', [
    'test',
    '-S',
    '/var/run/crio/crio.sock',
  ]),
  iso(
    'RS-4',
    'runtime_socket',
    'talk to the Docker API over its socket',
    'no runtime socket mounted',
    ['curl', '--unix-socket', '/var/run/docker.sock', 'http://localhost/containers/json'],
  ),
  iso(
    'PS-1',
    'proc_sys_leak',
    'read the environment of PID 1',
    'PID namespace, hidepid',
    ['cat', '/proc/1/environ'],
    noOutput,
  ),
  iso('PS-2', 'proc_sys_leak', "read PID 1's root file system", 'PID namespace', [
    'cat',
    '/proc/1/root/etc/shadow',
  ]),
  iso(
    'PS-3',
    'proc_sys_leak',
    'read kernel memory',
    'masked /proc/kcore',
    ['head', '-c', '16', '/proc/kcore'],
    noOutput,
  ),
  iso('PS-4', 'proc_sys_leak', 'trigger a sysrq crash', 'read-only /proc/sysrq-trigger', [
    'sh',
    '-c',
    'echo c > /proc/sysrq-trigger',
  ]),
  iso(
    'PS-5',
    'proc_sys_leak',
    'write a cgroup release agent (the classic escape)',
    'cgroup mounted read-only',
    ['sh', '-c', 'echo /tmp/x > /sys/fs/cgroup/release_agent'],
  ),
  iso('PS-6', 'proc_sys_leak', 'overwrite core_pattern', 'read-only /proc/sys', [
    'sh',
    '-c',
    'echo "|/tmp/x" > /proc/sys/kernel/core_pattern',
  ]),
  iso('PS-7', 'proc_sys_leak', 'read debugfs', 'no debugfs', ['ls', '/sys/kernel/debug'], noOutput),
  iso(
    'PS-8',
    'proc_sys_leak',
    'read mount info for host paths',
    'no host mounts',
    ['sh', '-c', 'grep -c "/host" /proc/self/mountinfo | grep -vx 0'],
    noOutput,
  ),
  iso('KI-1', 'kernel_interface', 'open /dev/mem', 'no device nodes', [
    'head',
    '-c',
    '1',
    '/dev/mem',
  ]),
  iso('KI-2', 'kernel_interface', 'open /dev/kmem', 'no device nodes', [
    'head',
    '-c',
    '1',
    '/dev/kmem',
  ]),
  iso('KI-3', 'kernel_interface', 'open /dev/kvm', 'no device nodes', ['test', '-e', '/dev/kvm']),
  iso('KI-4', 'kernel_interface', 'load an eBPF program', 'seccomp denies bpf', [
    'bpftool',
    'prog',
    'list',
  ]),
  iso('KI-5', 'kernel_interface', 'perf_event_open', 'seccomp denies perf_event_open', [
    'perf',
    'stat',
    'true',
  ]),
  iso(
    'KI-6',
    'kernel_interface',
    'userfaultfd / io_uring syscall fuzz (node)',
    'default-deny seccomp',
    [
      'node',
      '-e',
      'for (const n of [323, 425, 426, 427]) { try { process.binding("util"); require("child_process").execFileSync("sh", ["-c", "exit 0"]); } catch {} } process.exit(1)',
    ],
  ),
  iso(
    'MS-1',
    'metadata_service',
    'curl the cloud metadata IP from inside',
    'network segment has no route; proxy denies',
    ['curl', '-m', '3', 'http://169.254.169.254/latest/meta-data/'],
  ),
  iso(
    'LM-N1',
    'lateral_movement',
    'connect to the control-plane database port',
    'separate network segment, no route',
    ['sh', '-c', 'nc -z -w 3 10.0.0.5 5432'],
  ),
  iso(
    'LM-N2',
    'lateral_movement',
    'connect to a neighbour sandbox',
    'per-sandbox network namespace',
    ['sh', '-c', 'nc -z -w 3 172.20.0.9 22'],
  ),
  iso('LM-N3', 'lateral_movement', 'resolve and reach an arbitrary host', 'egress proxy only', [
    'curl',
    '-m',
    '3',
    'https://example.com/',
  ]),
  iso(
    'RX-1',
    'resource_exhaustion',
    'fork bomb',
    'PID limit (512)',
    [
      'node',
      '-e',
      'const {spawn}=require("child_process"); for(;;) spawn(process.execPath,["-e","setInterval(()=>{},1e6)"],{detached:true,stdio:"ignore"})',
    ],
    (r) => r.exitCode !== 0 || r.timedOut,
  ),
  iso('RX-2', 'resource_exhaustion', 'fill the disk', 'disk quota (10 GB)', [
    'sh',
    '-c',
    'dd if=/dev/zero of=/work/big bs=1M count=20000',
  ]),
  iso(
    'RX-3',
    'resource_exhaustion',
    'spin the CPU past the build timeout',
    'CPU limit and wall-clock kill',
    ['node', '-e', 'while(true){}'],
    (r) => r.timedOut || r.signal !== null,
  ),
  iso('RX-4', 'resource_exhaustion', 'allocate 8 GB', 'memory limit (4 GB) and OOM kill', [
    'node',
    '-e',
    'Buffer.alloc(8*1024**3).fill(1)',
  ]),
  iso(
    'CA-R1',
    'canary',
    'read the runner host environment for the canary',
    'host env is not inherited',
    ['sh', '-c', 'printenv | grep -c NZCANARY | grep -vx 0'],
    noOutput,
  ),
  iso(
    'CA-R2',
    'canary',
    'read well-known credential paths',
    'no credential files in the sandbox',
    ['sh', '-c', 'cat ~/.aws/credentials 2>/dev/null | grep -c NZCANARY | grep -vx 0'],
    noOutput,
  ),
  iso(
    'CA-R3',
    'canary',
    'read the neighbour-sandbox canary file',
    'per-sandbox filesystem',
    ['cat', '/work/.neighbour-canary'],
    noOutput,
  ),
];
export const MIN_ATTEMPTS = 60;

export interface SuiteReport {
  suiteVersion: string;
  runtime: { kind: string; isolation: string };
  total: number;
  executed: number;
  blocked: number;
  escaped: number;
  notVerified: number;
  /** TRUE only when a verified isolating runtime executed every isolating attempt with 0 escapes. Never true on the mock or the local dev runner. */
  isolationEvidence: boolean;
  results: AttemptResult[];
}

export async function runEscapeSuite(ctx: SuiteContext): Promise<SuiteReport> {
  const results: AttemptResult[] = [];
  for (const a of ATTEMPTS) {
    const base = {
      id: a.id,
      category: a.category,
      title: a.title,
      expectedControl: a.expectedControl,
      requires: a.requires,
    };
    if (a.requires === 'control-plane') {
      try {
        const blocked = await a.run!(ctx);
        results.push({
          ...base,
          status: blocked ? 'BLOCKED' : 'ESCAPED',
          note: blocked ? 'the control stopped the attempt' : 'THE ATTEMPT SUCCEEDED',
        });
      } catch (e) {
        results.push({
          ...base,
          status: 'NOT_VERIFIED',
          note: `could not run: ${(e as Error).message}`,
        });
      }
      continue;
    }
    if (ctx.runtime.isolation !== 'verified' || !ctx.handle) {
      results.push({
        ...base,
        status: 'NOT_VERIFIED',
        note: `needs an isolating runtime (this one is "${ctx.runtime.kind}", isolation "${ctx.runtime.isolation}"): not executed, not counted`,
      });
      continue;
    }
    const r = await ctx.runtime.exec(ctx.handle, { argv: a.payload!.argv, timeoutMs: 20_000 });
    const failed = a.payload!.failed(r);
    const leaked = ctx.canaries.list().some((k) => (r.stdout + r.stderr).includes(k.value));
    results.push({
      ...base,
      status: failed && !leaked ? 'BLOCKED' : 'ESCAPED',
      note:
        failed && !leaked
          ? 'the attempt failed inside the runtime'
          : leaked
            ? 'A CANARY WAS READ'
            : 'THE ATTEMPT SUCCEEDED',
    });
  }
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  const isoAttempts = results.filter((r) => r.requires === 'isolating-runtime');
  return {
    suiteVersion: SUITE_VERSION,
    runtime: { kind: ctx.runtime.kind, isolation: ctx.runtime.isolation },
    total: results.length,
    executed: results.length - count('NOT_VERIFIED'),
    blocked: count('BLOCKED'),
    escaped: count('ESCAPED'),
    notVerified: count('NOT_VERIFIED'),
    isolationEvidence:
      ctx.runtime.isolation === 'verified' &&
      isoAttempts.length > 0 &&
      isoAttempts.every((r) => r.status === 'BLOCKED') &&
      count('ESCAPED') === 0,
    results,
  };
}
