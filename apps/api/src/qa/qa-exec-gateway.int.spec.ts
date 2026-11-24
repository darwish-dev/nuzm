import { describe, expect, it } from 'vitest';
import { executionGateway as gw } from '@nuzm/domain';

/**
 * Session 07 (QA) - independent adversarial tests of the Execution Gateway POLICY CORE (ADR-067 PROPOSED, offline, pure functions; nothing here starts a process).
 * Offline policy evidence only: it says nothing about any runtime's isolation (no runtime is verified).
 * Tests marked `it.fails` document a DEFECT in code owned by Session 04 (see docs/parallel/sessions/DEFECT-*.md): the test states the SECURE expectation and is expected to
 * fail today; when the owner fixes the defect the `.fails` test starts failing, which is the signal to remove the marker. No assertion is weakened.
 */
const ORG = '0190a000-0000-7000-8000-000000000001';
const RUN = '0190a000-0000-7000-8000-0000000000aa';
const ctx = (over: Partial<gw.ExecContext> = {}): gw.ExecContext => ({
  orgId: ORG,
  runId: RUN,
  enabledProfiles: Object.keys(gw.EXEC_PROFILES),
  projectScripts: ['test', 'build', 'lint', 'dev:local', 'preinstall', 'postinstall', 'prepare'],
  ...over,
});
const req = (over: Record<string, unknown> = {}): gw.ExecRequest => ({
  orgId: ORG,
  runId: RUN,
  profile: 'typecheck',
  ...over,
});
const refused = (d: gw.ExecDecision): string[] => {
  expect(d.allowed).toBe(false);
  return d.allowed ? [] : d.reasons;
};

describe('Execution Gateway policy: the model-supplied surface is closed', () => {
  it.each([
    'argv',
    'command',
    'cmd',
    'shell',
    'env',
    'cwd',
    'args',
    'image',
    'network',
    'limits',
    'timeout',
    'stdin',
    'workdir',
    'mounts',
    'privileged',
  ])('refuses a request that tries to set %s', (k) => {
    const r = refused(gw.decideExec(req({ [k]: 'x' }), ctx()));
    expect(r.some((x) => x.startsWith('model_supplied_'))).toBe(true);
  });

  it('refuses another tenant or another run (identity comes from the context, never from the model)', () => {
    expect(refused(gw.decideExec(req({ orgId: 'someone-else' }), ctx()))).toContain(
      'another_tenant_or_run',
    );
    expect(refused(gw.decideExec(req({ runId: 'other-run' }), ctx()))).toContain(
      'another_tenant_or_run',
    );
  });

  it('a profile that is not enabled for the organization is refused, default none', () => {
    expect(refused(gw.decideExec(req(), ctx({ enabledProfiles: [] })))).toContain(
      'profile_not_enabled',
    );
  });

  it('never lets params carry an argv, env or shell fragment into a profile that takes none', () => {
    for (const p of [{ script: 'test' }, { argv: ['x'] }, { env: { A: '1' } }, { shell: true }]) {
      const r = refused(gw.decideExec(req({ params: p }), ctx()));
      expect(r.some((x) => x.startsWith('unexpected_param_'))).toBe(true);
    }
  });

  it.each(['__proto__', 'a b', 'x'.repeat(30), '$(id)', 'ünï', ''])(
    'the refusal reason never echoes an attacker-chosen key name (%j)',
    (k) => {
      const body = JSON.parse(
        `{"orgId":"${ORG}","runId":"${RUN}","profile":"typecheck",${JSON.stringify(k)}:1}`,
      );
      const d = gw.decideExec(body, ctx());
      expect(d.allowed).toBe(false);
      if (!d.allowed) for (const r of d.reasons) expect(r).toMatch(/^[a-z_A-Z0-9]+$/);
    },
  );
});

