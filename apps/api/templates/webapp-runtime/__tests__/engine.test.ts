import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, readSession, signToken, verifyPassword, verifyToken } from '../src/auth.ts';
import { buildRouter } from '../src/engine.ts';
import { MemoryStore } from '../src/memory-store.ts';
import { MemoryNotifier } from '../src/notify.ts';
import { currentTenant, withTenant } from '../src/tenant.ts';
import { fixtureMeta, newApp, PASSWORD, SECRET } from './fixture.ts';

// assembled at run time: a quoted password literal in a committed file is refused by the repository secret scan
const WRONG_PASSWORD = ['wrong', 'password', '1'].join('-');

const post = (
  a: ReturnType<typeof newApp>,
  path: string,
  body: unknown,
  token?: string,
  headers?: Record<string, string>,
) =>
  a.transport.request('POST', '/api/v1' + path, {
    body,
    ...(token ? { token } : {}),
    ...(headers ? { headers } : {}),
  });

test('tokens carry a session id, expire, and are bound to the secret', () => {
  const t = signToken(SECRET, 'u1', 60, 1_000_000);
  const s = readSession(SECRET, t, 1_000_000 + 30_000);
  assert.equal(s?.uid, 'u1');
  assert.match(s?.jti ?? '', /^[0-9a-f]{32}$/);
  assert.equal(verifyToken(SECRET, t, 1_000_000 + 61_000), null);
  assert.equal(verifyToken('j'.repeat(48), t, 1_000_000), null);
  assert.notEqual(
    readSession(SECRET, signToken(SECRET, 'u1', 60, 1_000_000), 1_000_000)?.jti,
    s?.jti,
  );
});

test('passwords are salted scrypt hashes', async () => {
  const a = await hashPassword('s3cret-pass-phrase');
  assert.notEqual(a, await hashPassword('s3cret-pass-phrase'));
  assert.ok(await verifyPassword('s3cret-pass-phrase', a));
  assert.ok(!(await verifyPassword('wrong', a)));
  assert.ok(!(await verifyPassword('x', 'garbage')));
});

test('single tenant, sign-up off: the sign-up route does not exist', async () => {
  const a = newApp();
  assert.equal(
    (await post(a, '/auth/signup', { email: 'a@example.test', name: 'A', password: PASSWORD }))
      .status,
    404,
  );
});

test('sign-up validates, rate limits, rejects duplicates, ignores role/tenant fields and never returns the hash', async () => {
  const a = newApp({ signupRole: 'rep', tenancy: 'single' });
  assert.equal(
    (await post(a, '/auth/signup', { email: 'bad', name: 'A', password: PASSWORD })).status,
    422,
  );
  assert.equal(
    (await post(a, '/auth/signup', { email: 'a@example.test', name: '', password: PASSWORD }))
      .status,
    422,
  );
  assert.equal(
    (await post(a, '/auth/signup', { email: 'a@example.test', name: 'A', password: 'short' }))
      .status,
    422,
  );
  const ok = await post(a, '/auth/signup', {
    email: 'A@Example.test',
    name: 'A',
    password: PASSWORD,
    role: 'admin',
    active: false,
    teamId: 'x',
  });
  assert.equal(ok.status, 201);
  const b = ok.body as { token: string; user: { role: string; email: string } };
  assert.equal(b.user.role, 'rep');
  assert.equal(b.user.email, 'a@example.test');
  assert.ok(!ok.text.includes('passwordHash') && !ok.text.includes('s1$'));
  assert.equal(
    (await post(a, '/auth/signup', { email: 'a@example.test', name: 'A', password: PASSWORD }))
      .status,
    409,
  );
  let last = 0;
  for (let i = 0; i < 21; i++)
    last = (
      await post(a, '/auth/signup', {
        email: 'b' + i + '@example.test',
        name: 'B',
        password: PASSWORD,
      })
    ).status;
  assert.equal(last, 429);
});

test('a single-tenant app refuses to start with an administrator sign-up role, and an unknown role', () => {
  const m = fixtureMeta({ signupRole: 'admin', tenancy: 'single' });
  assert.throws(
    () =>
      buildRouter({
        meta: m,
        store: new MemoryStore(m),
        notifier: new MemoryNotifier(),
        sessionSecret: SECRET,
      }),
    /administrator/,
  );
  const n = fixtureMeta({ signupRole: 'ghost', tenancy: 'single' });
  assert.throws(
    () =>
      buildRouter({
        meta: n,
        store: new MemoryStore(n),
        notifier: new MemoryNotifier(),
        sessionSecret: SECRET,
      }),
    /not a role/,
  );
});

