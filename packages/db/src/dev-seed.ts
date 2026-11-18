/**
 * DEV ONLY: fills one organization with demo servers, websites, domains and databases so every console screen has
 * something to show. Rows are written directly (provisioning needs real providers, which are human-gated), so this never runs
 * against a non-local database. Idempotent: an item whose name already exists in the organization is left alone.
 *
 * Every value is obviously fake: names start with `demo` / `<org slug>-demo`, IPs are from the documentation range 203.0.113.0/24, and
 * secrets are `vault://dev/demo/...` references only (no secret material anywhere).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Client, type ClientBase } from 'pg';

const REGION = 'sa-central';
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
type Report = Record<'servers' | 'websites' | 'domains' | 'databases', string[]>;

async function exists(c: ClientBase, table: string, orgId: string, name: string) {
  return (
    ((await c.query(`SELECT 1 FROM ${table} WHERE org_id = $1 AND name = $2`, [orgId, name]))
      .rowCount ?? 0) > 0
  );
}

/** Dev-mock reference rows the demo items hang off (a mock cloud account, two hosting plans, a sandbox registrar account). */
async function references(c: ClientBase, ownerId: string) {
  let account = (
    await c.query(
      `SELECT a.id FROM cloud.provider_accounts a JOIN cloud.providers p ON p.id = a.provider_id WHERE p.key = 'mock' AND a.name = 'demo-mock (dev seed)'`,
    )
  ).rows[0]?.id as string | undefined;
  if (!account) {
    account = randomUUID();
    const r = await c.query(
      `INSERT INTO cloud.provider_accounts (id, provider_id, name, vault_ref, scope_note, health_state, created_by)
       SELECT $1, id, 'demo-mock (dev seed)', 'vault://dev/demo/mock-compute', 'dev seed: demo servers only', 'healthy', $2 FROM cloud.providers WHERE key = 'mock'`,
      [account, ownerId],
    );
    if (!r.rowCount)
      throw new Error('no "mock" compute provider in cloud.providers (run db:migrate)');
  }

  const plans: Record<string, string> = {};
  for (const [key, ar, en, diskMb] of [
    ['demo-starter', 'المبتدئ (تجريبي)', 'Starter (demo)', 10_240],
    ['demo-business', 'الأعمال (تجريبي)', 'Business (demo)', 51_200],
  ] as const) {
    const quotas = {
      diskMb,
      inodes: 200_000,
      bandwidthGb: 100,
      dbCount: 5,
      sitesCount: 10,
      maxProcesses: 40,
      memoryMb: 1024,
    };
    const r = await c.query(
      `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation, placeholder)
       VALUES ($1, $2, $3, $4, 'active', $5, '["php:8.3","php:8.2","nodejs:20","python:3.12","static"]', '{"cpu_millicores":500,"memory_mb":1024,"disk_mb":10240}', true)
       ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING id`,
      [randomUUID(), key, ar, en, JSON.stringify(quotas)],
    );
    plans[key] = r.rows[0].id as string;
  }

  let registrar = (
    await c.query(
      `SELECT id FROM domains.registrar_accounts WHERE environment = 'sandbox' ORDER BY created_at LIMIT 1`,
    )
  ).rows[0]?.id as string | undefined;
  if (!registrar) {
    registrar = randomUUID();
    const r = await c.query(
      `INSERT INTO domains.registrar_accounts (id, registrar_id, label, environment, vault_ref, data_region, enabled)
       SELECT $1, id, 'demo registrar (dev seed)', 'sandbox', 'vault://dev/demo/registrar', 'NL', false FROM domains.registrars ORDER BY provider_code LIMIT 1`,
      [registrar],
    );
    if (!r.rowCount) throw new Error('no registrar in domains.registrars (run db:migrate)');
  }
  return { account, plans, registrar };
}

async function servers(
  c: ClientBase,
  orgId: string,
  ownerId: string,
  account: string,
  projectId: string | null,
  out: string[],
) {
  const caps = [
    'compute.metrics',
    'compute.action.start',
    'compute.action.stop',
    'compute.action.reboot',
  ];
  const items = [
    {
      name: 'demo-web-01',
      status: 'running',
      res: 'ACTIVE',
      plan: [2, 4096, 80],
      ip: '203.0.113.10',
    },
    {
      name: 'demo-api-02',
      status: 'running',
      res: 'ACTIVE',
      plan: [4, 8192, 160],
      ip: '203.0.113.11',
    },
    {
      name: 'demo-worker-03',
      status: 'stopped',
      res: 'ACTIVE',
      plan: [2, 4096, 60],
      ip: '203.0.113.12',
    },
    {
      name: 'demo-staging-04',
      status: 'provisioning',
      res: 'PROVISIONING',
      plan: [1, 2048, 40],
      ip: null,
    },
    { name: 'demo-legacy-05', status: 'failed', res: 'FAILED', plan: [1, 1024, 25], ip: null },
  ] as const;
  for (const s of items) {
    if (await exists(c, 'compute.instances', orgId, s.name)) continue;
    const resource = randomUUID();
    await c.query(
      `INSERT INTO cloud.resources (id, org_id, kind, provider_account_id, provider_ref, state, data_region, country, provider_region_id, last_seen_at)
       VALUES ($1, $2, 'compute_instance', $3, $4, $5, $6, 'SA', 'mock-sa-1', now())`,
      [resource, orgId, account, `demo-${s.name}-${hex(4)}`, s.res, REGION],
    );
    const [vcpu, memoryMb, diskGb] = s.plan;
    await c.query(
      `INSERT INTO compute.instances (id, org_id, project_id, resource_id, name, plan, status, capabilities, quote_id, data_region, country, public_ips, tags, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SA', $11, '{"seed":"demo"}', $12)`,
      [
        randomUUID(),
        orgId,
        projectId,
        resource,
        s.name,
        JSON.stringify({ vcpu, memoryMb, diskGb, bandwidth: '1 TB', planRef: `mock.${vcpu}c` }),
        s.status,
        JSON.stringify(s.status === 'failed' ? [] : caps),
        randomUUID(),
        REGION,
        JSON.stringify(s.ip ? [s.ip] : []),
        ownerId,
      ],
    );
    out.push(`${s.name} (${s.status})`);
  }
}

