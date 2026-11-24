// PLATFORM-OWNED (Nuzm P3-S05): the run-and-probe suite. It is copied unchanged into every generated full-stack app and its bytes are pinned by the static gate `platform-integrity`,
// so a generated app cannot weaken a check or forge a result. Dependency-free (types only); it talks to the app through a transport, so the same suite runs against an in-process
// router (the template's own unit tests), against the simulated runtime, and against the real app over HTTP inside the qualified runtime.

export interface ProbeResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  text: string;
}
export interface ProbeRequestOptions {
  token?: string;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}
export interface ProbeTransport {
  request(method: string, path: string, opts?: ProbeRequestOptions): Promise<ProbeResponse>;
}
export interface ProbeField {
  name: string;
  type: string;
  required: boolean;
  references: string | null;
}
export interface ProbeEntity {
  name: string;
  plural: string;
  ownership: string;
  fields: ProbeField[];
}
export interface ProbeRole {
  name: string;
  scope: string;
  admin: boolean;
  permissions: Record<string, string[]>;
}
export interface ProbeMeta {
  slug: string;
  basePath: string;
  maxLimit: number;
  entities: Record<string, ProbeEntity>;
  roles: Record<string, ProbeRole>;
  auth?: { signupRole: string | null; tenancy: 'single' | 'multi' };
}
export interface ProbeContext {
  meta: ProbeMeta;
  openapi: {
    paths: Record<string, Record<string, { operationId?: string; security?: unknown[] }>>;
  };
  /** synthetic sample values per entity; `{n}` is replaced per call and `{ref}` marks a reference */
  samples: Record<string, Record<string, unknown>>;
  password: string;
  /** Creates an administrator account directly in the database of THIS run (the app has no public way to create the first administrator) and returns its credentials. */
  provisionAdmin: (label: string) => Promise<{ email: string; password: string }>;
  now?: () => number;
}

export type CheckStatus = 'pass' | 'fail' | 'skipped';
export interface ProbeCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  ms: number;
}
export interface ProbeReport {
  schema: 'nuzm.app-probe/1';
  app: string;
  tenancy: 'single' | 'multi';
  signup: boolean;
  checks: ProbeCheck[];
  passed: number;
  failed: number;
  skipped: number;
  /** required checks that did not pass (failed OR skipped): the report is ok only when this is empty and nothing failed */
  requiredNotPassed: string[];
  ok: boolean;
  startedAt: string;
  durationMs: number;
}

/** The checks without which a full-stack app is not accepted (acceptance F1 of P3-S05). A skipped required check is NOT a pass. */
export const REQUIRED_CHECKS = [
  'health',
  'security-headers',
  'unauthenticated-rejected',
  'login',
  'login-wrong-password',
  'me',
  'crud',
  'validation',
  'pagination',
  'cross-user-isolation',
  'logout-revokes',
  'login-rate-limit',
  'cross-origin-refused',
] as const;

class Skip extends Error {}
const skip = (why: string): never => {
  throw new Skip(why);
};
function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const asObj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
const concrete = (p: string): string =>
  p.replace(/\{id\}/g, '00000000-0000-4000-8000-000000000001');

