import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P3-S08: the owner-checklist validation scripts (docs/phase3/validate/) are READ-ONLY and never print a secret. This unit test (a) lints every script for mutating commands in
 * command position and for the contract header, and (b) runs the scripts whose logic needs no machine, network or tool with controlled inputs.
 */
const DIR = join(process.cwd(), '../../docs/phase3/validate');
const scripts = readdirSync(DIR).filter((f) => f.endsWith('.sh'));
const run = (script: string, args: string[] = [], env: Record<string, string> = {}) => {
  const r = spawnSync('bash', [join(DIR, script), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { out: `${r.stdout}${r.stderr}`, code: r.status };
};

/**
 * the executable part of a script: comments removed, command substitutions `$(...)` pulled out and linted as commands of their own, then quoted strings (which hold hint texts that
 * mention sudo, brew, sdkmanager but are never executed) removed
 */
const SUBST = /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
const executable = (src: string): string => {
  let text = src
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const commands: string[] = [];
  for (let pass = 0; pass < 4; pass++)
    text = text.replace(SUBST, (_m, body: string) => (commands.push(body), '$X'));
  const strip = (t: string) =>
    t.replace(/"(?:[^"\\`$]|\\.|\$(?!\())*"/g, '""').replace(/'[^']*'/g, "''");
  return [strip(text), ...commands.map((c) => strip(`(${c}`))].join('\n');
};
const FORBIDDEN =
  /(^|[;&|(]|\$\()\s*(sudo|rm|rmdir|mv|cp|mkdir|touch|tee|dd|chmod|chown|brew|gem|pip|npm|yarn|apt|apt-get|yum|ssh-keygen|keytool|kill|pkill|git (add|commit|push|checkout|reset|stash|clean|merge|rebase)|pnpm (install|add|remove|update)|flutter (config|precache|upgrade|create|build|pub)|sdkmanager|xcodebuild -(license|runFirstLaunch|downloadPlatform)|xcode-select -s|sysadminctl|dscl|defaults write|launchctl|openssl (genrsa|req|x509 -req)|curl [^\n]*(-X |--request|--data|-d |--upload|-F |-T ))/;

describe('validate scripts: read-only contract', () => {
  it('finds the section scripts', () => {
    expect(scripts.sort()).toEqual(
      [
        'A-build-host.sh',
        'B-accounts.sh',
        'C-servers.sh',
        'D-dns.sh',
        'E-environment.sh',
        'G-approvals.sh',
        'H-evidence.sh',
        'lib.sh',
        'run-all.sh',
      ].sort(),
    );
  });
  for (const s of scripts) {
    it(`${s}: no mutating command in command position`, () => {
      const m = FORBIDDEN.exec(executable(readFileSync(join(DIR, s), 'utf8')));
      expect(m ? m[0] : null).toBeNull();
    });
    it(`${s}: states the read-only contract and is valid bash`, () => {
      const src = readFileSync(join(DIR, s), 'utf8');
      expect(src).toMatch(/READ-ONLY/);
      const r = spawnSync('bash', ['-n', join(DIR, s)], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    });
  }
  it('the lint itself is not vacuous: it flags a planted mutating command', () => {
    expect(FORBIDDEN.test(executable('echo x; sudo rm -rf /tmp/x'))).toBe(true);
    expect(FORBIDDEN.test(executable('x=$(brew install foo)'))).toBe(true);
    expect(FORBIDDEN.test(executable('curl -s -X POST https://x'))).toBe(true);
    expect(
      FORBIDDEN.test(executable('fail A2 "install Xcode; sudo xcode-select -s /x" "hint"')),
    ).toBe(false);
  });
});

describe('validate scripts: behaviour', () => {
  it('E: nothing set is not a failure (SKIP), and exit 0', () => {
    const r = run('E-environment.sh');
    expect(r.code).toBe(0);
    expect(r.out).toContain('SKIP   E1');
    expect(r.out).toContain('PASS   E6');
  });
  it('E: --expect makes the missing variable a FAIL that names it, exit 1; --strict also fails on SKIP', () => {
    const r = run('E-environment.sh', ['--expect', 'live-provider,mobile']);
    expect(r.code).toBe(1);
    for (const v of [
      'AI_LIVE_PROVIDERS',
      'AI_PROBE_APPROVALS',
      'SESSION_SEAL_KEY',
      'MOBILE_FLUTTER_LOCAL',
    ])
      expect(r.out).toMatch(new RegExp(`FAIL +E\\d +${v}`));
    expect(run('E-environment.sh', ['--strict']).code).toBe(1);
  });
  it('E: a correct set passes and NO value is ever printed', () => {
    const seal = 'S3al-Key-Value-Must-Not-Appear-0123456789ABCDEFG';
    const probe = JSON.stringify([
      {
        ref: 'REF-SECRET-MARK',
        approvedBy: 'owner-name-mark',
        environment: 'non-production',
        maxRequests: 13,
        maxTotalTokens: 14716,
      },
    ]);
    const r = run('E-environment.sh', [], {
      AI_LIVE_PROVIDERS: 'claude',
      AI_PROBE_APPROVALS: probe,
      SESSION_SEAL_KEY: seal,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('PASS   E1');
    expect(r.out).toContain('PASS   E2');
    expect(r.out).toContain('PASS   E3');
    expect(r.out).not.toContain(seal);
    expect(r.out).not.toContain('REF-SECRET-MARK');
    expect(r.out).not.toContain('owner-name-mark');
  });
  it('E: wrong shapes FAIL: another provider, caps above the D9 plan, a short seal key, production, an exported provider key', () => {
    expect(run('E-environment.sh', [], { AI_LIVE_PROVIDERS: 'openai' }).out).toContain('FAIL   E1');
    const big = JSON.stringify([
      {
        ref: 'R1',
        approvedBy: 'o',
        environment: 'non-production',
        maxRequests: 500,
        maxTotalTokens: 14716,
      },
    ]);
    expect(run('E-environment.sh', [], { AI_PROBE_APPROVALS: big }).out).toMatch(
      /FAIL +E2.*maxRequests/,
    );
    const prod = JSON.stringify([
      {
        ref: 'R1',
        approvedBy: 'o',
        environment: 'production',
        maxRequests: 13,
        maxTotalTokens: 14716,
      },
    ]);
    expect(run('E-environment.sh', [], { AI_PROBE_APPROVALS: prod }).out).toMatch(
      /FAIL +E2.*non-production/,
    );
    expect(run('E-environment.sh', [], { SESSION_SEAL_KEY: 'short' }).out).toContain('FAIL   E3');
    expect(run('E-environment.sh', [], { NODE_ENV: 'production' }).out).toContain('FAIL   E0');
    const k = 'sk-ant-VALUE-THAT-MUST-NOT-BE-PRINTED';
    const r = run('E-environment.sh', [], { ANTHROPIC_API_KEY: k });
    expect(r.out).toContain('FAIL   E6');
    expect(r.out).toContain('ANTHROPIC_API_KEY');
    expect(r.out).not.toContain(k);
  });
  it('C and D: without a host argument they check nothing remote: SKIP lines naming the option, exit 0', () => {
    const c = run('C-servers.sh');
    expect(c.code).toBe(0);
    expect(c.out).toContain('--runtime-node');
    expect(c.out).toContain('--hosting-node');
    expect(c.out).not.toMatch(/^PASS/m);
    const d = run('D-dns.sh');
    expect(d.code).toBe(0);
    expect(d.out).toContain('--preview-domain');
    expect(run('C-servers.sh', ['--strict']).code).toBe(1);
  });
  it('D: the preview domain must not be the console domain or a subdomain of it (ADR-060) - decided without any network call', () => {
    const r = run('D-dns.sh', [
      '--preview-domain',
      'preview.console.example.test',
      '--console-domain',
      'console.example.test',
    ]);
    expect(r.out).toMatch(/FAIL +D5/);
  });
  it('G: lists the exact missing approvals (none is recorded today) and exits 1', () => {
    const r = run('G-approvals.sh', ['--target', 'T3']);
    expect(r.code).toBe(1);
    for (const id of ['D2', 'D5', 'D6', 'D4', 'D3', 'D9', 'B-Android', 'B-SIGN'])
      expect(r.out).toMatch(new RegExp(`FAIL +${id} `));
    expect(r.out).toContain('docs/parallel/OWNER-APPROVAL-PACK.md section 6');
  }, 120_000);
});
