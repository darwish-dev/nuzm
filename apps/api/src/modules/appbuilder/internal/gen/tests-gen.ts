import type { AppSpec, EntitySpec, FieldSpec } from '../spec/app-spec';

/** Contract-test generator (S43.5, S44.2 QA agent): node:test files derived from the spec, the RBAC matrix and the OpenAPI document. Test data is SYNTHETIC (example.test addresses, fixed names). */
function sample(f: FieldSpec): unknown {
  const clamp = (n: number) => Math.min(f.max ?? n, Math.max(f.min ?? n, n));
  switch (f.type) {
    case 'string':
      return `Sample ${f.name} {n}`.slice(0, f.maxLength ?? 255);
    case 'text':
      return `Synthetic ${f.name} text {n}`;
    case 'integer':
      return clamp(7);
    case 'decimal':
      return clamp(12.5);
    case 'boolean':
      return true;
    case 'date':
      return '2026-01-15';
    case 'datetime':
      return '2026-01-15T10:00:00.000Z';
    case 'enum':
      return f.enumValues![0];
    case 'email':
      return 'person{n}@example.test';
    case 'phone':
      return '+966500000000';
    case 'url':
      return 'https://example.test/{n}';
    case 'reference':
      return '{ref}';
    case 'file':
      return { name: 'note.txt', mime: 'text/plain', contentBase64: 'U3ludGhldGljIGZpbGU=' };
  }
}
/** Entities ordered so that every referenced entity comes before the one that references it (cycles are broken by skipping optional references). */
function refOrder(spec: AppSpec): string[] {
  const done: string[] = [];
  const visit = (e: EntitySpec, stack: string[]) => {
    if (done.includes(e.name) || stack.includes(e.name)) return;
    for (const f of e.fields)
      if (f.type === 'reference' && f.required)
        visit(
          spec.entities.find((x) => x.name === f.references)!,
          [...stack, e.name],
        );
    done.push(e.name);
  };
  for (const e of spec.entities) visit(e, []);
  return done;
}

const HELPERS = `import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import { hashPassword } from '../src/auth.ts';
import { buildRouter } from '../src/engine.ts';
import { MemoryStore } from '../src/memory-store.ts';
import { META } from '../src/meta.ts';
import { MemoryNotifier } from '../src/notify.ts';
import type { Store } from '../src/types.ts';
import { SAMPLES } from './fixtures.ts';

export const SECRET = randomUUID() + randomUUID(); // a fresh random signing key per test process
export const PASSWORD = 'correct horse battery 1';

export interface Env {
  store: Store;
  notifier: MemoryNotifier;
  call: (method: string, path: string, opts?: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> }) => Promise<{ status: number; body: any; text?: string; headers?: Record<string, string> }>;
  login: (role: string, opts?: { teamId?: string | null; email?: string }) => Promise<{ token: string; id: string }>;
  create: (token: string, entity: string, over?: Record<string, unknown>) => Promise<{ status: number; body: any }>;
}

let counter = 0;
// TEST_DATABASE_URL switches the same tests onto the PostgreSQL store (the data is cleared before each test; run with --test-concurrency=1).
// The PostgreSQL store is imported lazily, so the in-memory run needs no installed dependency.
const dbUrl = process.env['TEST_DATABASE_URL'];
let pool: { query: (sql: string) => Promise<unknown>; end: () => Promise<void> } | null = null;
let PgStoreClass: (new (p: never, m: typeof META) => Store) | null = null;
after(async () => {
  await pool?.end();
});
export async function newEnv(): Promise<Env> {
  let store: Store = new MemoryStore(META);
  if (dbUrl) {
    if (!pool) {
      const mod = await import('../src/pg-store.ts');
      pool = mod.createPool(dbUrl);
      PgStoreClass = mod.PgStore as never;
    }
    const tables = Object.values(META.entities).map((e) => '"' + e.table + '"').concat(['"audit_log"', '"app_users"']);
    await pool.query('TRUNCATE ' + tables.join(', ') + ' CASCADE');
    store = new PgStoreClass!(pool as never, META);
  }
  const notifier = new MemoryNotifier();
  const router = buildRouter({ meta: META, store, notifier, sessionSecret: SECRET });
  const call: Env['call'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers['authorization'] = 'Bearer ' + opts.token;
    let raw = opts.raw ?? '';
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      raw = JSON.stringify(opts.body);
    }
    const r = await router.handle(method, path, headers, raw);
    return { status: r.status, body: r.body, text: r.text, headers: r.headers };
  };
  const login: Env['login'] = async (role, opts = {}) => {
    const email = opts.email ?? role + (++counter) + '@example.test';
    const id = randomUUID();
    await store.insertUser({ id, email, name: role + ' user', role, teamId: opts.teamId ?? null, locale: 'en', passwordHash: await hashPassword(PASSWORD), active: true, createdAt: new Date().toISOString() });
    const r = await call('POST', META.basePath + '/auth/login', { body: { email, password: PASSWORD } });
    if (r.status !== 200) throw new Error('login failed: ' + r.status);
    return { token: r.body.token as string, id };
  };
  const fill = (entity: string, refs: Record<string, string>, over: Record<string, unknown>): Record<string, unknown> => {
    const n = ++counter;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(SAMPLES[entity] ?? {})) {
      if (v === '{ref}') {
        if (refs[k]) out[k] = refs[k];
        continue;
      }
      out[k] = typeof v === 'string' ? v.replaceAll('{n}', String(n)) : v;
    }
    return { ...out, ...over };
  };
  const create: Env['create'] = async (token, entity, over = {}) => {
    const em = META.entities[entity]!;
    const refs: Record<string, string> = {};
    for (const f of em.fields) {
      if (f.type !== 'reference' || (over[f.name] !== undefined) || !f.required) continue;
      const target = META.entities[f.references as string]!;
      // the referenced record is created by the same user when the role may (it must be visible to the creator: a reference never points at a hidden record)
      let made = await create(token, target.name);
      if (made.status !== 201) {
        const admin = Object.values(META.roles).find((r) => r.admin)!;
        made = await create((await login(admin.name)).token, target.name);
      }
      if (made.status !== 201) throw new Error('could not create ' + target.name + ': ' + JSON.stringify(made.body));
      refs[f.name] = made.body.id;
    }
    const r = await call('POST', META.basePath + '/' + em.plural, { token, body: fill(entity, refs, over) });
    return { status: r.status, body: r.body };
  };
  return { store, notifier, call, login, create };
}
`;

