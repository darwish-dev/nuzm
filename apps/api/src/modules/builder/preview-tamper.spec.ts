import type { Db } from '@nuzm/platform';
import { describe, expect, it } from 'vitest';
import type { AuditSink } from '../../common/audit';
import { loadBuilderConfig } from './internal/model';
import { PreviewService, tokenHash } from './internal/preview.service';

/**
 * W2, deterministic part: the preview service's decision to serve or to answer 404, driven by a SEEDED, exhaustive tamper corpus against an in-memory store (no
 * database, no network, no clock except the injected expiry). The same corpus runs the same way every time, so a failure is a regression, never flakiness. The
 * database-backed behaviour (headers, expiry through SQL, cross-org RLS) stays in builder.int.spec.ts; this file pins the pure decision table.
 */
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function rng(seed: number) {
  let a = seed >>> 0; // mulberry32
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const next = rng(0x5eed);
const token = () => Array.from({ length: 32 }, () => B32[Math.floor(next() * 32)]).join('');

const cfg = loadBuilderConfig({
  BUILDER_PREVIEW_DOMAIN: 'preview.nuzm-preview.test',
  BUILDER_CONSOLE_ORIGIN: 'https://console.nuzm.test',
});
const D = cfg.previewDomain;
const T_OK = token();
const T_EXPIRED = token();
const T_REVOKED = token();
const T_DELETED = token();
const T_ORG_B = token();
const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

interface Prev {
  org_id: string;
  project_id: string;
  version_id: string;
  expires_at: string;
  revoked_at: string | null;
  deleted_at: string | null;
}
const previews = new Map<string, Prev>([
  [
    tokenHash(T_OK),
    {
      org_id: 'org-a',
      project_id: 'p-a',
      version_id: 'v-a',
      expires_at: FUTURE,
      revoked_at: null,
      deleted_at: null,
    },
  ],
  [
    tokenHash(T_EXPIRED),
    {
      org_id: 'org-a',
      project_id: 'p-a',
      version_id: 'v-a',
      expires_at: PAST,
      revoked_at: null,
      deleted_at: null,
    },
  ],
  [
    tokenHash(T_REVOKED),
    {
      org_id: 'org-a',
      project_id: 'p-a',
      version_id: 'v-a',
      expires_at: FUTURE,
      revoked_at: PAST,
      deleted_at: null,
    },
  ],
  [
    tokenHash(T_DELETED),
    {
      org_id: 'org-a',
      project_id: 'p-a',
      version_id: 'v-a',
      expires_at: FUTURE,
      revoked_at: null,
      deleted_at: PAST,
    },
  ],
  [
    tokenHash(T_ORG_B),
    {
      org_id: 'org-b',
      project_id: 'p-b',
      version_id: 'v-b',
      expires_at: FUTURE,
      revoked_at: null,
      deleted_at: null,
    },
  ],
]);
// files by `project|version|path`; org B has a secret page that must never be reachable from org A's preview
const files = new Map<string, { mime: string; content: Buffer }>([
  ['p-a|v-a|index.html', { mime: 'text/html; charset=utf-8', content: Buffer.from('<h1>A</h1>') }],
  [
    'p-a|v-a|ar/index.html',
    { mime: 'text/html; charset=utf-8', content: Buffer.from('<h1>A ar</h1>') },
  ],
  ['p-a|v-a|assets/styles.css', { mime: 'text/css; charset=utf-8', content: Buffer.from('p{}') }],
  [
    'p-b|v-b|index.html',
    { mime: 'text/html; charset=utf-8', content: Buffer.from('<h1>SECRET B</h1>') },
  ],
  ['p-b|v-b|secret.html', { mime: 'text/html; charset=utf-8', content: Buffer.from('SECRET B') }],
]);

function service() {
  const orgCalls: string[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('FROM builder.previews pv'))
        return { rows: previews.has(String(params[0])) ? [previews.get(String(params[0]))] : [] };
      if (sql.includes('FROM builder.project_files')) {
        const f = files.get(`${params[0]}|${params[1]}|${params[2]}`);
        return { rows: f ? [f] : [] };
      }
      if (sql.includes('FROM builder.project_versions'))
        return { rows: [{ site_model: { pages: [] } }] };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
  const db = {
    withPlatformScope: async (fn: (c: typeof client) => unknown) => fn(client),
    withOrg: async (org: string, fn: (c: typeof client) => unknown) => {
      orgCalls.push(org);
      return fn(client);
    },
  } as unknown as Db;
  const audit = { record: async () => undefined } as unknown as AuditSink;
  return { svc: new PreviewService(db, audit, cfg), orgCalls };
}
const flat = (r: { status: number; headers: Record<string, string>; body: Buffer | string }) =>
  JSON.stringify([r.status, r.headers, Buffer.from(r.body).toString('utf8')]);
const HOST = (t: string) => `${t}.${D}`;

describe('preview serving: the decision table is deterministic', () => {
  it('serves the right file for the right host and token, and nothing else', async () => {
    const { svc } = service();
    const r = await svc.serve(HOST(T_OK), T_OK, 'index.html');
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body).toString()).toBe('<h1>A</h1>');
    expect((await svc.serve(HOST(T_OK), T_OK, '')).status).toBe(200); // root -> index.html
    expect((await svc.serve(HOST(T_OK), T_OK, 'ar/')).status).toBe(200); // directory -> index.html
    expect(Buffer.from((await svc.serve(HOST(T_OK), T_OK, 'ar/')).body).toString()).toBe(
      '<h1>A ar</h1>',
    );
    // host is compared case-insensitively and the port is ignored (dev edge)
    expect((await svc.serve(`${HOST(T_OK).toUpperCase()}:4000`, T_OK, '')).status).toBe(200);
    // unknown file inside a valid preview
    expect((await svc.serve(HOST(T_OK), T_OK, 'nope.html')).status).toBe(404);
  });

  it('every failure answers the SAME 404 (no oracle between "wrong token", "expired", "revoked", "deleted", "wrong host")', async () => {
    const { svc } = service();
    const reference = flat(await svc.serve(HOST(token()), token(), ''));
    const cases: [string, string | undefined, string, string][] = [
      [
        'unknown token',
        HOST(T_OK.replace(/^./, (c) => B32[(B32.indexOf(c) + 1) % 32]!)),
        T_OK.replace(/^./, (c) => B32[(B32.indexOf(c) + 1) % 32]!),
        '',
      ],
      ['expired', HOST(T_EXPIRED), T_EXPIRED, ''],
      ['revoked', HOST(T_REVOKED), T_REVOKED, ''],
      ['deleted project', HOST(T_DELETED), T_DELETED, ''],
      ['console host', 'console.nuzm.test', T_OK, ''],
      ['api host', 'api.nuzm.test', T_OK, ''],
      ['no host', undefined, T_OK, ''],
      ['apex preview domain', D, T_OK, ''],
      ['sibling subdomain', `evil.${D}`, T_OK, ''],
      ['token as a deeper label', `${T_OK}.evil.${D}`, T_OK, ''],
      ['suffix attack', `${HOST(T_OK)}.evil.test`, T_OK, ''],
      ['prefix attack', `x${HOST(T_OK)}`, T_OK, ''],
      ['other preview host with this token', HOST(T_ORG_B), T_OK, ''],
      ['this host with the other preview token', HOST(T_OK), T_ORG_B, ''],
    ];
    for (const [name, host, t, path] of cases)
      expect(flat(await svc.serve(host, t, path)), name).toBe(reference);
    expect(JSON.parse(reference)[0]).toBe(404);
  });

  it('every single-character tamper of the token is a 404 (all 32 positions x every other base32 character)', async () => {
    const { svc } = service();
    let n = 0;
    for (let i = 0; i < 32; i++)
      for (const c of B32) {
        if (c === T_OK[i]) continue;
        const t = `${T_OK.slice(0, i)}${c}${T_OK.slice(i + 1)}`;
        const r = await svc.serve(HOST(t), t, '');
        expect(r.status, `${i}:${c}`).toBe(404);
        n++;
      }
    expect(n).toBe(32 * 31);
  });

  it('malformed tokens (length, case, alphabet, separators) are a 404 before any lookup', async () => {
    const { svc, orgCalls } = service();
    const bad = [
      T_OK.slice(0, 31),
      `${T_OK}a`,
      T_OK.toUpperCase(),
      `${T_OK.slice(0, 31)}1`, // 1 is not in the alphabet
      `${T_OK.slice(0, 31)}0`,
      `${T_OK.slice(0, 31)}8`,
      `${T_OK.slice(0, 31)}-`,
      `${T_OK.slice(0, 31)}.`,
      `${T_OK.slice(0, 16)}\u0000${T_OK.slice(17)}`,
      '',
      ' '.repeat(32),
      '../'.repeat(11),
      "' OR 1=1 --".padEnd(32, 'a'),
    ];
    for (const t of bad)
      expect((await svc.serve(`${t}.${D}`, t, '')).status, JSON.stringify(t)).toBe(404);
    expect(orgCalls).toEqual([]); // not one of them reached the database
  });

  it('path tricks never leave the preview: traversal, encodings, backslash, NUL, absolute, other project', async () => {
    const { svc } = service();
    const trick = [
      '../index.html',
      '..',
      'ar/../../p-b/index.html',
      '%2e%2e/secret.html',
      '%2E%2E%2Fsecret.html',
      '%252e%252e/secret.html',
      'ar/..%2f..%2fsecret.html',
      '..\\secret.html',
      'ar\\..\\..\\secret.html',
      'index.html%00.png',
      'index.html\0',
      '/etc/passwd',
      '//etc/passwd',
      '....//secret.html',
      '.%2e/secret.html',
      'p-b/v-b/index.html',
      '%',
      '%zz',
      '%E0%A4%A',
      '%c0%ae%c0%ae/secret.html',
    ];
    for (const p of trick) {
      const r = await svc
        .serve(HOST(T_OK), T_OK, p)
        .catch((e: unknown) => ({ status: 500, headers: {}, body: String(e) }));
      expect(r.status, p).toBe(404);
      expect(Buffer.from(r.body).toString(), p).not.toContain('SECRET');
    }
  });

  it("cross-tenant: org A's preview can only ever read org A's project, and the database scope is the PREVIEW's org", async () => {
    const { svc, orgCalls } = service();
    expect(Buffer.from((await svc.serve(HOST(T_OK), T_OK, 'index.html')).body).toString()).toBe(
      '<h1>A</h1>',
    );
    expect((await svc.serve(HOST(T_OK), T_OK, 'secret.html')).status).toBe(404);
    expect(orgCalls.every((o) => o === 'org-a')).toBe(true);
    const b = await svc.serve(HOST(T_ORG_B), T_ORG_B, 'secret.html');
    expect(Buffer.from(b.body).toString()).toBe('SECRET B'); // B's own token reads B's file...
    expect(orgCalls.at(-1)).toBe('org-b'); // ...inside B's scope
  });

  it('a 200 carries the isolation headers: strict CSP bound to the console as the only frame ancestor, nosniff, no cookies, no CORS, noindex, no-store', async () => {
    const { svc } = service();
    const r = await svc.serve(HOST(T_OK), T_OK, 'index.html');
    const h = r.headers;
    expect(h['content-security-policy']).toContain("default-src 'self'");
    expect(h['content-security-policy']).toContain("script-src 'self'");
    expect(h['content-security-policy']).toContain("base-uri 'none'");
    expect(h['content-security-policy']).toContain('frame-ancestors https://console.nuzm.test');
    expect(h['content-security-policy']).not.toMatch(/unsafe-|\*/);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['cache-control']).toBe('no-store');
    expect(h['x-robots-tag']).toMatch(/noindex/);
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['permissions-policy']).toContain('camera=()');
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toEqual(
      expect.arrayContaining(['set-cookie']),
    );
    expect(Object.keys(h).some((k) => k.toLowerCase().startsWith('access-control-'))).toBe(false);
  });

  it('is repeatable: the whole corpus gives byte-identical answers on a second pass', async () => {
    const a = service().svc;
    const b = service().svc;
    const inputs: [string | undefined, string, string][] = [
      [HOST(T_OK), T_OK, 'index.html'],
      [HOST(T_OK), T_OK, '../x'],
      [HOST(T_EXPIRED), T_EXPIRED, ''],
      ['x', T_OK, ''],
    ];
    for (const [h, t, p] of inputs)
      expect(flat(await a.serve(h, t, p))).toBe(flat(await b.serve(h, t, p)));
  });
});
