import { describe, expect, it } from 'vitest';
import {
  CLOSED_GATE,
  EXEC_ENV,
  EXEC_PROFILES,
  decideExec,
  executionGate,
  type ExecContext,
} from './index';

const ctx: ExecContext = {
  orgId: 'org-1',
  runId: 'run-1',
  enabledProfiles: ['typecheck', 'unit-tests', 'build', 'run-script'],
  projectScripts: ['build', 'test', 'lint', 'postinstall', 'my_script'],
};
const ask = (over: Record<string, unknown> = {}) =>
  decideExec({ orgId: 'org-1', runId: 'run-1', profile: 'typecheck', ...over }, ctx);

describe('the model never supplies a command line', () => {
  it('a named profile maps to a fixed argv, a fixed environment, fixed limits and no network', () => {
    const d = ask();
    expect(d).toMatchObject({
      allowed: true,
      argv: ['npx', '--no-install', 'tsc', '--noEmit'],
      network: 'none',
      requiresApproval: false,
    });
    if (d.allowed) {
      expect(d.env).toEqual(EXEC_ENV);
      expect(d.limits).toEqual(EXEC_PROFILES.typecheck!.limits);
    }
  });
  it.each([
    ['argv', ['rm', '-rf', '/']],
    ['command', 'curl http://169.254.169.254'],
    ['env', { AWS_SECRET: 'x' }],
    ['shell', true],
    ['cwd', '/'],
    ['args', ['--eval', 'process.exit()']],
    ['network', 'all'],
    ['sudo', true],
  ])('refuses the member "%s" by name', (k, v) => {
    const d = ask({ [k]: v });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reasons).toContain(`model_supplied_${k}`);
  });
  it('refuses unknown, disabled and non-string profiles', () => {
    expect(ask({ profile: 'bash' })).toMatchObject({
      allowed: false,
      reasons: ['unknown_profile'],
    });
    expect(ask({ profile: 'install-deps' })).toMatchObject({
      allowed: false,
      reasons: ['profile_not_enabled'],
    });
    for (const p of [undefined, null, 7, ['typecheck'], { a: 1 }])
      expect(ask({ profile: p }).allowed).toBe(false);
  });
  it('refuses another tenant or another run', () => {
    expect(ask({ orgId: 'org-2' })).toMatchObject({
      allowed: false,
      reasons: ['another_tenant_or_run'],
    });
    expect(ask({ runId: 'run-9' })).toMatchObject({ allowed: false });
  });
});

describe('run-script: a script name, never a command', () => {
  const run = (script: unknown, extra: Record<string, unknown> = {}) =>
    ask({ profile: 'run-script', params: { script, ...extra } });
  it('runs a declared script by name and asks a human first', () => {
    expect(run('lint')).toMatchObject({
      allowed: true,
      argv: ['npm', 'run', 'lint', '--silent'],
      requiresApproval: true,
    });
  });
  it.each([
    'lint; rm -rf /',
    'lint && curl x',
    '$(id)',
    '`id`',
    'lint\nid',
    '../x',
    'Lint',
    '',
    'a'.repeat(60),
    'lint --foo',
    '-x',
    '--prefix=/',
  ])('refuses the injection-shaped name %j', (s) => expect(run(s).allowed).toBe(false));
  it('refuses lifecycle scripts and scripts the project does not declare', () => {
    expect(run('postinstall')).toMatchObject({ allowed: false, reasons: ['script_denied'] });
    expect(run('deploy')).toMatchObject({ allowed: false, reasons: ['script_not_in_project'] });
  });
  it('refuses parameters the profile does not take', () => {
    expect(ask({ params: { script: 'x' } }).allowed).toBe(false);
    expect(run('lint', { flags: '--x' }).allowed).toBe(false);
    for (const p of ['x', 1, [], null])
      expect(ask({ profile: 'run-script', params: p }).allowed).toBe(false);
  });
  it('keeps the working directory inside the project', () => {
    expect(ask({ params: { dir: '../..' } })).toMatchObject({
      allowed: false,
      reasons: ['dir_outside_project'],
    });
    expect(ask({ params: { dir: 'packages/app' } })).toMatchObject({
      allowed: true,
      cwd: 'packages/app',
    });
  });
});

describe('the gate stays closed', () => {
  it('today every condition is false: closed, with every blocker named', () => {
    const g = executionGate(CLOSED_GATE);
    expect(g.open).toBe(false);
    expect(g.blockers).toHaveLength(5);
  });
  it('one missing condition keeps it closed; production also needs D-42', () => {
    const all = {
      ...CLOSED_GATE,
      d21Decided: true,
      runtimeVerified: true,
      escapeSuitePassed: true,
      adrAccepted: true,
      ownerApproved: true,
    };
    expect(executionGate(all).open).toBe(true);
    for (const k of [
      'd21Decided',
      'runtimeVerified',
      'escapeSuitePassed',
      'adrAccepted',
      'ownerApproved',
    ] as const)
      expect(executionGate({ ...all, [k]: false }).open).toBe(false);
    expect(executionGate({ ...all, production: true }).blockers).toEqual([
      'D-42 (production rollout) is not decided',
    ]);
    expect(executionGate({ ...all, production: true, d42Decided: true }).open).toBe(true);
  });
  it('profiles that reach a network or install code need a human', () => {
    for (const p of Object.values(EXEC_PROFILES))
      if (p.network !== 'none') expect(p.approval).toBe('human');
  });
});