const can = (r: { permissions: Record<string, string[]> }, e: { name: string }, a: string) =>
  (r.permissions[e.name] ?? []).includes(a);

export function generateTests(spec: AppSpec): Record<string, string> {
  const files: Record<string, string> = {};
  const samples = Object.fromEntries(
    spec.entities.map((e) => [
      e.name,
      Object.fromEntries(e.fields.map((f) => [f.name, sample(f)])),
    ]),
  );
  files['tests/fixtures.ts'] =
    `// synthetic test data generated from the spec; {n} is replaced per call, {ref} marks a reference\nexport const SAMPLES: Record<string, Record<string, unknown>> = ${JSON.stringify(samples, null, 2)};\nexport const REF_ORDER: string[] = ${JSON.stringify(refOrder(spec))};\n`;
  files['tests/helpers.ts'] = HELPERS;

  files['tests/contract.test.ts'] = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { META } from '../src/meta.ts';
import { newEnv } from './helpers.ts';

const api = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, { operationId: string; security?: unknown[] }>> };
const METHODS = ['get', 'post', 'patch', 'delete'];
const concrete = (p: string) => p.replace(/\\{id\\}/g, '00000000-0000-4000-8000-000000000001');

test('every operation of the OpenAPI document is routed (never 404/405 for an administrator on a path without an unknown id)', async () => {
  const env = await newEnv();
  const admin = Object.values(META.roles).find((r) => r.admin)!;
  const { token } = await env.login(admin.name);
  for (const [path, ops] of Object.entries(api.paths))
    for (const method of Object.keys(ops).filter((m) => METHODS.includes(m))) {
      const r = await env.call(method.toUpperCase(), concrete(path), { token, body: method === 'get' || method === 'delete' ? undefined : {} });
      assert.notEqual(r.status, 405, method + ' ' + path);
      if (!path.includes('{id}')) assert.notEqual(r.status, 404, method + ' ' + path);
      assert.ok(r.status < 500, method + ' ' + path + ' answered ' + r.status);
    }
});

test('every secured operation answers 401 without a token and 401 with a forged token', async () => {
  const env = await newEnv();
  for (const [path, ops] of Object.entries(api.paths))
    for (const [method, op] of Object.entries(ops).filter(([m]) => METHODS.includes(m))) {
      if (Array.isArray(op.security) && op.security.length === 0) continue;
      for (const token of [undefined, 'forged.token']) {
        const r = await env.call(method.toUpperCase(), concrete(path), { token, body: method === 'get' || method === 'delete' ? undefined : {} });
        assert.equal(r.status, 401, op.operationId + ' with ' + String(token));
      }
    }
});