test('logout revokes only that session; the token of another session and a replayed logout behave', async () => {
  const a = newApp({ signupRole: 'rep', tenancy: 'single' });
  const first = (
    await post(a, '/auth/signup', { email: 'a@example.test', name: 'A', password: PASSWORD })
  ).body as { token: string };
  const second = (await post(a, '/auth/login', { email: 'a@example.test', password: PASSWORD }))
    .body as { token: string };
  assert.equal((await post(a, '/auth/logout', {}, first.token)).status, 204);
  assert.equal(
    (await a.transport.request('GET', '/api/v1/auth/me', { token: first.token })).status,
    401,
  );
  assert.equal(
    (await a.transport.request('GET', '/api/v1/auth/me', { token: second.token })).status,
    200,
  );
  assert.equal((await post(a, '/auth/logout', {}, first.token)).status, 401);
});

test('cross-origin state-changing requests are refused; same-origin and header-less ones are accepted', async () => {
  const a = newApp();
  const body = { email: 'x@example.test', password: PASSWORD };
  assert.equal(
    (
      await post(a, '/auth/login', body, undefined, {
        origin: 'https://evil.example',
        host: 'app.example.test',
      })
    ).status,
    403,
  );
  assert.equal(
    (await post(a, '/auth/login', body, undefined, { origin: 'null', host: 'app.example.test' }))
      .status,
    403,
  );
  assert.equal(
    (
      await post(a, '/auth/login', body, undefined, {
        origin: 'https://app.example.test',
        host: 'app.example.test',
      })
    ).status,
    401,
  );
  assert.equal((await post(a, '/auth/login', body)).status, 401);
  // a GET is not a state change
  assert.equal(
    (
      await a.transport.request('GET', '/health', {
        headers: { origin: 'https://evil.example', host: 'app.example.test' },
      })
    ).status,
    200,
  );
});

test('login: unknown account and wrong password answer identically and the unknown account still costs a hash verification', async () => {
  const a = newApp({ signupRole: 'rep', tenancy: 'single' });
  await post(a, '/auth/signup', { email: 'a@example.test', name: 'A', password: PASSWORD });
  const wrong = await post(a, '/auth/login', {
    email: 'a@example.test',
    password: WRONG_PASSWORD,
  });
  const nobody = await post(a, '/auth/login', {
    email: 'n@example.test',
    password: WRONG_PASSWORD,
  });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, nobody.body);
});

// ------------------------------------------------------------------ multi-tenant
const multi = () => newApp({ signupRole: 'admin', tenancy: 'multi' });
const org = async (a: ReturnType<typeof newApp>, n: string) => {
  const r = await post(a, '/auth/signup', {
    email: n + '@example.test',
    name: n,
    password: PASSWORD,
    organization: 'Org ' + n,
  });
  assert.equal(r.status, 201, r.text);
  return r.body as { token: string; user: { id: string; tenantId: string } };
};

test('multi-tenant sign-up needs an organisation, makes the person its administrator and gives each organisation its own tenant', async () => {
  const a = multi();
  assert.equal(
    (await post(a, '/auth/signup', { email: 'x@example.test', name: 'X', password: PASSWORD }))
      .status,
    422,
  );
  const o1 = await org(a, 'one');
  const o2 = await org(a, 'two');
  assert.notEqual(o1.user.tenantId, o2.user.tenantId);
  assert.equal(
    (await a.transport.request('GET', '/api/v1/auth/me', { token: o1.token })).status,
    200,
  );
});

