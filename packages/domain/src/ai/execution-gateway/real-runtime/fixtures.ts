import type { ExecutionStatus } from '../port';
import type { SimulatedBehavior } from './workspace-runtime';

/**
 * S-AG6 PHASE 2 (OFFLINE): DISPOSABLE SYNTHETIC PROJECT FIXTURES for the staging runtime tests. Each fixture is a tiny, self-contained project (a map of path to text), the request
 * a builder agent would make, whether a human approval is recorded for it, and what an ISOLATING runtime must show. The same fixtures run (a) now, against the mock port and
 * the simulated node (`simulate` is what those stand-ins do; nothing is executed), and (b) later, on an attested staging node, where the files are really run.
 *
 * SAFETY: these are TEXT. They are never written to the control-plane host's disk by this repository and never executed on it; only an attested isolating runtime may run them
 * (HG-10-02, D-21, an owner-approved staging run). Hazardous fixtures (resource exhaustion, link tricks, network probes) are bounded, synthetic and use only documentation or
 * link-local addresses and no hostname. They contain no secret-looking value and no real package. Every fixture is disposable: the workspace is destroyed after the run.
 */
/** `policy` decideExec and approval; `workspace` seed screening; `dependency` install policy; `artifact` artifact policy; `runtime` the run itself; `resource` limits enforced by the monitor/runtime (mock cannot) */
export type FixtureLayer =
  'policy' | 'workspace' | 'dependency' | 'artifact' | 'runtime' | 'resource';
export type FixtureHazard =
  | 'none'
  | 'cpu'
  | 'memory'
  | 'pids'
  | 'output'
  | 'disk'
  | 'network'
  | 'filesystem'
  | 'environment'
  | 'lifecycle';
export type FixtureExpectation =
  | { kind: 'refused'; reason: string }
  | {
      kind: 'ran';
      /** any of these statuses satisfies the expectation (a runtime may report a limit kill as `failed` or `timeout`) */
      status: readonly ExecutionStatus[];
      exitCode?: 'zero' | 'nonzero';
      stdoutIncludes?: readonly string[];
      stdoutExcludes?: readonly string[];
      truncated?: boolean;
      /** exactly these artifact paths survive the artifact policy */
      artifacts?: readonly string[];
      /** every stdout line is one of the constant environment's variable names (plus npm's own) */
      envKeysOnly?: boolean;
    };
export interface SyntheticFixture {
  id: string;
  title: string;
  layer: FixtureLayer;
  hazard: FixtureHazard;
  files: () => Record<string, string>;
  request: { profile: string; params?: Record<string, unknown> };
  /** a human approval is recorded for the (profile-requiring-approval) request */
  approved: boolean;
  /** the project scripts the request context declares (what the control plane read from package.json) */
  scripts: readonly string[];
  expect: FixtureExpectation;
  /** the stand-in behaviour: the simulated node (and the mock's scripted outcome) */
  simulate: SimulatedBehavior;
}

const PKG = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'synthetic-fixture', version: '0.0.0', private: true, ...extra }, null, 2);
const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'commonjs' },
  include: ['src'],
});
const node = (body: string) => `${body}\n`;
const LOCK_EMPTY = JSON.stringify({
  name: 'synthetic-fixture',
  lockfileVersion: 3,
  packages: { '': { name: 'synthetic-fixture' } },
});