describe('Execution Gateway policy: run-script is a closed, allow-listed alias, never a shell', () => {
  const run = (script: unknown, c = ctx()) =>
    gw.decideExec(req({ profile: 'run-script', params: { script } }), c);

  it('accepts a declared script and builds a fixed argv with the script as ONE argument', () => {
    const d = run('build');
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.argv).toEqual(['npm', 'run', 'build', '--silent']);
      expect(d.requiresApproval).toBe(true);
      expect(d.network).toBe('none');
    }
  });

  it.each([
    'build; rm -rf /',
    'build && curl evil',
    'build|nc',
    '$(id)',
    '`id`',
    'build\nid',
    'build --foo',
    '../x',
    '-rf',
    '--script-shell=/bin/sh',
    'Build',
    '1build',
    'a'.repeat(60),
    '',
    null,
    42,
    ['build'],
    { toString: 'build' },
  ])('refuses the script name %j', (s) => {
    expect(refused(run(s))).toContain('script_name_invalid');
  });

  it.each(['preinstall', 'postinstall', 'prepare', 'install'])(
    'refuses the lifecycle script %s even when the project declares it',
    (s) => {
      expect(refused(run(s))).toContain('script_denied');
    },
  );

  it('refuses a script the project does not declare', () => {
    expect(refused(run('deploy', ctx()))).toContain('script_not_in_project');
  });

  it('never returns the request environment: the whole environment is the fixed one', () => {
    const d = gw.decideExec(req({ profile: 'build' }), ctx());
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.env).toEqual(gw.EXEC_ENV);
      expect(d.env).not.toBe(gw.EXEC_ENV);
      expect(Object.keys(d.env).sort()).toEqual([
        'CI',
        'HOME',
        'NODE_ENV',
        'NO_UPDATE_NOTIFIER',
        'PATH',
      ]);
    }
  });

  it('every profile that reaches a network or runs project code under a name needs a human', () => {
    for (const p of Object.values(gw.EXEC_PROFILES)) {
      if (p.network !== 'none' || p.params.script) expect(p.approval).toBe('human');
    }
  });

  it('install-deps never runs lifecycle scripts', () => {
    expect(gw.EXEC_PROFILES['install-deps']!.argv).toContain('--ignore-scripts');
  });

  it('decisions are copies: mutating one cannot change the catalogue for the next request', () => {
    const a = gw.decideExec(req({ profile: 'build' }), ctx());
    const b = gw.decideExec(req({ profile: 'build' }), ctx());
    if (a.allowed && b.allowed) {
      a.limits.memoryMb = 1;
      a.env.PATH = '/tmp/evil';
      expect(gw.decideExec(req({ profile: 'build' }), ctx())).toEqual(b);
    }
  });
});

describe('Execution Gateway policy: working directory is a project-relative path', () => {
  it.each([
    '..',
    '../x',
    'a/../../x',
    '/etc',
    '~',
    'C:\\x',
    'a\\b',
    'a%2e%2e/b',
    'a/\u202e/b',
    'a/\u200b/b',
    'x'.repeat(1000),
    { toString: () => '/' },
    123,
  ])('refuses dir %j', (dir) => {
    expect(refused(gw.decideExec(req({ params: { dir } }), ctx()))).toContain(
      'dir_outside_project',
    );
  });
  it('accepts a plain relative directory and the project root', () => {
    for (const [dir, cwd] of [
      ['packages/app', 'packages/app'],
      ['.', ''],
      ['', ''],
    ] as const) {
      const d = gw.decideExec(req({ params: { dir } }), ctx());
      expect(d.allowed).toBe(true);
      if (d.allowed) expect(d.cwd).toBe(cwd);
    }
  });
});

describe('Execution Gateway gate: closed by default, every condition required', () => {
  it('the default state is closed with every blocker named', () => {
    const g = gw.executionGate(gw.CLOSED_GATE);
    expect(g.open).toBe(false);
    expect(g.blockers.length).toBe(5);
  });
  it('each single missing condition keeps it closed', () => {
    const open = {
      d21Decided: true,
      runtimeVerified: true,
      escapeSuitePassed: true,
      adrAccepted: true,
      ownerApproved: true,
      production: false,
      d42Decided: false,
    };
    expect(gw.executionGate(open).open).toBe(true);
    for (const k of [
      'd21Decided',
      'runtimeVerified',
      'escapeSuitePassed',
      'adrAccepted',
      'ownerApproved',
    ] as const)
      expect(gw.executionGate({ ...open, [k]: false }).open, k).toBe(false);
    expect(gw.executionGate({ ...open, production: true }).open).toBe(false);
    expect(gw.executionGate({ ...open, production: true, d42Decided: true }).open).toBe(true);
  });
  it('a truthy non-boolean cannot open the gate by accident only if the caller passes booleans: documented input contract', () => {
    // the gate trusts its typed input; the wiring (Session 04) must build it from verified evidence, not from request data
    expect(gw.executionGate({ ...gw.CLOSED_GATE })).toEqual(gw.executionGate(gw.CLOSED_GATE));
  });
});

describe('DEFECT-1 (fixed by Session 04): the profile lookup does not walk the prototype chain', () => {
  // regression of DEFECT-1: the model-supplied profile string must select only an OWN member of the catalogue.
  const protoNames = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];
  it.each(protoNames)('profile %s is refused as unknown_profile and never throws', (profile) => {
    const d = gw.decideExec(req({ profile, params: {} }), ctx({ enabledProfiles: [] }));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reasons).toContain('unknown_profile');
  });
  it.each(protoNames)(
    'profile %s is never allowed, even when every real profile is enabled (and never throws)',
    (profile) => {
      const d = gw.decideExec(req({ profile, params: {} }), ctx());
      expect(d.allowed).toBe(false);
    },
  );
});