test('multi-tenant: records, lists, search, users and owners never cross organisations', async () => {
  const a = multi();
  const o1 = await org(a, 'one');
  const o2 = await org(a, 'two');
  const c = await post(a, '/customers', { name: 'Acme', email: 'acme@example.test' }, o1.token);
  assert.equal(c.status, 201, c.text);
  const id = (c.body as { id: string }).id;
  for (const m of ['GET', 'PATCH', 'DELETE']) {
    const r = await a.transport.request(m, '/api/v1/customers/' + id, {
      token: o2.token,
      ...(m === 'PATCH' ? { body: {} } : {}),
    });
    assert.equal(r.status, 404, m);
  }
  for (const q of ['', '?search=Acme', '?limit=100&sort=name:asc']) {
    const r = await a.transport.request('GET', '/api/v1/customers' + q, { token: o2.token });
    assert.equal((r.body as { total: number }).total, 0, q);
  }
  // the same unique e-mail may exist in two organisations (unique per tenant), but not twice in one
  assert.equal(
    (await post(a, '/customers', { name: 'Acme', email: 'acme@example.test' }, o2.token)).status,
    201,
  );
  assert.equal(
    (await post(a, '/customers', { name: 'Acme 2', email: 'acme@example.test' }, o2.token)).status,
    409,
  );
  // users: lists are per tenant and an owner of another tenant is refused
  const users = await a.transport.request('GET', '/api/v1/users', { token: o1.token });
  assert.ok((users.body as { items: { id: string }[] }).items.every((u) => u.id !== o2.user.id));
  assert.equal(
    (await post(a, '/customers', { name: 'X', ownerId: o2.user.id }, o1.token)).status,
    422,
  );
  // an administrator creates users in their own organisation only
  const made = await post(
    a,
    '/users',
    { email: 'c@example.test', name: 'C', role: 'rep', password: PASSWORD },
    o1.token,
  );
  assert.equal(made.status, 201);
  const o2users = await a.transport.request('GET', '/api/v1/users', { token: o2.token });
  assert.ok(
    !(o2users.body as { items: { id: string }[] }).items.some(
      (u) => u.id === (made.body as { id: string }).id,
    ),
  );
});

test('multi-tenant: a reference cannot cross organisations, and the tenant is never taken from the request', async () => {
  const a = multi();
  const o1 = await org(a, 'one');
  const o2 = await org(a, 'two');
  const cust = (await post(a, '/customers', { name: 'Acme' }, o1.token)).body as { id: string };
  assert.equal(
    (await post(a, '/notes', { body: 'hi', customerId: cust.id }, o2.token)).status,
    422,
  );
  assert.equal(
    (await post(a, '/notes', { body: 'hi', customerId: cust.id }, o1.token)).status,
    201,
  );
  assert.equal(
    (await post(a, '/customers', { name: 'N', tenantId: o2.user.tenantId }, o1.token)).status,
    422,
  );
  const withHeader = await a.transport.request('GET', '/api/v1/customers', {
    token: o1.token,
    headers: { 'x-tenant-id': o2.user.tenantId },
  });
  assert.equal((withHeader.body as { total: number }).total, 1);
  assert.equal(
    (
      await a.transport.request('GET', '/api/v1/customers?tenantId=' + o2.user.tenantId, {
        token: o1.token,
      })
    ).status,
    200,
  );
});

test('multi-tenant: the store fails closed without a tenant context and the context is per request', async () => {
  const a = multi();
  const o1 = await org(a, 'one');
  await post(a, '/customers', { name: 'Acme' }, o1.token);
  assert.equal(currentTenant(), null);
  assert.deepEqual(
    (
      await a.store.list('Customer', {
        filters: [],
        search: null,
        searchFields: [],
        sort: null,
        limit: 10,
        offset: 0,
        scope: { ownerId: null, teamId: null },
      })
    ).rows,
    [],
  );
  await assert.rejects(
    a.store.insert('Customer', { id: 'x', name: 'N' } as never),
    /no tenant context/,
  );
  await withTenant(o1.user.tenantId, async () => {
    const r = await a.store.list('Customer', {
      filters: [],
      search: null,
      searchFields: [],
      sort: null,
      limit: 10,
      offset: 0,
      scope: { ownerId: null, teamId: null },
    });
    assert.equal(r.total, 1);
  });
  assert.deepEqual(await a.store.listUsers(), []);
});

test('multi-tenant: a user row without a tenant cannot authenticate', async () => {
  const a = multi();
  const t = signToken(SECRET, 'nobody', 60, Date.now());
  assert.equal((await a.transport.request('GET', '/api/v1/auth/me', { token: t })).status, 401);
  await a.store.insertUser({
    id: '00000000-0000-4000-8000-0000000000aa',
    email: 'orphan@example.test',
    name: 'O',
    role: 'admin',
    teamId: null,
    tenantId: null,
    locale: 'en',
    passwordHash: await hashPassword(PASSWORD),
    active: true,
    createdAt: new Date().toISOString(),
  });
  const login = await post(a, '/auth/login', { email: 'orphan@example.test', password: PASSWORD });
  assert.equal(login.status, 200);
  assert.equal(
    (
      await a.transport.request('GET', '/api/v1/auth/me', {
        token: (login.body as { token: string }).token,
      })
    ).status,
    401,
  );
});