export const SYNTHETIC_FIXTURES: readonly SyntheticFixture[] = [
  {
    id: 'FX-OK-TYPECHECK',
    title: 'a clean TypeScript library typechecks',
    layer: 'runtime',
    hazard: 'none',
    files: () => ({
      'package.json': PKG(),
      'tsconfig.json': TSCONFIG,
      'src/index.ts': node('export const add = (a: number, b: number): number => a + b;'),
    }),
    request: { profile: 'typecheck' },
    approved: false,
    scripts: [],
    expect: { kind: 'ran', status: ['completed'], exitCode: 'zero' },
    simulate: { exitCode: 0, stdout: '' },
  },
  {
    id: 'FX-TYPE-ERROR',
    title: 'a type error fails the typecheck with a diagnostic',
    layer: 'runtime',
    hazard: 'none',
    files: () => ({
      'package.json': PKG(),
      'tsconfig.json': TSCONFIG,
      'src/index.ts': node("export const n: number = 'not a number';"),
    }),
    request: { profile: 'typecheck' },
    approved: false,
    scripts: [],
    expect: { kind: 'ran', status: ['failed'], exitCode: 'nonzero', stdoutIncludes: ['TS2322'] },
    simulate: {
      exitCode: 2,
      stdout:
        "src/index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n",
    },
  },
  {
    id: 'FX-UNIT-PASS',
    title: 'passing unit tests',
    layer: 'runtime',
    hazard: 'none',
    files: () => ({
      'package.json': PKG({ scripts: { test: 'node test.js' } }),
      'test.js': node("require('node:assert').strictEqual(1 + 1, 2); console.log('PASS');"),
    }),
    request: { profile: 'unit-tests' },
    approved: false,
    scripts: ['test'],
    expect: { kind: 'ran', status: ['completed'], exitCode: 'zero', stdoutIncludes: ['PASS'] },
    simulate: { exitCode: 0, stdout: 'PASS\n' },
  },
  {
    id: 'FX-UNIT-FAIL',
    title: 'a failing unit test reports failure',
    layer: 'runtime',
    hazard: 'none',
    files: () => ({
      'package.json': PKG({ scripts: { test: 'node test.js' } }),
      'test.js': node("require('node:assert').strictEqual(1 + 1, 3);"),
    }),
    request: { profile: 'unit-tests' },
    approved: false,
    scripts: ['test'],
    expect: { kind: 'ran', status: ['failed'], exitCode: 'nonzero' },
    simulate: { exitCode: 1, stderr: 'AssertionError\n' },
  },
  {
    id: 'FX-BUILD-ARTIFACT',
    title: 'a build produces one artifact under dist',
    layer: 'artifact',
    hazard: 'none',
    files: () => ({
      'package.json': PKG({ scripts: { build: 'node build.js' } }),
      'build.js': node(
        "const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.js', 'module.exports = 1;\\n');",
      ),
    }),
    request: { profile: 'build' },
    approved: false,
    scripts: ['build'],
    expect: { kind: 'ran', status: ['completed'], exitCode: 'zero', artifacts: ['dist/index.js'] },
    simulate: {
      exitCode: 0,
      produced: [{ path: 'dist/index.js', bytes: 20, kind: 'file' }],
      producedContent: { 'dist/index.js': 'module.exports = 1;\n' },
    },
  },
  {
    id: 'FX-ARTIFACT-LINKS',
    title:
      'a build that leaves a symlink, a file outside the output roots and a dotfile: only the regular file under dist survives',
    layer: 'artifact',
    hazard: 'filesystem',
    files: () => ({
      'package.json': PKG({ scripts: { build: 'node build.js' } }),
      'build.js': node(
        "const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/ok.js', '1;\\n'); fs.symlinkSync('/etc/hostname', 'dist/link'); fs.writeFileSync('outside.txt', 'x'); fs.writeFileSync('dist/.env', 'x');",
      ),
    }),
    request: { profile: 'build' },
    approved: false,
    scripts: ['build'],
    expect: { kind: 'ran', status: ['completed', 'failed'], artifacts: ['dist/ok.js'] },
    simulate: {
      exitCode: 0,
      produced: [
        { path: 'dist/ok.js', bytes: 3, kind: 'file' },
        { path: 'dist/link', bytes: 12, kind: 'symlink' },
        { path: 'outside.txt', bytes: 1, kind: 'file' },
        { path: 'dist/.env', bytes: 1, kind: 'file' },
      ],
      producedContent: { 'dist/ok.js': '1;\n', 'outside.txt': 'x', 'dist/.env': 'x' },
    },
  },
  {
    id: 'FX-CPU-SPIN',
    title: 'a busy loop is stopped by the wall or CPU limit',
    layer: 'runtime',
    hazard: 'cpu',
    files: () => ({
      'package.json': PKG({ scripts: { spin: 'node spin.js' } }),
      'spin.js': node('for (;;) {} // bounded by the runtime, never by this file'),
    }),
    request: { profile: 'run-script', params: { script: 'spin' } },
    approved: true,
    scripts: ['spin'],
    expect: { kind: 'ran', status: ['timeout', 'failed', 'terminated'], stdoutExcludes: ['DONE'] },
    simulate: { hang: true },
  },
  {
    id: 'FX-OUTPUT-FLOOD',
    title: 'a megabyte of output is cut at the profile cap and flagged',
    layer: 'runtime',
    hazard: 'output',
    files: () => ({
      'package.json': PKG({ scripts: { flood: 'node flood.js' } }),
      'flood.js': node("process.stdout.write('x'.repeat(1024 * 1024));"),
    }),
    request: { profile: 'run-script', params: { script: 'flood' } },
    approved: true,
    scripts: ['flood'],
    expect: { kind: 'ran', status: ['completed', 'failed'], truncated: true },
    simulate: { exitCode: 0, stdout: 'x'.repeat(1024 * 1024) },
  },
  {
    id: 'FX-MEMORY-BALLOON',
    title: 'allocating without bound hits the memory limit',
    layer: 'resource',
    hazard: 'memory',
    files: () => ({
      'package.json': PKG({ scripts: { balloon: 'node balloon.js' } }),
      'balloon.js': node(
        "const keep = []; for (let i = 0; i < 4096; i++) keep.push(Buffer.alloc(8 * 1024 * 1024, 1)); console.log('DONE');",
      ),
    }),
    request: { profile: 'run-script', params: { script: 'balloon' } },
    approved: true,
    scripts: ['balloon'],
    expect: { kind: 'ran', status: ['failed', 'terminated'], stdoutExcludes: ['DONE'] },
    simulate: { exitCode: 137, stats: { memoryMb: 4096 }, hang: true },
  },
  {
    id: 'FX-PID-SPAWNER',
    title: 'spawning children without bound hits the process limit',
    layer: 'resource',
    hazard: 'pids',
    files: () => ({
      'package.json': PKG({ scripts: { spawner: 'node spawner.js' } }),
      'spawner.js': node(
        "const cp = require('node:child_process'); try { for (let i = 0; i < 600; i++) cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); console.log('DONE'); } catch (e) { console.log('PID_LIMIT_HIT'); process.exit(1); }",
      ),
    }),
    request: { profile: 'run-script', params: { script: 'spawner' } },
    approved: true,
    scripts: ['spawner'],
    expect: { kind: 'ran', status: ['failed', 'terminated'], stdoutExcludes: ['DONE'] },
    simulate: { exitCode: 1, stdout: 'PID_LIMIT_HIT\n' },
  },
  {
    id: 'FX-DISK-FILLER',
    title: 'writing without bound hits the disk quota',
    layer: 'resource',
    hazard: 'disk',
    files: () => ({
      'package.json': PKG({ scripts: { filler: 'node filler.js' } }),
      'filler.js': node(
        "const fs = require('node:fs'); const b = Buffer.alloc(1024 * 1024, 1); try { for (let i = 0; i < 8192; i++) fs.writeFileSync('fill-' + i + '.bin', b); console.log('DONE'); } catch (e) { console.log('DISK_LIMIT_HIT'); process.exit(1); }",
      ),
    }),
    request: { profile: 'run-script', params: { script: 'filler' } },
    approved: true,
    scripts: ['filler'],
    expect: { kind: 'ran', status: ['failed', 'terminated'], stdoutExcludes: ['DONE'] },
    simulate: { exitCode: 1, stdout: 'DISK_LIMIT_HIT\n' },
  },
  {
    id: 'FX-ENV-PROBE',
    title: 'the run sees only the constant environment',
    layer: 'runtime',
    hazard: 'environment',
    files: () => ({
      'package.json': PKG({ scripts: { probe: 'node probe.js' } }),
      'probe.js': node("console.log(Object.keys(process.env).sort().join('\\n'));"),
    }),
    request: { profile: 'run-script', params: { script: 'probe' } },
    approved: true,
    scripts: ['probe'],
    expect: { kind: 'ran', status: ['completed'], exitCode: 'zero', envKeysOnly: true },
    simulate: { exitCode: 0, stdout: 'CI\nHOME\nNODE_ENV\nNO_UPDATE_NOTIFIER\nPATH\n' },
  },
  {
    id: 'FX-NETWORK-PROBE',
    title:
      'a run with network class none cannot reach a documentation address or the link-local metadata address',
    layer: 'runtime',
    hazard: 'network',
    files: () => ({
      'package.json': PKG({ scripts: { probe: 'node probe.js' } }),
      'probe.js': node(
        "const net = require('node:net'); let pending = 2; const done = (ok, who) => { if (ok) console.log('CONNECTED ' + who); if (--pending === 0) process.exit(0); }; for (const [h, who] of [['192.0.2.1', 'doc'], ['169.254.169.254', 'meta']]) { const s = net.connect({ host: h, port: 80, timeout: 2000 }); s.on('connect', () => { s.destroy(); done(true, who); }); s.on('error', () => done(false, who)); s.on('timeout', () => { s.destroy(); done(false, who); }); }",
      ),
    }),
    request: { profile: 'run-script', params: { script: 'probe' } },
    approved: true,
    scripts: ['probe'],
    expect: { kind: 'ran', status: ['completed', 'failed'], stdoutExcludes: ['CONNECTED'] },
    simulate: { exitCode: 0, stdout: '' },
  },
  {
    id: 'FX-INSTALL-CLEAN',
    title: 'an install of a project with no dependencies runs with scripts disabled',
    layer: 'runtime',
    hazard: 'lifecycle',
    files: () => ({
      'package.json': PKG({
        scripts: {
          postinstall: "node -e \"require('node:fs').writeFileSync('POSTINSTALL_RAN','1')\"",
        },
      }),
      'package-lock.json': LOCK_EMPTY,
    }),
    request: { profile: 'install-deps' },
    approved: true,
    scripts: ['postinstall'],
    expect: { kind: 'ran', status: ['completed'], exitCode: 'zero', artifacts: [] },
    simulate: { exitCode: 0 },
  },
  {
    id: 'FX-INSTALL-NO-APPROVAL',
    title: 'an install without a recorded human approval does not run',
    layer: 'policy',
    hazard: 'none',
    files: () => ({ 'package.json': PKG(), 'package-lock.json': LOCK_EMPTY }),
    request: { profile: 'install-deps' },
    approved: false,
    scripts: [],
    expect: { kind: 'refused', reason: 'approval_required' },
    simulate: {},
  },
  {
    id: 'FX-DENIED-LIFECYCLE',
    title: 'a lifecycle script cannot be run through run-script',
    layer: 'policy',
    hazard: 'lifecycle',
    files: () => ({ 'package.json': PKG({ scripts: { postinstall: 'node x.js' } }) }),
    request: { profile: 'run-script', params: { script: 'postinstall' } },
    approved: true,
    scripts: ['postinstall'],
    expect: { kind: 'refused', reason: 'script_denied' },
    simulate: {},
  },
  {
    id: 'FX-DIR-TRAVERSAL',
    title: 'a working directory outside the project is refused',
    layer: 'policy',
    hazard: 'filesystem',
    files: () => ({ 'package.json': PKG() }),
    request: { profile: 'typecheck', params: { dir: '../other-tenant' } },
    approved: false,
    scripts: [],
    expect: { kind: 'refused', reason: 'dir_outside_project' },
    simulate: {},
  },
  {
    id: 'FX-UNKNOWN-PROFILE',
    title: 'a profile outside the closed catalogue (and a prototype name) is refused',
    layer: 'policy',
    hazard: 'none',
    files: () => ({ 'package.json': PKG() }),
    request: { profile: 'constructor' },
    approved: false,
    scripts: [],
    expect: { kind: 'refused', reason: 'unknown_profile' },
    simulate: {},
  },
  {
    id: 'FX-SECRET-FILE-IN-SEED',
    title: 'a project holding a dotenv file is not copied into a workspace',
    layer: 'workspace',
    hazard: 'environment',
    files: () => ({
      'package.json': PKG(),
      '.env': 'PLACEHOLDER=1\n',
      'tsconfig.json': TSCONFIG,
      'src/index.ts': node('export {};'),
    }),
    request: { profile: 'typecheck' },
    approved: false,
    scripts: [],
    expect: { kind: 'refused', reason: 'secret_file_name' },
    simulate: {},
  },
  {
    id: 'FX-SECRET-DIR-IN-SEED',
    title: 'a project holding a .git or .ssh directory is not copied into a workspace',
    layer: 'workspace',
    hazard: 'environment',
    files: () => ({
      'package.json': PKG(),
      '.ssh/config': 'Host *\n',
      'tsconfig.json': TSCONFIG,
      'src/index.ts': node('export {};'),
    }),
    request: { profile: 'typecheck' },
    approved: false,
    scripts: [],
    expect: { kind: 'refused', reason: 'secret_directory' },
    simulate: {},
  },
  {
    id: 'FX-GIT-DEPENDENCY',
    title: 'an install with a git dependency is refused before any network call',
    layer: 'dependency',
    hazard: 'network',
    files: () => ({
      'package.json': PKG({ dependencies: { a: 'git+https://example.invalid/a.git' } }),
      'package-lock.json': LOCK_EMPTY,
    }),
    request: { profile: 'install-deps' },
    approved: true,
    scripts: [],
    expect: { kind: 'refused', reason: 'dependency_from_git' },
    simulate: {},
  },
  {
    id: 'FX-LOCKFILE-FOREIGN-REGISTRY',
    title: 'an install whose lockfile resolves outside the allowed registry is refused',
    layer: 'dependency',
    hazard: 'network',
    files: () => ({
      'package.json': PKG({ dependencies: { a: '^1.0.0' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/a': {
            resolved: 'https://mirror.invalid/a.tgz',
            integrity: `sha512-${'A'.repeat(86)}==`,
          },
        },
      }),
    }),
    request: { profile: 'install-deps' },
    approved: true,
    scripts: [],
    expect: { kind: 'refused', reason: 'resolved_outside_registry' },
    simulate: {},
  },
];

export const fixtureById = (id: string): SyntheticFixture | undefined =>
  SYNTHETIC_FIXTURES.find((f) => f.id === id);