async function websites(
  c: ClientBase,
  orgId: string,
  ownerId: string,
  plans: Record<string, string>,
  projectId: string | null,
  base: string,
  out: string[],
) {
  const items = [
    {
      name: 'Codgoo Store',
      runtime: 'php:8.3',
      status: 'active',
      plan: 'demo-business',
      domain: `${base}-demo.com`,
    },
    {
      name: 'Marketing Site',
      runtime: 'static',
      status: 'active',
      plan: 'demo-starter',
      domain: `www.${base}-demo.com`,
    },
    {
      name: 'Docs Portal',
      runtime: 'nodejs:20',
      status: 'creating',
      plan: 'demo-starter',
      domain: null,
    },
    {
      name: 'Legacy Blog',
      runtime: 'php:7.4',
      status: 'suspended',
      plan: 'demo-starter',
      domain: `blog.${base}-demo.com`,
    },
  ] as const;
  for (const w of items) {
    if (await exists(c, 'hosting.sites', orgId, w.name)) continue;
    const id = randomUUID();
    await c.query(
      `INSERT INTO hosting.sites (id, org_id, project_id, name, token, node_name, plan_id, runtime, status, suspension_reason, suspended_by, data_region, domain_primary, credentials_ref, backup_key_ref, settings, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, '{"seed":"demo"}', $16)`,
      [
        id,
        orgId,
        projectId,
        w.name,
        hex(32),
        `s-${hex(8)}`,
        plans[w.plan],
        w.runtime,
        w.status,
        w.status === 'suspended' ? 'Disk quota exceeded (demo)' : null,
        w.status === 'suspended' ? 'quota' : null,
        REGION,
        w.domain,
        `vault://dev/demo/site-${id.slice(0, 8)}`,
        `vault://dev/demo/site-backup-${id.slice(0, 8)}`,
        ownerId,
      ],
    );
    const big = w.plan === 'demo-business';
    for (const [dim, limit] of [
      ['disk_mb', big ? 51_200 : 10_240],
      ['inodes', 200_000],
      ['bandwidth_gb', 100],
      ['processes', 40],
      ['memory_mb', 1024],
      ['db_count', 5],
      ['backup_count', 7],
      ['backup_gb', 5],
    ] as const)
      await c.query(
        `INSERT INTO hosting.site_quotas (site_id, org_id, dim, limit_value, soft_limit, state) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          orgId,
          dim,
          limit,
          Math.floor(limit * 0.8),
          w.status === 'suspended' && dim === 'disk_mb' ? 'hard' : 'ok',
        ],
      );
    if (w.domain)
      await c.query(
        `INSERT INTO hosting.site_domain_bindings (id, site_id, org_id, domain, state, is_primary, verification_token, verified_at)
         VALUES ($1, $2, $3, $4, 'active', true, $5, now())`,
        [randomUUID(), id, orgId, w.domain, hex(16)],
      );
    out.push(`${w.name} (${w.status})`);
  }
}

async function domains(
  c: ClientBase,
  orgId: string,
  ownerId: string,
  registrar: string,
  base: string,
  out: string[],
) {
  const items = [
    {
      name: `${base}-demo.com`,
      state: 'active',
      expires: 300,
      auto: true,
      privacy: 'on',
    },
    {
      name: `${base}-shop.net`,
      state: 'active',
      expires: 25,
      auto: false,
      privacy: 'on',
    },
    {
      name: `${base}-labs.org`,
      state: 'renewal_at_risk',
      expires: 9,
      auto: true,
      privacy: 'off',
    },
    {
      name: `${base}-old.com`,
      state: 'expired',
      expires: -20,
      auto: false,
      privacy: 'off',
    },
    {
      name: `${base}-move.com`,
      state: 'transferring',
      expires: null,
      auto: false,
      privacy: 'unknown',
    },
  ] as const;
  for (const d of items) {
    if (await exists(c, 'domains.domains', orgId, d.name)) continue;
    const id = randomUUID();
    const registered = d.state !== 'transferring';
    await c.query(
      `INSERT INTO domains.domains (id, org_id, name, tld, state, registrar_account_id, provider_ref, registered_at, expires_at, auto_renew, locked, privacy_state, nameservers, data_region, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, $12, $13, $14)`,
      [
        id,
        orgId,
        d.name,
        d.name.split('.').pop(),
        d.state,
        registrar,
        registered ? `demo-${hex(4)}` : null,
        registered ? days((d.expires ?? 0) - 365) : null,
        d.expires === null ? null : days(d.expires),
        d.auto,
        d.privacy,
        JSON.stringify(['ns1.nuzm-demo.net', 'ns2.nuzm-demo.net']),
        REGION,
        ownerId,
      ],
    );
    // no DNS zone is seeded: a zone lives at the registrar too (the dev mock keeps it in memory), so one written only here
    // could never be changed. Use "Create DNS zone" on the domain's DNS page instead.
    out.push(`${d.name} (${d.state})`);
  }
}

async function databases(
  c: ClientBase,
  orgId: string,
  ownerId: string,
  projectId: string | null,
  out: string[],
) {
  const items = [
    {
      name: 'demo-main-pg',
      engine: 'postgresql',
      version: '16',
      state: 'running',
      port: 5432,
      gb: 20,
    },
    { name: 'demo-cache', engine: 'redis', version: '7.2', state: 'running', port: 6379, gb: 2 },
    {
      name: 'demo-analytics',
      engine: 'mysql',
      version: '8.0',
      state: 'provisioning',
      port: null,
      gb: 50,
    },
    {
      name: 'demo-reports-pg',
      engine: 'postgresql',
      version: '15',
      state: 'failed',
      port: null,
      gb: 10,
    },
  ] as const;
  for (const d of items) {
    if (await exists(c, 'data.database_instances', orgId, d.name)) continue;
    const running = d.state === 'running';
    await c.query(
      `INSERT INTO data.database_instances (id, org_id, project_id, name, engine, version, plan_ref, storage_gb, state, host, port, vault_ref, data_region, provider_region_id, create_token, backup_policy, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'demo.small', $7, $8, $9, $10, $11, $12, 'mock-sa-1', $13, '{"enabled":true,"intervalHours":24,"retentionDays":7}', $14)`,
      [
        randomUUID(),
        orgId,
        projectId,
        d.name,
        d.engine,
        d.version,
        d.gb,
        d.state,
        running ? `${d.name}.db.nuzm-demo.net` : null,
        d.port,
        running ? `vault://dev/demo/db-${d.name}` : null,
        REGION,
        `demo-${d.name}-${hex(6)}`,
        ownerId,
      ],
    );
    out.push(`${d.name} (${d.engine} ${d.version}, ${d.state})`);
  }
}