export async function runProbe(t: ProbeTransport, ctx: ProbeContext): Promise<ProbeReport> {
  const clock = ctx.now ?? Date.now;
  const started = clock();
  const { meta } = ctx;
  const base = meta.basePath;
  const tenancy = meta.auth?.tenancy ?? 'single';
  const signupRole = meta.auth?.signupRole ?? null;
  const checks: ProbeCheck[] = [];
  let n = 0;
  const uniq = (): string => String(Date.now() % 100000) + '-' + ++n;

  const run = async (
    id: string,
    title: string,
    fn: () => Promise<string | void>,
  ): Promise<void> => {
    const t0 = clock();
    try {
      const detail = (await fn()) ?? 'ok';
      checks.push({
        id,
        title,
        status: 'pass',
        detail: String(detail).slice(0, 300),
        ms: clock() - t0,
      });
    } catch (e) {
      const skipped = e instanceof Skip;
      checks.push({
        id,
        title,
        status: skipped ? 'skipped' : 'fail',
        detail: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        ms: clock() - t0,
      });
    }
  };
  const call = (method: string, path: string, o?: ProbeRequestOptions): Promise<ProbeResponse> =>
    t.request(method, path, o);
  const login = async (email: string, password: string): Promise<string> => {
    const r = await call('POST', base + '/auth/login', { body: { email, password } });
    must(r.status === 200, 'login answered ' + r.status);
    const token = asObj(r.body)['token'];
    must(typeof token === 'string' && token.length > 20, 'login returned no token');
    return token as string;
  };
  const adminRole = Object.values(meta.roles).find((r) => r.admin);
  const can = (role: ProbeRole, entity: string, action: string): boolean =>
    (role.permissions[entity] ?? []).includes(action);

  // ---- principals (A and B) ----
  interface Principal {
    token: string;
    email: string;
    role: string;
    id: string;
  }
  const principals: Record<string, Principal> = {};
  const me = async (token: string): Promise<{ id: string; role: string; email: string }> => {
    const r = await call('GET', base + '/auth/me', { token });
    must(r.status === 200, '/auth/me answered ' + r.status);
    const u = asObj(asObj(r.body)['user']);
    return { id: String(u['id']), role: String(u['role']), email: String(u['email']) };
  };
  const adminA = async (): Promise<Principal> => {
    if (principals['A']) return principals['A'];
    must(adminRole, 'the app has no administrator role');
    const c = await ctx.provisionAdmin('a');
    const token = await login(c.email, c.password);
    const u = await me(token);
    return (principals['A'] = { token, email: c.email, role: u.role, id: u.id });
  };

  // ---- 1. health and headers ----
  await run('health', 'GET /health is public and answers {status:"ok"}', async () => {
    const r = await call('GET', '/health');
    must(r.status === 200, 'status ' + r.status);
    must(asObj(r.body)['status'] === 'ok', 'body is not {status:"ok"}');
  });
  await run(
    'security-headers',
    'responses carry nosniff, frame denial and a content security policy',
    async () => {
      const r = await call('GET', '/health');
      const h = r.headers;
      must(h['x-content-type-options'] === 'nosniff', 'x-content-type-options missing');
      must(h['x-frame-options'] === 'DENY', 'x-frame-options missing');
      must(
        /default-src 'self'/.test(h['content-security-policy'] ?? ''),
        'content-security-policy missing',
      );
      must(h['cache-control'] === 'no-store', 'cache-control missing');
    },
  );

  // ---- 2. every secured operation refuses anonymous and forged callers ----
  await run(
    'unauthenticated-rejected',
    'every secured operation answers 401 without a token and with a forged one',
    async () => {
      let count = 0;
      for (const [path, ops] of Object.entries(ctx.openapi.paths))
        for (const [method, op] of Object.entries(ops)) {
          if (!['get', 'post', 'patch', 'delete'].includes(method)) continue;
          if (Array.isArray(op.security) && op.security.length === 0) continue;
          for (const token of [undefined, 'forged.token', 'x'.repeat(40)]) {
            const r = await call(method.toUpperCase(), concrete(path), {
              ...(token ? { token } : {}),
              ...(method === 'get' || method === 'delete' ? {} : { body: {} }),
            });
            must(
              r.status === 401,
              (op.operationId ?? method + ' ' + path) +
                ' answered ' +
                r.status +
                ' for ' +
                (token ? 'a forged token' : 'no token'),
            );
          }
          count++;
        }
      must(count > 0, 'the OpenAPI document has no secured operation');
      return count + ' secured operations refused anonymous and forged callers';
    },
  );

  // ---- 3. authentication ----
  let signedUp = false;
  await run('signup', 'sign-up creates an account and signs in', async () => {
    if (!signupRole) skip('public sign-up is off in this app');
    const email = 'probe.signup.' + uniq() + '@example.test';
    const body: Record<string, unknown> = { email, name: 'Probe User', password: ctx.password };
    if (tenancy === 'multi') body['organization'] = 'Probe organisation ' + uniq();
    const r = await call('POST', base + '/auth/signup', { body });
    must(r.status === 201, 'sign-up answered ' + r.status);
    const token = asObj(r.body)['token'];
    must(typeof token === 'string', 'no token after sign-up');
    const u = await me(token as string);
    must(u.role === signupRole, 'the new account has role ' + u.role);
    const again = await call('POST', base + '/auth/signup', { body });
    must(again.status === 409, 'a duplicate sign-up answered ' + again.status);
    signedUp = true;
    principals['S'] = { token: token as string, email, role: u.role, id: u.id };
  });
  await run('login', 'an administrator can sign in with email and password', async () => {
    const a = await adminA();
    must(a.token.length > 20, 'no token');
  });
  await run(
    'login-wrong-password',
    'a wrong password and an unknown account both answer 401',
    async () => {
      const a = await adminA();
      const wrong = await call('POST', base + '/auth/login', {
        body: { email: a.email, password: ctx.password + 'x' },
      });
      const nobody = await call('POST', base + '/auth/login', {
        body: { email: 'nobody.' + uniq() + '@example.test', password: ctx.password },
      });
      must(
        wrong.status === 401 && nobody.status === 401,
        'answered ' + wrong.status + ' and ' + nobody.status,
      );
      must(
        JSON.stringify(wrong.body) === JSON.stringify(nobody.body),
        'the two answers differ: an attacker could tell which accounts exist',
      );
    },
  );
  await run('me', 'GET /auth/me returns the user and the role permissions', async () => {
    const a = await adminA();
    const r = await call('GET', base + '/auth/me', { token: a.token });
    must(r.status === 200, 'status ' + r.status);
    const b = asObj(r.body);
    must(asObj(b['user'])['email'] === a.email, 'wrong user');
    must(typeof b['permissions'] === 'object', 'no permissions');
    must(!JSON.stringify(r.body).includes('password'), 'the response mentions a password');
  });

  // ---- 4. CRUD on a real entity ----
  const sample = (
    entity: string,
    refs: Record<string, string>,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx.samples[entity] ?? {})) {
      if (v === '{ref}') {
        if (refs[k]) out[k] = refs[k];
        continue;
      }
      out[k] = typeof v === 'string' ? v.replaceAll('{n}', uniq()) : v;
    }
    return { ...out, ...over };
  };
  const make = async (
    token: string,
    entity: string,
    over: Record<string, unknown> = {},
    depth = 0,
  ): Promise<ProbeResponse> => {
    must(depth < 6, 'reference chain too deep');
    const em = meta.entities[entity] as ProbeEntity;
    const refs: Record<string, string> = {};
    for (const f of em.fields) {
      if (f.type !== 'reference' || !f.required || over[f.name] !== undefined) continue;
      const made = await make(token, f.references as string, {}, depth + 1);
      must(
        made.status === 201,
        'could not create the referenced ' + f.references + ' (' + made.status + ')',
      );
      refs[f.name] = String(asObj(made.body)['id']);
    }
    return call('POST', base + '/' + em.plural, { token, body: sample(entity, refs, over) });
  };
  const crudEntity = (): ProbeEntity | null => {
    if (!adminRole) return null;
    for (const em of Object.values(meta.entities))
      if (['create', 'read', 'update', 'delete'].every((a) => can(adminRole, em.name, a)))
        return em;
    return null;
  };
  await run('crud', 'create, read, list, update and delete a record through the API', async () => {
    const em = crudEntity();
    if (!em) return skip('no entity with full CRUD for the administrator');
    const a = await adminA();
    const path = base + '/' + em.plural;
    const c = await make(a.token, em.name);
    must(c.status === 201, 'create answered ' + c.status + ' ' + c.text.slice(0, 120));
    const id = String(asObj(c.body)['id']);
    must(id.length > 10, 'created record has no id');
    const g = await call('GET', path + '/' + id, { token: a.token });
    must(g.status === 200 && asObj(g.body)['id'] === id, 'read answered ' + g.status);
    const l = await call('GET', path + '?limit=100', { token: a.token });
    must(l.status === 200, 'list answered ' + l.status);
    must(
      (asObj(l.body)['items'] as { id: string }[]).some((x) => x.id === id),
      'the created record is not in the list',
    );
    const version = Number(asObj(g.body)['version']);
    const u = await call('PATCH', path + '/' + id, {
      token: a.token,
      body: {},
      headers: { 'if-match': '"' + version + '"' },
    });
    must(u.status === 200, 'update answered ' + u.status);
    must(Number(asObj(u.body)['version']) === version + 1, 'the version did not advance');
    const stale = await call('PATCH', path + '/' + id, {
      token: a.token,
      body: {},
      headers: { 'if-match': '"' + version + '"' },
    });
    must(stale.status === 409, 'a stale version answered ' + stale.status);
    const d = await call('DELETE', path + '/' + id, { token: a.token });
    must(d.status === 204, 'delete answered ' + d.status);
    const gone = await call('GET', path + '/' + id, { token: a.token });
    must(gone.status === 404, 'a deleted record answered ' + gone.status);
    return 'entity ' + em.name;
  });
  await run(
    'validation',
    'empty, unknown and malformed bodies are rejected with field errors',
    async () => {
      const em = crudEntity();
      if (!em) return skip('no entity with full CRUD for the administrator');
      const a = await adminA();
      const path = base + '/' + em.plural;
      const hasRequired = em.fields.some((f) => f.required && f.type !== 'reference');
      const empty = await call('POST', path, { token: a.token, body: {} });
      must(
        hasRequired ? empty.status === 422 : empty.status === 422 || empty.status === 201,
        'empty body answered ' + empty.status,
      );
      must(
        (await call('POST', path, { token: a.token, body: { notAField: 1 } })).status === 422,
        'an unknown field was accepted',
      );
      must(
        (await call('POST', path, { token: a.token, body: [] })).status === 422,
        'an array body was accepted',
      );
      must(
        (
          await call('POST', path, {
            token: a.token,
            raw: '{bad',
            headers: { 'content-type': 'application/json' },
          })
        ).status === 400,
        'malformed JSON was accepted',
      );
      const mass = await make(a.token, em.name, { id: '00000000-0000-4000-8000-000000000009' });
      must(mass.status === 422, 'mass assignment of id answered ' + mass.status);
    },
  );
  await run(
    'pagination',
    'the list is paginated, limits are enforced, unknown sort and filter are refused',
    async () => {
      const em =
        crudEntity() ??
        Object.values(meta.entities).find((e) => adminRole && can(adminRole, e.name, 'read'));
      if (!em) return skip('no readable entity');
      const a = await adminA();
      const path = base + '/' + em.plural;
      const ok = await call('GET', path + '?limit=1', { token: a.token });
      must(ok.status === 200, 'list answered ' + ok.status);
      const keys = Object.keys(asObj(ok.body)).sort().join(',');
      must(keys === 'items,limit,offset,total', 'list shape is ' + keys);
      must(
        (await call('GET', path + '?limit=' + (meta.maxLimit + 1), { token: a.token })).status ===
          422,
        'an oversize limit was accepted',
      );
      must(
        (await call('GET', path + '?sort=password:asc', { token: a.token })).status === 422,
        'an unlisted sort field was accepted',
      );
      must(
        (await call('GET', path + '?filter.nope=1', { token: a.token })).status === 422,
        'an unknown filter was accepted',
      );
    },
  );

  // ---- 5. cross-user (and cross-tenant) isolation ----
  await run(
    'cross-user-isolation',
    "one user cannot see, change or delete another user's record",
    async () => {
      const a = await adminA();
      if (tenancy === 'multi') {
        // two organisations: B is the administrator of a second tenant
        const em = crudEntity();
        if (!em) return skip('no entity with full CRUD for the administrator');
        const second = await ctx.provisionAdmin('b');
        const tokenB = await login(second.email, second.password);
        // the provisioned administrators live in different tenants by construction (see the run script)
        const made = await make(a.token, em.name);
        must(made.status === 201, 'create answered ' + made.status);
        const id = String(asObj(made.body)['id']);
        const path = base + '/' + em.plural;
        must(
          (await call('GET', path + '/' + id, { token: tokenB })).status === 404,
          'another organisation could read the record',
        );
        must(
          (await call('PATCH', path + '/' + id, { token: tokenB, body: {} })).status === 404,
          'another organisation could update the record',
        );
        must(
          (await call('DELETE', path + '/' + id, { token: tokenB })).status === 404,
          'another organisation could delete the record',
        );
        const list = await call('GET', path + '?limit=100', { token: tokenB });
        must(
          !(asObj(list.body)['items'] as { id: string }[]).some((x) => x.id === id),
          "the record appears in another organisation's list",
        );
        must(
          (await call('GET', path + '/' + id, { token: a.token })).status === 200,
          'the owner lost access',
        );
        return 'two organisations';
      }
      // single tenant: an administrator creates two users with a role of scope "own" and checks that they do not see each other's rows
      const own = Object.values(meta.roles).find((r) => !r.admin && r.scope === 'own');
      const em = own
        ? Object.values(meta.entities).find(
            (e) => e.ownership !== 'org' && can(own, e.name, 'create') && can(own, e.name, 'read'),
          )
        : undefined;
      if (!own || !em)
        return skip('no role of scope "own" with create and read on an owned entity');
      const mk = async (): Promise<Principal> => {
        const email = 'probe.user.' + uniq() + '@example.test';
        const r = await call('POST', base + '/users', {
          token: a.token,
          body: { email, name: 'Probe ' + own.name, role: own.name, password: ctx.password },
        });
        must(r.status === 201, 'creating a user answered ' + r.status);
        const token = await login(email, ctx.password);
        const u = await me(token);
        return { token, email, role: own.name, id: u.id };
      };
      const u1 = await mk();
      const u2 = await mk();
      const mine = await make(u1.token, em.name);
      must(mine.status === 201, 'user 1 could not create (' + mine.status + ')');
      const id = String(asObj(mine.body)['id']);
      const path = base + '/' + em.plural;
      must(
        (await call('GET', path + '/' + id, { token: u2.token })).status === 404,
        "user 2 could read user 1's record",
      );
      if (can(own, em.name, 'update'))
        must(
          (await call('PATCH', path + '/' + id, { token: u2.token, body: {} })).status === 404,
          "user 2 could update user 1's record",
        );
      if (can(own, em.name, 'delete'))
        must(
          (await call('DELETE', path + '/' + id, { token: u2.token })).status === 404,
          "user 2 could delete user 1's record",
        );
      const list = await call('GET', path + '?limit=100', { token: u2.token });
      must(
        !(asObj(list.body)['items'] as { id: string }[]).some((x) => x.id === id),
        "user 1's record appears in user 2's list",
      );
      must(
        (await call('GET', path + '/' + id, { token: u1.token })).status === 200,
        'the owner lost access',
      );
      const escalate = await make(u1.token, em.name, { ownerId: u2.id });
      must(
        escalate.status === 403,
        'assigning a record to another user answered ' + escalate.status,
      );
      return 'role ' + own.name + ' on ' + em.name;
    },
  );

  // ---- 6. session lifecycle and abuse controls ----
  await run('logout-revokes', 'logout revokes the session on the server', async () => {
    const a = await adminA();
    const token = await login(a.email, ctx.password);
    must(
      (await call('GET', base + '/auth/me', { token })).status === 200,
      'the new session does not work',
    );
    must(
      (await call('POST', base + '/auth/logout', { token })).status === 204,
      'logout did not answer 204',
    );
    must(
      (await call('GET', base + '/auth/me', { token })).status === 401,
      'the token still works after logout',
    );
    must(
      (await call('GET', base + '/auth/me', { token: a.token })).status === 200,
      'logout ended another session',
    );
  });
  await run('login-rate-limit', 'repeated failed sign-ins are throttled with 429', async () => {
    const email = 'probe.limit.' + uniq() + '@example.test';
    let last = 0;
    for (let i = 0; i < 7; i++)
      last = (
        await call('POST', base + '/auth/login', {
          body: { email, password: 'wrong-password-' + i },
        })
      ).status;
    must(last === 429, 'the seventh failure answered ' + last);
  });
  await run(
    'cross-origin-refused',
    'a state-changing request from another origin is refused',
    async () => {
      const r = await call('POST', base + '/auth/login', {
        body: { email: 'x@example.test', password: ctx.password },
        headers: { origin: 'https://attacker.example', host: 'app.example.test' },
      });
      must(r.status === 403, 'answered ' + r.status);
    },
  );
  void signedUp;

  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const skipped = checks.filter((c) => c.status === 'skipped').length;
  const required = REQUIRED_CHECKS.filter(
    (id) => checks.find((c) => c.id === id)?.status !== 'pass',
  );
  return {
    schema: 'nuzm.app-probe/1',
    app: meta.slug,
    tenancy,
    signup: signupRole !== null,
    checks,
    passed,
    failed,
    skipped,
    requiredNotPassed: [...required],
    ok: failed === 0 && required.length === 0,
    startedAt: new Date(started).toISOString(),
    durationMs: clock() - started,
  };
}
