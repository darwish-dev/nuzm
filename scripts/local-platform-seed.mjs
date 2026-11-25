/**
 * DEV ONLY, called by scripts/local-platform.sh: gives the local platform one customer organization and the platform staff accounts. Idempotent.
 *  - staff rows are written to the database, exactly as the browser tests do it (there is no API that creates platform staff: PA-12 awaits approval);
 *  - the customer signs in through the dev identity provider and creates the organization through the API, so the real sign-in and tenancy paths are exercised.
 * Refuses a non-local database and non-loopback consoles. It prints no cookie, token or password.
 *   env: NUZM_SEED_ADMIN_URL, NUZM_SEED_WEB_ORIGIN, NUZM_SEED_IDP_ORIGIN, NUZM_SEED_STAFF (JSON [{sub,email,role}])
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { fetch } = globalThis;
const { Client } = createRequire(join(process.cwd(), 'packages/db/package.json'))('pg');
const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required (run through scripts/local-platform.sh)`);
  return v;
};
const adminUrl = need('NUZM_SEED_ADMIN_URL');
const web = need('NUZM_SEED_WEB_ORIGIN');
const idp = need('NUZM_SEED_IDP_ORIGIN');
for (const u of [adminUrl, web, idp])
  if (!['127.0.0.1', 'localhost'].includes(new URL(u).hostname))
    throw new Error('local-platform seed only runs against loopback addresses');

export const ORG_NAME = 'Nuzm Local Demo';

async function seedStaff() {
  const staff = JSON.parse(need('NUZM_SEED_STAFF'));
  const db = new Client({ connectionString: adminUrl });
  await db.connect();
  try {
    for (const s of staff) {
      await db.query(
        `INSERT INTO identity.users (id, issuer, subject, email, email_verified, is_platform_user)
         SELECT $1, $2, $3, $4, true, true WHERE NOT EXISTS (SELECT 1 FROM identity.users WHERE issuer = $2 AND subject = $3)`,
        [randomUUID(), idp, s.sub, s.email],
      );
      await db.query(
        `INSERT INTO tenancy.platform_roles (user_id, role)
         SELECT id, $3 FROM identity.users WHERE issuer = $1 AND subject = $2 ON CONFLICT DO NOTHING`,
        [idp, s.sub, s.role],
      );
    }
    console.log(`staff accounts ready: ${staff.map((s) => `${s.email} (${s.role})`).join(', ')}`);
  } finally {
    await db.end();
  }
}

/** A minimal cookie jar: every host here is 127.0.0.1, and the flow needs only name=value. */
const jar = new Map();
async function call(url, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i);
    const value = pair.slice(i + 1);
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
  return res;
}
const expect = (res, status, step) => {
  if (res.status !== status)
    throw new Error(`seed: ${step} answered ${res.status}, expected ${status}`);
  return res;
};

async function seedCustomer() {
  const login = expect(
    await call(`${web}/v1/auth/oidc/login?returnTo=${encodeURIComponent(`${web}/`)}`),
    302,
    'sign-in start',
  );
  const authorize = new URL(login.headers.get('location'));
  authorize.searchParams.set('pick', 'dev-owner');
  const picked = expect(await call(authorize.toString()), 302, 'dev identity provider');
  expect(await call(picked.headers.get('location')), 302, 'sign-in callback');
  const csrf = jar.get('nuzm_csrf');
  if (!csrf) throw new Error('seed: sign-in set no CSRF cookie');

  const list = expect(await call(`${web}/v1/organizations`), 200, 'list organizations');
  const body = await list.json();
  const items = body.items ?? body.data ?? [];
  const found = items.find((o) => o.name === ORG_NAME || o.organization?.name === ORG_NAME);
  if (found) {
    console.log(`customer organization already present: ${ORG_NAME}`);
    return;
  }
  const created = await call(`${web}/v1/organizations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'idempotency-key': `local-platform-seed-${randomUUID()}`,
    },
    body: JSON.stringify({ name: ORG_NAME, country: 'SA', defaultLocale: 'ar' }),
  });
  expect(created, 201, 'create organization');
  console.log(`customer organization created: ${ORG_NAME} (owner@example.test)`);
}

await seedStaff();
await seedCustomer();
