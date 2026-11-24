/**
 * Seeds a LOCAL demo account for trying the mobile app: registers it (or signs in if it exists), creates its
 * organization and fills it through the public API (so every row goes through the same rules, RLS and audit as a
 * real user). Re-runnable: it only adds what is missing.
 *
 *   pnpm --filter @nuzm/api dev:stack            # API on :4000
 *   pnpm exec tsx scripts/seed-mobile-demo.ts    # BASE_URL defaults to http://127.0.0.1:4000
 *
 * The credentials are written to .local/mobile-demo-account.txt (git-ignored), never printed. Refuses Json host that
 * is not local or *.test. Paid resources are attempted through quotes on the local stack only (dev ledger, sandbox
 * providers); a refusal (no provider enabled, residency) is reported, not forced.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4000';
const host = new URL(BASE).hostname;
if (
  !['127.0.0.1', 'localhost'].includes(host) &&
  !host.endsWith('.test') &&
  !host.endsWith('.localhost')
) {
  console.error(`refusing to seed ${host}: local or .test hosts only`);
  process.exit(1);
}
const FILE = '.local/mobile-demo-account.txt';
const EMAIL = process.env.DEMO_EMAIL ?? 'demo-mobile@example.test';

// API bodies are read loosely here (a dev seed, not product code): the API validates every request it receives.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const jar: Record<string, string> = {};
let org: string | undefined;

type Res = { status: number; body: Json; etag?: string };
async function call(
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Res> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-nuzm-realm': 'web',
    'accept-language': 'ar',
    ...extra,
  };
  if (Object.keys(jar).length)
    headers.cookie = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  if (org) headers['x-nuzm-org'] = org;
  if (method !== 'GET' && jar.nuzm_csrf) headers['x-csrf-token'] = jar.nuzm_csrf;
  if (method === 'POST') headers['idempotency-key'] = randomUUID();
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of r.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv!.indexOf('=');
    const k = kv!.slice(0, i).trim();
    const v = kv!.slice(i + 1).trim();
    if (!v || /max-age=0/i.test(c)) delete jar[k];
    else jar[k] = v;
  }
  const text = await r.text();
  let parsed: Json = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: r.status, body: parsed, etag: r.headers.get('etag') ?? undefined };
}
const ok = (r: Res) => r.status >= 200 && r.status < 300;
const why = (r: Res) => `${r.status} ${r.body?.code ?? ''} ${r.body?.title ?? ''}`.trim();
const items = async (path: string): Promise<Json[]> => {
  const r = await call('GET', path + (path.includes('?') ? '&' : '?') + 'limit=100');
  return ok(r) ? (r.body?.items ?? []) : [];
};
async function versioned(method: 'PATCH' | 'PUT', path: string, body: unknown) {
  const g = await call('GET', path);
  return call(method, path, body, g.etag ? { 'if-match': g.etag } : {});
}

const report: string[] = [];
const step = async (name: string, f: () => Promise<string>) => {
  try {
    report.push(`  ${name.padEnd(28)} ${await f()}`);
  } catch (e) {
    report.push(`  ${name.padEnd(28)} ERROR ${(e as Error).message}`);
  }
};

async function main() {
  // ---- account
  let password = '';
  if (existsSync(FILE)) password = /password:\s*(\S+)/.exec(readFileSync(FILE, 'utf8'))?.[1] ?? '';
  const login = password
    ? await call('POST', '/v1/auth/password/login', { email: EMAIL, password, realm: 'web' })
    : null;
  if (!login || !ok(login)) {
    password = randomBytes(12).toString('base64url');
    const reg = await call('POST', '/v1/auth/register', {
      email: EMAIL,
      password,
      displayName: 'Darwish Demo',
      locale: 'ar',
    });
    if (!ok(reg)) {
      console.error(
        `could not register ${EMAIL}: ${why(reg)} (if it exists with another password, set DEMO_EMAIL)`,
      );
      process.exit(1);
    }
    mkdirSync('.local', { recursive: true });
    writeFileSync(
      FILE,
      `Nuzm mobile demo account (LOCAL dev stack only, generated ${new Date().toISOString()})\nemail: ${EMAIL}\npassword: ${password}\n`,
      { mode: 0o600 },
    );
    report.push(`  account                      registered ${EMAIL}`);
  } else report.push(`  account                      signed in ${EMAIL}`);

  // ---- organization
  let me = await call('GET', '/v1/me');
  if (!me.body?.memberships?.length) {
    const r = await call('POST', '/v1/organizations', {
      name: 'شركة القهوة التجارية',
      defaultLocale: 'ar',
      country: 'SA',
    });
    report.push(`  organization                 ${ok(r) ? 'created' : why(r)}`);
    me = await call('GET', '/v1/me');
  }
  org = me.body.memberships[0].orgId;
  report.push(
    `  organization                 ${me.body.memberships[0].name} (${me.body.memberships[0].role})`,
  );

  // ---- projects
  const ensure = async (path: string, list: Json[], match: (x: Json) => boolean, body: unknown) =>
    list.find(match) ?? (await call('POST', path, body)).body;
  await step('workspaces', async () => {
    let ws = await items('/v1/workspaces');
    for (const name of ['الرئيسية', 'التجارب'])
      await ensure('/v1/workspaces', ws, (x) => x.name === name, { name });
    ws = await items('/v1/workspaces');
    const main = ws.find((x) => x.name === 'الرئيسية');
    const ps = await items('/v1/projects');
    for (const name of ['متجر القهوة', 'بوابة العملاء', 'الموقع التعريفي'])
      await ensure('/v1/projects', ps, (x) => x.name === name, { workspaceId: main.id, name });
    return `${ws.length} workspaces, ${(await items('/v1/projects')).length} projects`;
  });
  await step('build projects', async () => {
    const bp = await items('/v1/builder/projects');
    for (const [type, name] of [
      ['website', 'موقع متجر القهوة'],
      ['webapp', 'لوحة الحجوزات'],
      ['mobile', 'تطبيق متجر القهوة'],
    ])
      await ensure('/v1/builder/projects', bp, (x) => x.name === name, {
        type,
        name,
        locale: ['ar', 'en'],
      });
    return `${(await items('/v1/builder/projects')).length}`;
  });

  // ---- settings
  await step('tax profile', async () => {
    const r = await versioned('PUT', '/v1/billing/tax-profile', {
      buyerType: 'b2b',
      legalName: { ar: 'شركة القهوة التجارية', en: 'Coffee Trading Co.' },
      vatNumber: '300000000000003',
      crNumber: '1010000000',
      address: {
        street: 'طريق الملك فهد',
        buildingNumber: '1234',
        district: 'العليا',
        city: 'الرياض',
        postalCode: '12211',
        country: 'SA',
      },
    });
    return ok(r) ? 'saved' : why(r);
  });
  await step('spending cap', async () => {
    const r = await versioned('PUT', '/v1/billing/spending-limits', {
      scope: 'org',
      monthlyCapMinor: '200000',
      currency: 'SAR',
      fourEyesAboveMinor: '50000',
    });
    return ok(r) ? '2,000.00 SAR' : why(r);
  });
  await step('AI budgets', async () => {
    const cur = (await call('GET', '/v1/ai/budgets')).body ?? {};
    const r = await versioned('PUT', '/v1/ai/budgets', {
      org: { ...(cur.org ?? {}), dailyCredits: 200, runMaxCredits: 40, totalCredits: 5000 },
      projects: cur.projects ?? [],
    });
    return ok(r) ? 'saved' : why(r);
  });

  // ---- email
  await step('email templates', async () => {
    const t = await items('/v1/email/templates');
    for (const [key, name, subject] of [
      ['order-confirmation', 'تأكيد الطلب', 'تم استلام طلبك'],
      ['password-reset', 'استعادة كلمة المرور', 'استعادة كلمة المرور'],
    ])
      if (!t.some((x) => x.key === key))
        await call('POST', '/v1/email/templates', {
          key,
          name,
          locale: 'ar',
          subject,
          html: `<p>${subject}</p>`,
        });
    return `${(await items('/v1/email/templates')).length}`;
  });
  await step('suppressions', async () => {
    const s = await items('/v1/email/suppressions');
    for (const address of ['bounced@example.test', 'unsubscribed@example.test'])
      if (!s.some((x) => x.address === address))
        await call('POST', '/v1/email/suppressions', { address, action: 'add' });
    return `${(await items('/v1/email/suppressions')).length}`;
  });
  await step('email domain', async () => {
    const d = await items('/v1/email/domains');
    if (d.length) return `${d.length}`;
    const r = await call('POST', '/v1/email/domains', {
      domain: 'coffee-demo.example.test',
      purposes: ['mailbox', 'transactional'],
    });
    return ok(r) ? 'added' : `skipped: ${why(r)}`;
  });

  // ---- team
  await step('invitations', async () => {
    for (const [email, role] of [
      ['sara@example.test', 'admin'],
      ['omar@example.test', 'developer'],
    ]) {
      const r = await call('POST', '/v1/invitations', { email, role });
      if (!ok(r) && r.status !== 409) return why(r);
    }
    return 'sent';
  });

  // ---- AI chat (the session and messages are stored even if the run is refused by the residency policy)
  await step('AI chats', async () => {
    const s = await items('/v1/ai/sessions');
    if (s.length >= 2) return `${s.length}`;
    for (const text of [
      'ابنِ لي متجرًا لبيع القهوة المختصة مع دفع إلكتروني',
      'اقترح نطاقًا متاحًا لعلامتي التجارية',
    ]) {
      const ses = await call('POST', '/v1/ai/sessions', { title: text.slice(0, 60) });
      if (!ok(ses)) return why(ses);
      const id = ses.body.id ?? ses.body.session?.id;
      await call('POST', `/v1/ai/sessions/${id}/messages`, { content: text });
      const run = await call('POST', '/v1/ai/runs', {
        sessionId: id,
        kind: 'chat',
        input: { mode: 'chat', locale: 'ar' },
      });
      if (!ok(run)) report.push(`  AI reply                     ${why(run)}`);
    }
    return `${(await items('/v1/ai/sessions')).length}`;
  });

  // ---- paid resources on the local stack (dev ledger and sandbox providers only)
  await step('hosting site', async () => {
    if ((await items('/v1/hosting/sites')).length) return 'exists';
    const plan = (await items('/v1/hosting/plans'))[0];
    const project = (await items('/v1/projects'))[0];
    if (!plan || !project) return 'skipped: no plan or project';
    const rt = plan.runtimes?.[0];
    const runtime = typeof rt === 'object' ? (rt.id ?? rt.key) : rt;
    const q = await call('POST', '/v1/quotes', {
      kind: 'hosting',
      items: [{ planId: plan.id, runtime }],
    });
    if (!ok(q)) return `quote refused: ${why(q)}`;
    const r = await call('POST', '/v1/hosting/sites', {
      quoteId: q.body.id,
      planId: plan.id,
      name: 'coffee-demo',
      projectId: project.id,
      runtime,
      primaryDomain: 'coffee-demo.example.test',
    });
    return ok(r)
      ? `created (quote ${q.body.totalMinor} ${q.body.currency})`
      : `not created: ${why(r)}`;
  });
  for (const [name, kind, item] of [
    ['bucket quote', 'storage', { estimatedGb: 20 }],
    [
      'database quote',
      'database',
      { engine: 'postgresql', version: '16', planRef: 'small', storageGb: 10 },
    ],
  ] as const) {
    await step(name, async () => {
      const q = await call('POST', '/v1/quotes', { kind, items: [item] });
      return ok(q) ? `priced ${q.body.totalMinor} ${q.body.currency}` : `refused: ${why(q)}`;
    });
  }

  console.log(`seeded ${BASE} as ${EMAIL}; credentials in ${FILE}\n${report.join('\n')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