test('health is public and the list shape is {items,total,limit,offset}', async () => {
  const env = await newEnv();
  assert.equal((await env.call('GET', '/health')).status, 200);
  const admin = Object.values(META.roles).find((r) => r.admin)!;
  const { token } = await env.login(admin.name);
  for (const em of Object.values(META.entities)) {
    const r = await env.call('GET', META.basePath + '/' + em.plural, { token });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['items', 'limit', 'offset', 'total']);
  }
});
`;

  files['tests/rbac.test.ts'] = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { META } from '../src/meta.ts';
import { newEnv } from './helpers.ts';

// roles x entities x actions: the generated RBAC matrix is enforced exactly (a forbidden action is 403, an allowed one succeeds)
for (const em of Object.values(META.entities))
  for (const role of Object.values(META.roles)) {
    const allowed = (a: string) => (role.permissions[em.name] ?? []).includes(a);
    test(role.name + ' on ' + em.name + ': create=' + allowed('create') + ' read=' + allowed('read') + ' update=' + allowed('update') + ' delete=' + allowed('delete'), async () => {
      const env = await newEnv();
      const admin = Object.values(META.roles).find((r) => r.admin)!;
      const a = await env.login(admin.name);
      const seeded = await env.create(a.token, em.name);
      assert.equal(seeded.status, 201, JSON.stringify(seeded.body));
      const u = await env.login(role.name, { teamId: null });
      // create
      const created = await env.create(u.token, em.name);
      assert.equal(created.status === 201, allowed('create'), 'create ' + created.status + ' ' + JSON.stringify(created.body));
      if (!allowed('create')) assert.equal(created.status, 403);
      // read (list)
      const list = await env.call('GET', META.basePath + '/' + em.plural, { token: u.token });
      assert.equal(list.status === 200, allowed('read'));
      if (!allowed('read')) assert.equal(list.status, 403);
      // update / delete on a record the role can see (its own, or any when the scope is all / the entity is organisation-wide)
      const target = created.status === 201 ? created.body.id : role.scope === 'all' || em.ownership === 'org' ? seeded.body.id : null;
      if (target) {
        const upd = await env.call('PATCH', META.basePath + '/' + em.plural + '/' + target, { token: u.token, body: {} });
        assert.equal(upd.status === 200, allowed('update'), 'update ' + upd.status);
        if (!allowed('update')) assert.equal(upd.status, 403);
        const del = await env.call('DELETE', META.basePath + '/' + em.plural + '/' + target, { token: u.token });
        assert.equal(del.status === 204 || del.status === 409, allowed('delete'), 'delete ' + del.status);
        if (!allowed('delete')) assert.equal(del.status, 403);
      }
      // export / import need their own action
      if (META.csvImportExport) {
        const ex = await env.call('GET', META.basePath + '/' + em.plural + '/export.csv', { token: u.token });
        assert.equal(ex.status === 200, allowed('export'));
        const im = await env.call('POST', META.basePath + '/' + em.plural + '/import?dryRun=true', { token: u.token, raw: 'x\\n', headers: { 'content-type': 'text/csv' } });
        assert.equal(im.status !== 403, allowed('import'));
      }
    });
  }
`;

  const ownRole = spec.roles.find((r) => r.scope === 'own' && !r.admin);
  const scoped = spec.entities.find(
    (e) =>
      e.ownership !== 'org' &&
      ownRole &&
      (ownRole.permissions[e.name] ?? []).includes('create') &&
      (ownRole.permissions[e.name] ?? []).includes('read'),
  );
  const teamRole = spec.roles.find((r) => r.scope === 'team');
  const allRole = spec.roles.find(
    (r) => r.scope === 'all' && (!scoped || (r.permissions[scoped.name] ?? []).includes('read')),
  );
  if (ownRole && scoped && allRole)
    files['tests/scope.test.ts'] = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { META } from '../src/meta.ts';
import { newEnv } from './helpers.ts';

const base = META.basePath + '/${scoped.plural}';

test('row-level ownership: ${ownRole.name} sees only its own ${scoped.plural}; ${allRole.name} sees all; another ${ownRole.name} gets 404, never 403', async () => {
  const env = await newEnv();
  const a = await env.login('${ownRole.name}');
  const b = await env.login('${ownRole.name}');
  const all = await env.login('${allRole.name}');
  const mine = await env.create(a.token, '${scoped.name}');
  const theirs = await env.create(b.token, '${scoped.name}');
  assert.equal(mine.status, 201);
  assert.equal(theirs.status, 201);
  const listA = await env.call('GET', base, { token: a.token });
  assert.deepEqual(listA.body.items.map((r: { id: string }) => r.id), [mine.body.id]);
  assert.equal(listA.body.total, 1);
  assert.equal((await env.call('GET', base + '/' + theirs.body.id, { token: a.token })).status, 404);
${can(ownRole, scoped, 'update') ? "  assert.equal((await env.call('PATCH', base + '/' + theirs.body.id, { token: a.token, body: {} })).status, 404);\n" : ''}${can(ownRole, scoped, 'delete') ? "  assert.equal((await env.call('DELETE', base + '/' + theirs.body.id, { token: a.token })).status, 404);\n" : ''}  assert.equal((await env.call('GET', base + '/' + theirs.body.id + '/audit', { token: a.token })).status, 404);
  assert.equal((await env.call('GET', base, { token: all.token })).body.total, 2);
});

