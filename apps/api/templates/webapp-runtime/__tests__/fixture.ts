// Hand-written fixture of the template's OWN unit tests (the template is tested without generating or running any generated app).
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/auth.ts';
import { buildRouter } from '../src/engine.ts';
import { MemoryStore } from '../src/memory-store.ts';
import { MemoryNotifier } from '../src/notify.ts';
import { SECURITY_HEADERS } from '../src/http.ts';
import type { AppMeta, AuthMeta, Store } from '../src/types.ts';
import type { ProbeContext, ProbeResponse, ProbeTransport } from '../probe/suite.ts';

export const PASSWORD = 'correct horse battery 1';
export const SECRET = 'k'.repeat(48);

export function fixtureMeta(auth?: AuthMeta): AppMeta {
  const ar = (s: string) => ({ ar: s, en: s });
  return {
    slug: 'fixture-crm',
    name: 'Fixture CRM',
    locales: ['ar', 'en'],
    defaultLocale: 'ar',
    basePath: '/api/v1',
    defaultLimit: 20,
    maxLimit: 100,
    attachmentMaxBytes: 1024,
    csvImportExport: false,
    notifications: [],
    ...(auth ? { auth } : {}),
    entities: {
      Customer: {
        name: 'Customer',
        plural: 'customers',
        table: 'customers',
        labels: ar('Customer'),
        ownership: 'owner',
        audit: true,
        searchable: ['name'],
        sortable: ['name'],
        stageField: null,
        fields: [
          {
            name: 'name',
            column: 'name',
            type: 'string',
            required: true,
            unique: false,
            maxLength: 80,
            min: null,
            max: null,
            enumValues: null,
            references: null,
            pii: false,
            labels: ar('Name'),
          },
          {
            name: 'email',
            column: 'email',
            type: 'email',
            required: false,
            unique: true,
            maxLength: null,
            min: null,
            max: null,
            enumValues: null,
            references: null,
            pii: true,
            labels: ar('Email'),
          },
        ],
      },
      Note: {
        name: 'Note',
        plural: 'notes',
        table: 'notes',
        labels: ar('Note'),
        ownership: 'owner',
        audit: false,
        searchable: ['body'],
        sortable: ['body'],
        stageField: null,
        fields: [
          {
            name: 'body',
            column: 'body',
            type: 'string',
            required: true,
            unique: false,
            maxLength: 200,
            min: null,
            max: null,
            enumValues: null,
            references: null,
            pii: false,
            labels: ar('Body'),
          },
          {
            name: 'customerId',
            column: 'customer_id',
            type: 'reference',
            required: true,
            unique: false,
            maxLength: null,
            min: null,
            max: null,
            enumValues: null,
            references: 'Customer',
            pii: false,
            labels: ar('Customer'),
          },
        ],
      },
    },
    roles: {
      admin: {
        name: 'admin',
        labels: ar('Admin'),
        scope: 'all',
        admin: true,
        permissions: {
          Customer: ['create', 'read', 'update', 'delete'],
          Note: ['create', 'read', 'update', 'delete'],
        },
      },
      rep: {
        name: 'rep',
        labels: ar('Rep'),
        scope: 'own',
        admin: false,
        permissions: { Customer: ['create', 'read', 'update', 'delete'], Note: ['create', 'read'] },
      },
    },
    pages: [],
  };
}

export const SAMPLES: ProbeContext['samples'] = {
  Customer: { name: 'Sample name {n}', email: 'person{n}@example.test' },
  Note: { body: 'Synthetic note {n}', customerId: '{ref}' },
};

export function fixtureOpenApi(meta: AppMeta): ProbeContext['openapi'] {
  const b = meta.basePath;
  const sec = [{ bearerAuth: [] }];
  const paths: ProbeContext['openapi']['paths'] = {
    '/health': { get: { operationId: 'health', security: [] } },
    [b + '/auth/login']: { post: { operationId: 'login', security: [] } },
    [b + '/auth/me']: { get: { operationId: 'me', security: sec } },
    [b + '/auth/logout']: { post: { operationId: 'logout', security: sec } },
    [b + '/users']: {
      get: { operationId: 'listUsers', security: sec },
      post: { operationId: 'createUser', security: sec },
    },
  };
  if (meta.auth?.signupRole)
    paths[b + '/auth/signup'] = { post: { operationId: 'signup', security: [] } };
  for (const e of Object.values(meta.entities)) {
    paths[b + '/' + e.plural] = {
      get: { operationId: 'list' + e.name, security: sec },
      post: { operationId: 'create' + e.name, security: sec },
    };
    paths[b + '/' + e.plural + '/{id}'] = {
      get: { operationId: 'get' + e.name, security: sec },
      patch: { operationId: 'update' + e.name, security: sec },
      delete: { operationId: 'delete' + e.name, security: sec },
    };
  }
  return { paths };
}

export function newApp(auth?: AuthMeta, store?: Store) {
  const meta = fixtureMeta(auth);
  const st = store ?? new MemoryStore(meta);
  const router = buildRouter({
    meta,
    store: st,
    notifier: new MemoryNotifier(),
    sessionSecret: SECRET,
  });
  const transport: ProbeTransport = {
    async request(method, path, o = {}): Promise<ProbeResponse> {
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      if (o.token) headers['authorization'] = 'Bearer ' + o.token;
      let raw = o.raw ?? '';
      if (o.body !== undefined) {
        headers['content-type'] = 'application/json';
        raw = JSON.stringify(o.body);
      }
      const r = await router.handle(method, path, headers, raw);
      const text = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body));
      return {
        status: r.status,
        headers: { ...SECURITY_HEADERS, ...(r.headers ?? {}) },
        body: r.body,
        text,
      };
    },
  };
  let seq = 0;
  const provisionAdmin = async (label: string) => {
    const email = 'admin.' + label + '.' + ++seq + '@example.test';
    let tenantId: string | null = null;
    if (auth?.tenancy === 'multi') {
      tenantId = randomUUID();
      await st.insertTenant({
        id: tenantId,
        name: 'T ' + label,
        createdAt: new Date().toISOString(),
      });
    }
    await st.insertUser({
      id: randomUUID(),
      email,
      name: 'Admin ' + label,
      role: 'admin',
      teamId: null,
      ...(auth?.tenancy === 'multi' ? { tenantId } : {}),
      locale: 'en',
      passwordHash: await hashPassword(PASSWORD),
      active: true,
      createdAt: new Date().toISOString(),
    });
    return { email, password: PASSWORD };
  };
  const ctx: ProbeContext = {
    meta: meta as never,
    openapi: fixtureOpenApi(meta),
    samples: SAMPLES,
    password: PASSWORD,
    provisionAdmin,
  };
  return { meta, store: st, router, transport, ctx, provisionAdmin };
}
