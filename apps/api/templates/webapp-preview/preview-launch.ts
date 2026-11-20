// Live preview launcher (ADR-063). Trusted platform code, copied next to a generated application's runtime: starts it on a loopback port with an in-memory store,
// a demo administrator and a little sample data, prints {"port","session"} once, and exits when the platform closes stdin or the preview expires.
// The environment holds no platform secret and no database address: this process can reach nothing but its own memory.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { createApp } from './src/app.ts';
import { hashPassword, signToken } from './src/auth.ts';
import { listen } from './src/http.ts';
import { MemoryStore } from './src/memory-store.ts';
import { META } from './src/meta.ts';
import type { EntityMeta, FieldMeta } from './src/types.ts';

const TTL_MS = Math.max(60_000, Number(process.env.PREVIEW_TTL_MS ?? 1_800_000));
const ROWS = 5;
const secret = randomBytes(32).toString('hex');
const store = new MemoryStore(META);
const roles = Object.values(META.roles);
const adminRole = (roles.find((r) => r.admin) ?? roles[0])!.name;
const uid = randomUUID();
await store.insertUser({
  id: uid,
  email: 'preview@example.test',
  name: META.defaultLocale === 'ar' ? 'مستخدم المعاينة' : 'Preview user',
  role: adminRole,
  teamId: null,
  locale: META.defaultLocale === 'en' ? 'en' : 'ar',
  passwordHash: await hashPassword(randomBytes(24).toString('hex')), // nobody can sign in with it: the session below is the only way in
  active: true,
  createdAt: new Date().toISOString(),
});
const { router } = createApp(
  {
    port: 0,
    store: 'memory',
    databaseUrl: null,
    sessionSecret: secret,
    notifyUrl: null,
    notifyToken: null,
  },
  { store },
);
const session = signToken(secret, uid, Math.ceil(TTL_MS / 1000), Date.now());

/* ---------- sample data: a few synthetic rows per entity, created through the app's own API (so they pass its validation) ---------- */
const label = (e: EntityMeta) => (META.defaultLocale === 'en' ? e.labels.en : e.labels.ar);
const created = new Map<string, string[]>();
function value(e: EntityMeta, f: FieldMeta, i: number): unknown {
  const n = i + 1;
  const clampNum = (x: number) => Math.min(f.max ?? x, Math.max(f.min ?? x, x));
  const cut = (s: string) => (f.maxLength ? s.slice(0, f.maxLength) : s);
  switch (f.type) {
    case 'string':
      return cut(`${label(e)} ${n}`);
    case 'text':
      return cut(META.defaultLocale === 'en' ? `Sample note ${n}.` : `ملاحظة تجريبية ${n}.`);
    case 'email':
      return `sample${n}.${e.plural.replace(/_/g, '-')}@example.test`;
    case 'phone':
      return `+96650000000${n}`;
    case 'url':
      return `https://example.test/${e.plural}/${n}`;
    case 'integer':
      return clampNum(n * 10);
    case 'decimal':
      return clampNum(n * 1250.5);
    case 'boolean':
      return i % 2 === 0;
    case 'date':
      return new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10);
    case 'datetime':
      return new Date(Date.now() + i * 3_600_000 * 5).toISOString();
    case 'enum':
      return f.enumValues?.length ? f.enumValues[i % f.enumValues.length] : undefined;
    case 'reference': {
      const ids = created.get(f.references ?? '') ?? [];
      return ids.length ? ids[i % ids.length] : undefined;
    }
    default:
      return undefined; // files are left empty
  }
}
async function seed(e: EntityMeta) {
  const ids: string[] = [];
  for (let i = 0; i < ROWS; i++) {
    const row: Record<string, unknown> = {};
    for (const f of e.fields) {
      const v = value(e, f, i);
      if (v !== undefined) row[f.name] = v;
    }
    const r = await router.handle(
      'POST',
      `${META.basePath}/${e.plural}`,
      {
        authorization: `Bearer ${session}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      JSON.stringify(row),
    );
    const id = (r.body as { id?: unknown } | null)?.id;
    if (r.status < 300 && typeof id === 'string') ids.push(id);
  }
  created.set(e.name, ids);
}
// referenced entities first, so references can point at real rows
const pending = Object.values(META.entities);
for (let pass = 0; pending.length && pass < 20; pass++)
  for (const e of [...pending]) {
    const deps = e.fields.filter(
      (f) => f.type === 'reference' && f.references && f.references !== e.name,
    );
    if (pass < 19 && deps.some((f) => pending.some((p) => p.name === f.references))) continue;
    await seed(e).catch(() => undefined);
    pending.splice(pending.indexOf(e), 1);
  }

/* ---------- static front end ---------- */
const PUBLIC = join(import.meta.dirname, 'public');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
async function staticFile(path: string) {
  const rel = normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(
    /^[/\\]+/,
    '',
  );
  const full = join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC + sep)) return null;
  const bytes =
    (await readFile(full).catch(() => null)) ??
    (await readFile(join(PUBLIC, 'index.html')).catch(() => null));
  if (!bytes) return null;
  const type =
    (await readFile(full)
      .then(() => TYPES[extname(full)])
      .catch(() => null)) ?? TYPES['.html']!;
  return { status: 200, bytes: new Uint8Array(bytes), contentType: type };
}

const server = listen(router, 0, staticFile, META.basePath);
server.on('listening', () => {
  const { port } = server.address() as AddressInfo;
  process.stdout.write(`${JSON.stringify({ port, session })}\n`);
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
setTimeout(() => process.exit(0), TTL_MS);