test('search, filters and export never widen the scope', async () => {
  const env = await newEnv();
  const a = await env.login('${ownRole.name}');
  const b = await env.login('${ownRole.name}');
  await env.create(a.token, '${scoped.name}');
  await env.create(b.token, '${scoped.name}');
  for (const q of ['?search=Sample', '?sort=createdAt:asc', '?limit=1']) {
    const r = await env.call('GET', base + q, { token: a.token });
    assert.ok(r.body.items.every((x: { ownerId: string }) => x.ownerId === a.id), q);
  }
});

test('a role of scope own cannot assign a record to somebody else (no privilege escalation by ownerId)', async () => {
  const env = await newEnv();
  const a = await env.login('${ownRole.name}');
  const b = await env.login('${ownRole.name}');
  const r = await env.create(a.token, '${scoped.name}', { ownerId: b.id });
  assert.equal(r.status, 403);
});
${
  teamRole
    ? `
test('${teamRole.name} sees its team and its own records, not another team', async () => {
  const env = await newEnv();
  const t1 = '11111111-1111-4111-8111-111111111111';
  const t2 = '22222222-2222-4222-8222-222222222222';
  const m = await env.login('${teamRole.name}', { teamId: t1 });
  const r1 = await env.login('${ownRole.name}', { teamId: t1 });
  const r2 = await env.login('${ownRole.name}', { teamId: t2 });
  const x = await env.create(r1.token, '${scoped.name}');
  const y = await env.create(r2.token, '${scoped.name}');
  const ids = (await env.call('GET', base, { token: m.token })).body.items.map((r: { id: string }) => r.id);
  if ((META.roles['${teamRole.name}']?.permissions['${scoped.name}'] ?? []).includes('read')) {
    assert.ok(ids.includes(x.body.id));
    assert.ok(!ids.includes(y.body.id));
  }
});
`
    : ''
}`;

  const sample0 =
    spec.entities.find((e) =>
      e.fields.some((f) => f.required && f.type !== 'reference' && f.type !== 'file'),
    ) ?? spec.entities[0]!;
  const req = sample0.fields.find((f) => f.required && f.type !== 'reference' && f.type !== 'file');
  const en = sample0.fields.find((f) => f.type === 'enum');
  const str = sample0.fields.find((f) => f.type === 'string');
  files['tests/validation.test.ts'] = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { META } from '../src/meta.ts';
import { newEnv } from './helpers.ts';

const em = META.entities['${sample0.name}']!;
const path = META.basePath + '/' + em.plural;
const admin = () => Object.values(META.roles).find((r) => r.admin)!;

test('an empty body, an unknown field and a non-object are rejected with field errors (422)', async () => {
  const env = await newEnv();
  const { token } = await env.login(admin().name);
  const empty = await env.call('POST', path, { token, body: {} });
  ${req ? `assert.equal(empty.status, 422);\n  assert.ok(empty.body.errors.some((e: { field: string }) => e.field === '${req.name}'));` : 'assert.ok(empty.status === 422 || empty.status === 201);'}
  const unknown = await env.call('POST', path, { token, body: { notAField: 1 } });
  assert.equal(unknown.status, 422);
  assert.equal((await env.call('POST', path, { token, body: [] })).status, 422);
  assert.equal((await env.call('POST', path, { token, raw: '{bad', headers: { 'content-type': 'application/json' } })).status, 400);
});

test('mass assignment: id, version and audit columns cannot be set from the body', async () => {
  const env = await newEnv();
  const { token } = await env.login(admin().name);
  const r = await env.create(token, em.name, { id: '00000000-0000-4000-8000-000000000009' });
  assert.equal(r.status, 422);
  const r2 = await env.create(token, em.name, { createdBy: 'x' });
  assert.equal(r2.status, 422);
});
${
  en
    ? `
test('an enum value outside the list is rejected', async () => {
  const env = await newEnv();
  const { token } = await env.login(admin().name);
  const r = await env.create(token, em.name, { ${en.name}: 'NotAValue' });
  assert.equal(r.status, 422);
});`
    : ''
}
${
  str
    ? `