/** Seeds the organization named or identified by `org` (an id or an exact name). */
export async function devSeed(url: string, org: string): Promise<Report> {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname))
    throw new Error('dev-seed only runs against a local database');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const o = (
      await c.query(
        `SELECT id, name, slug FROM tenancy.organizations WHERE id::text = $1 OR name = $1 OR slug = $1 ORDER BY created_at LIMIT 2`,
        [org],
      )
    ).rows;
    if (o.length !== 1)
      throw new Error(`organization "${org}" not found (or the name is ambiguous: pass its id)`);
    const orgId = o[0].id as string;
    // domain names are unique across the platform, so each organization's demo domains carry its slug
    const base =
      String(o[0].slug ?? o[0].name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'demo';
    const owner = (
      await c.query(
        `SELECT user_id FROM tenancy.memberships WHERE org_id = $1 ORDER BY (role = 'owner') DESC, created_at LIMIT 1`,
        [orgId],
      )
    ).rows[0]?.user_id as string | undefined;
    if (!owner) throw new Error('the organization has no members');
    const project = (
      await c.query(
        `SELECT id FROM tenancy.projects WHERE org_id = $1 ORDER BY created_at LIMIT 1`,
        [orgId],
      )
    ).rows[0]?.id as string | undefined;

    const out: Report = { servers: [], websites: [], domains: [], databases: [] };
    await c.query('BEGIN');
    const ref = await references(c, owner);
    await servers(c, orgId, owner, ref.account, project ?? null, out.servers);
    await websites(c, orgId, owner, ref.plans, project ?? null, base, out.websites);
    await domains(c, orgId, owner, ref.registrar, base, out.domains);
    await databases(c, orgId, owner, project ?? null, out.databases);
    // the screens are behind these flags; the seed turns them on for this organization only
    for (const key of ['cloud.provisioning', 'hosting.enabled', 'domains.enabled'])
      await c.query(
        `INSERT INTO platform.feature_flags (id, key, org_id, value) SELECT $1, $2, $3, $4
         WHERE NOT EXISTS (SELECT 1 FROM platform.feature_flags WHERE key = $2 AND org_id = $3)`,
        [randomUUID(), key, orgId, key === 'cloud.provisioning' ? 'true' : '{"enabled": true}'],
      );
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