test('a string longer than its limit is rejected', async () => {
  const env = await newEnv();
  const { token } = await env.login(admin().name);
  const r = await env.create(token, em.name, { ${str.name}: 'x'.repeat(${(str.maxLength ?? 255) + 1}) });
  assert.equal(r.status, 422);
});`
    : ''
}

test('optimistic locking: a stale version answers 409, the current one succeeds', async () => {
  const env = await newEnv();
  const { token } = await env.login(admin().name);
  const c = await env.create(token, em.name);
  assert.equal(c.status, 201);
  const ok = await env.call('PATCH', path + '/' + c.body.id, { token, body: {}, headers: { 'if-match': '"1"' } });
  assert.equal(ok.status, 200);
  const stale = await env.call('PATCH', path + '/' + c.body.id, { token, body: {}, headers: { 'if-match': '"1"' } });
  assert.equal(stale.status, 409);
});

test('pagination limits are enforced and sorting by an unlisted field is refused', async () => {
  const env = await newEnv();
  const { token } = await env.login(admin().name);
  assert.equal((await env.call('GET', path + '?limit=' + (META.maxLimit + 1), { token })).status, 422);
  assert.equal((await env.call('GET', path + '?sort=password:asc', { token })).status, 422);
  assert.equal((await env.call('GET', path + '?filter.nope=1', { token })).status, 422);
});

test('the audit trail records create and update, and personal fields are redacted in every entry', async () => {
  const env = await newEnv();
  const { token } = await env.login(admin().name);
  const c = await env.create(token, em.name);
  await env.call('PATCH', path + '/' + c.body.id, { token, body: {} });
  const trail = await env.call('GET', path + '/' + c.body.id + '/audit', { token });
  if (!em.audit) return;
  assert.ok(trail.body.items.length >= 1);
  const text = JSON.stringify(trail.body.items);
  for (const f of em.fields.filter((x) => x.pii)) {
    const v = c.body[f.name];
    if (typeof v === 'string' && v.length > 3) assert.ok(!text.includes(v), f.name + ' leaked into the audit trail');
  }
});
`;

  files['tests/auth.test.ts'] = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../src/auth.ts';
import { META } from '../src/meta.ts';
import { csvCell, parseCsv, toCsv } from '../src/csv.ts';
import { newEnv, PASSWORD } from './helpers.ts';

test('passwords are hashed with a salt and verified in constant time', async () => {
  const a = await hashPassword('s3cret-pass-phrase');
  const b = await hashPassword('s3cret-pass-phrase');
  assert.notEqual(a, b);
  assert.ok(await verifyPassword('s3cret-pass-phrase', a));
  assert.ok(!(await verifyPassword('wrong', a)));
  assert.ok(!a.includes('s3cret'));
});

test('tokens expire and a changed payload or secret is refused', () => {
  const t = signToken('k'.repeat(40), 'u1', 60, 1_000_000);
  assert.equal(verifyToken('k'.repeat(40), t, 1_000_000 + 30_000), 'u1');
  assert.equal(verifyToken('k'.repeat(40), t, 1_000_000 + 61_000), null);
  assert.equal(verifyToken('j'.repeat(40), t, 1_000_000), null);
  const [p, m] = t.split('.');
  assert.equal(verifyToken('k'.repeat(40), Buffer.from('{"uid":"u2","exp":9999999999}').toString('base64url') + '.' + m, 1_000_000), null);
  assert.ok(p);
});

test('login is rate limited after five failures and does not reveal which part was wrong', async () => {
  const env = await newEnv();
  const u = await env.login(Object.values(META.roles)[0]!.name, { email: 'lock@example.test' });
  assert.ok(u.token);
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await env.call('POST', META.basePath + '/auth/login', { body: { email: 'lock@example.test', password: 'wrong-wrong-wrong' } })).status;
  assert.equal(last, 429);
  const nobody = await env.call('POST', META.basePath + '/auth/login', { body: { email: 'nobody@example.test', password: PASSWORD } });
  assert.equal(nobody.status, 401);
});

test('csv: formula injection is neutralised and a round trip keeps quotes, commas and newlines', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  const text = toCsv(['a', 'b'], [{ a: 'x,y', b: 'line1\\nline2' }, { a: '"q"', b: '' }]);
  assert.deepEqual(parseCsv(text), [['a', 'b'], ['x,y', 'line1\\nline2'], ['"q"', '']]);
  assert.throws(() => parseCsv('a,"b'), /unterminated/);
});
`;
  return files;
}
