/**
 * DEV ONLY: a fake compute catalog so the cloud server screens have offers to show: four provider accounts (the simulator plus the three vendor
 * slots), a few regions, sizes and operating-system images for each, and the placeholder price book completed with a disk meter. It refuses to run
 * against a non-local database.
 *
 * Everything here is obviously fake and labelled so: accounts are `demo-<key> (dev seed)` with `vault://dev/demo/...` references (no secret
 * material), regions carry `mock` evidence (offers built on mock evidence never appear in a production profile), and the added price version is marked
 * DRAFT-NOT-APPROVED (HG-02-01; price policy D-23 is open). Only the simulator account can actually provision: the vendor slots have no live adapter
 * or credentials in a dev stack, so for them a quote works but creating the server fails honestly.
 *
 * The simulator account uses the mock-compute adapter's OWN catalog ids (regions `mock-eu-1`/`mock-sa-1`, plans `mock.small|medium|large`, images
 * `mock-ubuntu`/`mock-debian`; see DEFAULT_MOCK_REGIONS/PLANS in packages/adapters/mock-compute), because the adapter rejects anything it does not list
 * (`region_not_listed`). The vendor slots keep invented ids on purpose: they cannot provision. A guard test (dev-cloud.spec.ts) keeps the two in step.
 *
 * Idempotent: rows that already exist are left alone.
 */
import { randomUUID } from 'node:crypto';
import { Client, type ClientBase } from 'pg';

interface Size {
  ref: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  bandwidth: string;
  /** What the (fake) vendor would charge per month, in USD minor units: only to satisfy "a provider price exists". */
  costMinor: number;
}
interface Line {
  key: 'mock' | 'alibaba' | 'huawei' | 'contabo';
  regions: [id: string, country: string, name: string][];
  sizes: Size[];
  /** images with the provider's own ref; when absent the generic `IMAGES` list is used with a derived `dev-*` ref */
  images?: [ref: string, name: string, family: string][];
}
export const LINES: Line[] = [
  {
    // the simulator's own catalog (listed regions only: `mock-us-1` is unlisted in the adapter, so it is not seeded)
    key: 'mock',
    regions: [
      ['mock-sa-1', 'SA', 'Riyadh (simulator)'],
      ['mock-eu-1', 'DE', 'Frankfurt (simulator)'],
    ],
    sizes: [
      { ref: 'mock.small', vcpu: 1, memoryMb: 2048, diskGb: 40, bandwidth: '1 TB', costMinor: 400 },
      {
        ref: 'mock.medium',
        vcpu: 2,
        memoryMb: 4096,
        diskGb: 80,
        bandwidth: '2 TB',
        costMinor: 800,
      },
      {
        ref: 'mock.large',
        vcpu: 4,
        memoryMb: 8192,
        diskGb: 160,
        bandwidth: '4 TB',
        costMinor: 1600,
      },
    ],
    images: [
      ['mock-ubuntu', 'Mock Ubuntu', 'linux'],
      ['mock-debian', 'Mock Debian', 'linux'],
    ],
  },
  {
    key: 'alibaba',
    regions: [
      ['dev-sa-1', 'SA', 'Riyadh'],
      ['dev-ae-1', 'AE', 'Dubai'],
      ['dev-sg-1', 'SG', 'Singapore'],
    ],
    sizes: [
      { ref: 'nova-1', vcpu: 1, memoryMb: 2048, diskGb: 40, bandwidth: '2 TB', costMinor: 900 },
      { ref: 'nova-2', vcpu: 2, memoryMb: 4096, diskGb: 80, bandwidth: '3 TB', costMinor: 1800 },
      { ref: 'nova-4', vcpu: 4, memoryMb: 8192, diskGb: 160, bandwidth: '5 TB', costMinor: 3600 },
      { ref: 'nova-8', vcpu: 8, memoryMb: 16384, diskGb: 320, bandwidth: '8 TB', costMinor: 7200 },
    ],
  },
  {
    key: 'huawei',
    regions: [
      ['dev-sa-1', 'SA', 'Riyadh'],
      ['dev-de-1', 'DE', 'Frankfurt'],
    ],
    sizes: [
      { ref: 'atlas-2', vcpu: 2, memoryMb: 2048, diskGb: 40, bandwidth: '3 TB', costMinor: 1000 },
      { ref: 'atlas-4', vcpu: 4, memoryMb: 4096, diskGb: 80, bandwidth: '5 TB', costMinor: 2000 },
      { ref: 'atlas-8', vcpu: 8, memoryMb: 8192, diskGb: 160, bandwidth: '8 TB', costMinor: 4000 },
      {
        ref: 'atlas-16',
        vcpu: 16,
        memoryMb: 16384,
        diskGb: 320,
        bandwidth: '12 TB',
        costMinor: 8000,
      },
    ],
  },
  {
    key: 'contabo',
    regions: [
      ['dev-de-1', 'DE', 'Nuremberg'],
      ['dev-us-1', 'US', 'St. Louis'],
    ],
    sizes: [
      { ref: 'orbit-2', vcpu: 2, memoryMb: 4096, diskGb: 200, bandwidth: '32 TB', costMinor: 600 },
      { ref: 'orbit-4', vcpu: 4, memoryMb: 8192, diskGb: 400, bandwidth: '32 TB', costMinor: 1200 },
      {
        ref: 'orbit-6',
        vcpu: 6,
        memoryMb: 16384,
        diskGb: 800,
        bandwidth: '32 TB',
        costMinor: 2200,
      },
    ],
  },
];
const IMAGES: [name: string, family: string][] = [
  ['Ubuntu 24.04 LTS', 'linux'],
  ['Ubuntu 22.04 LTS', 'linux'],
  ['Debian 12', 'linux'],
  ['AlmaLinux 9', 'linux'],
  ['Rocky Linux 9', 'linux'],
];
const CAPABILITIES = ['compute.provision', 'compute.inspect', 'compute.delete', 'compute.metrics'];
/** Placeholder disk price (halalas per GiB-month), added next to the existing placeholder vCPU and memory prices. */
const DISK_UNIT_PRICE_MINOR = '50';

type Report = Record<
  | 'accounts'
  | 'regions'
  | 'plans'
  | 'images'
  | 'price'
  | 'processors'
  | 'residency'
  | 'allowance'
  | 'hosting',
  string[]
>;

async function accountFor(c: ClientBase, key: string, creator: string): Promise<string | null> {
  const name = `demo-${key} (dev seed)`;
  const have = (
    await c.query(
      `SELECT a.id FROM cloud.provider_accounts a JOIN cloud.providers p ON p.id = a.provider_id WHERE p.key = $1 AND a.name = $2`,
      [key, name],
    )
  ).rows[0]?.id as string | undefined;
  if (have) return have;
  const id = randomUUID();
  const r = await c.query(
    `INSERT INTO cloud.provider_accounts (id, provider_id, name, vault_ref, scope_note, health_state, verified_at, created_by)
     SELECT $1, id, $2, $3, 'dev seed: fake catalog, no credentials', 'healthy', now(), $4 FROM cloud.providers WHERE key = $5`,
    [id, name, `vault://dev/demo/${key}`, creator, key],
  );
  return r.rowCount ? id : null;
}

export async function devSeedCloud(url: string, org?: string): Promise<Report> {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname))
    throw new Error('dev-seed-cloud only runs against a local database');
  const c = new Client({ connectionString: url });
  await c.connect();
  const out: Report = {
    accounts: [],
    regions: [],
    plans: [],
    images: [],
    price: [],
    processors: [],
    residency: [],
    allowance: [],
    hosting: [],
  };
  try {
    const creator = (await c.query(`SELECT id FROM identity.users ORDER BY created_at LIMIT 1`))
      .rows[0]?.id as string | undefined;
    if (!creator) throw new Error('no user yet: register once first');
    await c.query('BEGIN');

    for (const line of LINES) {
      const existed =
        ((
          await c.query(
            `SELECT 1 FROM cloud.provider_accounts a JOIN cloud.providers p ON p.id = a.provider_id WHERE p.key = $1 AND a.name = $2`,
            [line.key, `demo-${line.key} (dev seed)`],
          )
        ).rowCount ?? 0) > 0;
      const account = await accountFor(c, line.key, creator);
      if (!account)
        throw new Error(`no "${line.key}" provider in cloud.providers (run db:migrate)`);
      if (!existed) out.accounts.push(line.key);
      for (const cap of CAPABILITIES)
        await c.query(
          `INSERT INTO cloud.provider_capabilities (account_id, capability_id, state, probed_at, evidence_ref)
           VALUES ($1, $2, 'supported', now(), 'dev-seed') ON CONFLICT (account_id, capability_id) DO NOTHING`,
          [account, cap],
        );
      for (const [regionId, country, display] of line.regions) {
        let region = (
          await c.query(
            `SELECT id FROM cloud.provider_regions WHERE account_id = $1 AND provider_region_id = $2`,
            [account, regionId],
          )
        ).rows[0]?.id as string | undefined;
        if (!region) {
          region = randomUUID();
          await c.query(
            `INSERT INTO cloud.provider_regions (id, account_id, provider_region_id, country_code, display_name, state, verified_at, evidence_ref, evidence_kind)
             VALUES ($1, $2, $3, $4, $5, 'verified', now(), 'dev-seed', 'mock')`,
            [region, account, regionId, country, display],
          );
          out.regions.push(`${line.key}/${regionId}`);
        } else {
          // keep the verification fresh so a re-run revives offers that went stale
          await c.query(
            `UPDATE cloud.provider_regions SET state = 'verified', verified_at = now(), last_seen_at = now() WHERE id = $1`,
            [region],
          );
        }
        for (const s of line.sizes) {
          const r = await c.query(
            `INSERT INTO cloud.provider_plans (id, account_id, region_id, plan_ref, vcpu, memory_mb, disk_gb, bandwidth, provider_price_minor, currency, period, availability)
             SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, 'USD', 'month', 'available'
              WHERE NOT EXISTS (SELECT 1 FROM cloud.provider_plans WHERE account_id = $2 AND region_id = $3 AND plan_ref = $4)`,
            [
              randomUUID(),
              account,
              region,
              s.ref,
              s.vcpu,
              s.memoryMb,
              s.diskGb,
              s.bandwidth,
              s.costMinor,
            ],
          );
          if (r.rowCount) out.plans.push(`${line.key}/${regionId}/${s.ref}`);
        }
        const images: [ref: string, name: string, family: string][] =
          line.images ??
          IMAGES.map(([name, family]): [string, string, string] => [
            `dev-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            name,
            family,
          ]);
        for (const [imageRef, name, family] of images) {
          const r = await c.query(
            `INSERT INTO compute.images (id, account_id, provider_region_id, image_ref, name, os_family)
             SELECT $1, $2, $3, $4, $5, $6
              WHERE NOT EXISTS (SELECT 1 FROM compute.images WHERE account_id = $2 AND provider_region_id = $3 AND image_ref = $4)`,
            [randomUUID(), account, regionId, imageRef, name, family],
          );
          if (r.rowCount) out.images.push(`${line.key}/${regionId}/${name}`);
        }
      }
    }

    // O-10: databases seeded before the simulator used its own catalog still hold `dev-*` regions for the simulator account, which the adapter rejects
    // (`region_not_listed`). Withdraw them (a state the schema allows; offers list verified regions only). Nothing is deleted.
    await c.query(
      `UPDATE cloud.provider_regions r SET state = 'withdrawn'
         FROM cloud.provider_accounts a JOIN cloud.providers p ON p.id = a.provider_id
        WHERE r.account_id = a.id AND p.key = 'mock' AND a.name = 'demo-mock (dev seed)'
          AND r.provider_region_id LIKE 'dev-%' AND r.state <> 'withdrawn'`,
    );

    // the placeholder price book has vCPU and memory prices but no disk price, so no compute plan could be priced: add a new placeholder version
    const book = (
      await c.query(
        `SELECT pb.id FROM billing.price_books pb JOIN billing.price_book_versions v ON v.price_book_id = pb.id
          WHERE v.note LIKE 'DRAFT-NOT-APPROVED%' ORDER BY pb.created_at LIMIT 1`,
      )
    ).rows[0]?.id as string | undefined;
    if (book) {
      const latest = (
        await c.query(
          `SELECT v.id, v.version FROM billing.price_book_versions v WHERE v.price_book_id = $1 AND v.status = 'published' ORDER BY v.version DESC LIMIT 1`,
          [book],
        )
      ).rows[0] as { id: string; version: number } | undefined;
      const hasDisk =
        latest &&
        ((
          await c.query(
            `SELECT 1 FROM billing.price_items WHERE version_id = $1 AND meter_id = 'compute.disk_gb_months'`,
            [latest.id],
          )
        ).rowCount ?? 0) > 0;
      if (latest && !hasDisk) {
        const vid = randomUUID();
        await c.query(
          `INSERT INTO billing.price_book_versions (id, price_book_id, version, status, effective_from, note)
           VALUES ($1, $2, $3, 'draft', now(), 'DRAFT-NOT-APPROVED dev placeholder (HG-02-01): adds a disk meter so compute plans can be priced')`,
          [vid, book, latest.version + 1],
        );
        await c.query(
          `INSERT INTO billing.price_items (id, version_id, meter_id, tier_model, unit_price_minor, tiers, included_allowance, rounding)
           SELECT gen_random_uuid(), $1, meter_id, tier_model, unit_price_minor, tiers, included_allowance, rounding
             FROM billing.price_items WHERE version_id = $2`,
          [vid, latest.id],
        );
        await c.query(
          `INSERT INTO billing.price_items (id, version_id, meter_id, tier_model, unit_price_minor, included_allowance, rounding)
           VALUES (gen_random_uuid(), $1, 'compute.disk_gb_months', 'flat', $2, 0, 'half_up')`,
          [vid, DISK_UNIT_PRICE_MINOR],
        );
        await c.query(
          `UPDATE billing.price_book_versions SET status = 'published', published_by = $2, published_at = now() WHERE id = $1`,
          [vid, '00000000-0000-0000-0000-000000000000'],
        );
        out.price.push(
          `version ${latest.version + 1} (disk ${DISK_UNIT_PRICE_MINOR} halalas/GiB-month)`,
        );
      }
    }

    // hosting plans are listed only when a healthy node with room exists: add one in-Kingdom demo node (no agent, no real server). Its data region is the
    // verified region id `sa-central`: a bare group name such as `in_kingdom` carries no verification, so residency would treat it as outside the Kingdom.
    const nodeName = 'demo-node-01';
    if (
      ((await c.query(`SELECT 1 FROM hosting.nodes WHERE name = $1`, [nodeName])).rowCount ?? 0) ===
      0
    ) {
      const node = randomUUID();
      await c.query(
        `INSERT INTO hosting.nodes (id, name, compute_instance_id, region, data_region, status, runtimes, health, created_by)
         VALUES ($1, $2, 'dev-seed-no-server', 'sa-central', 'sa-central', 'active', $3::jsonb, 'healthy', $4)`,
        [
          node,
          nodeName,
          JSON.stringify(['php:8.3', 'php:8.2', 'nodejs:20', 'python:3.12', 'static']),
          creator,
        ],
      );
      for (const [dim, sellable] of [
        ['cpu_millicores', 16_000],
        ['memory_mb', 32_768],
        ['disk_mb', 1_000_000],
        ['sites', 200],
      ] as const)
        await c.query(
          `INSERT INTO hosting.node_capacity (node_id, dim, physical, sellable, reserved) VALUES ($1, $2, $3, $3, 0)`,
          [node, dim, sellable],
        );
      out.hosting.push(`${nodeName} with capacity`);
    }
    // hosting TYPES with several plans each (a plan key is `<type>-<tier>`): web, cloud, web app and agency. Prices are left empty (placeholder), so the
    // console says "price at checkout" instead of showing a number nobody approved.
    const ALL = ['php:8.3', 'php:8.2', 'nodejs:20', 'python:3.12', 'static'];
    const WEB = ['php:8.3', 'php:8.2', 'static'];
    const APP = ['nodejs:20', 'python:3.12', 'static'];
    const q = (
      diskGb: number,
      bandwidthGb: number,
      dbCount: number,
      sitesCount: number,
      maxProcesses: number,
      inodesM: number,
    ) => ({
      diskMb: diskGb * 1024,
      inodes: inodesM * 1_000_000,
      bandwidthGb,
      dbCount,
      sitesCount,
      maxProcesses,
      memoryMb: 1024,
    });
    const PLANS: [
      key: string,
      ar: string,
      en: string,
      quotas: object,
      runtimes: string[],
      reserve: [number, number, number],
    ][] = [
      ['web-start', 'البداية', 'Start', q(20, 200, 5, 1, 30, 0.4), WEB, [250, 512, 5120]],
      ['web-business', 'الأعمال', 'Business', q(50, 500, 25, 10, 40, 1), WEB, [500, 1024, 10240]],
      [
        'web-premium',
        'المتقدمة',
        'Premium',
        q(100, 1000, 50, 100, 60, 2),
        ALL,
        [1000, 2048, 20480],
      ],
      [
        'cloud-startup',
        'البداية السحابية',
        'Cloud Startup',
        q(100, 2000, 50, 100, 80, 2),
        ALL,
        [2000, 3072, 40960],
      ],
      [
        'cloud-professional',
        'السحابة الاحترافية',
        'Cloud Professional',
        q(200, 4000, 100, 300, 100, 3),
        ALL,
        [3000, 6144, 81920],
      ],
      [
        'cloud-enterprise',
        'سحابة المؤسسات',
        'Cloud Enterprise',
        q(300, 8000, 200, 300, 160, 4),
        ALL,
        [4000, 12288, 122880],
      ],
      [
        'webapp-start',
        'تطبيقات الويب - البداية',
        'Web App Start',
        q(30, 500, 10, 5, 60, 1),
        APP,
        [500, 1024, 10240],
      ],
      [
        'webapp-pro',
        'تطبيقات الويب - احترافي',
        'Web App Pro',
        q(100, 2000, 30, 20, 120, 2),
        APP,
        [1500, 3072, 30720],
      ],
      [
        'agency-10',
        'الوكالات - 10 مواقع',
        'Agency 10',
        q(150, 3000, 60, 10, 100, 3),
        ALL,
        [2000, 4096, 61440],
      ],
      [
        'agency-50',
        'الوكالات - 50 موقعًا',
        'Agency 50',
        q(400, 8000, 200, 50, 200, 6),
        ALL,
        [4000, 8192, 163840],
      ],
    ];
    for (const [key, ar, en, quotas, runtimes, [cpu, mem, disk]] of PLANS) {
      const r = await c.query(
        `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation, placeholder)
         VALUES ($1, $2, $3, $4, 'active', $5::jsonb, $6::jsonb, $7::jsonb, true) ON CONFLICT (key) DO NOTHING`,
        [
          randomUUID(),
          key,
          ar,
          en,
          JSON.stringify(quotas),
          JSON.stringify(runtimes),
          JSON.stringify({ cpu_millicores: cpu, memory_mb: mem, disk_mb: disk }),
        ],
      );
      if (r.rowCount) out.hosting.push(`plan ${key}`);
    }
    // DEV-ONLY prices so a checkout can be tried end to end (a hosting quote refuses a plan with no approved price). These are NOT approved prices
    // (HG-02-01 / D-23 are open): they exist only in a local dev database and only fill plans that have no price yet.
    const DEV_PRICES: Record<string, number> = {
      'web-start': 2900,
      'web-business': 5900,
      'web-premium': 9900,
      'cloud-startup': 12900,
      'cloud-professional': 22900,
      'cloud-enterprise': 39900,
      'webapp-start': 4900,
      'webapp-pro': 12900,
      'agency-10': 29900,
      'agency-50': 99900,
    };
    for (const [key, minor] of Object.entries(DEV_PRICES)) {
      const r = await c.query(
        `UPDATE hosting.plan_definitions SET price_minor = $2, currency = 'SAR', placeholder = false WHERE key = $1 AND price_minor IS NULL`,
        [key, minor],
      );
      if (r.rowCount) out.hosting.push(`dev price for ${key}`);
    }
    // the earlier flat demo plans are replaced by the typed ones above
    await c.query(
      `UPDATE hosting.plan_definitions SET status = 'retired' WHERE key IN ('demo-starter', 'demo-business', 'demo-pro') AND status = 'active'`,
    );

    // residency asks whether the receiving party is in the record of processing for this data class: register the sandbox processors (dev only; this is not a DPO review)
    const ropa = (
      await c.query(
        `SELECT * FROM compliance.ropa_entries WHERE entry_key = 'adapter:compute' AND org_id IS NULL ORDER BY version DESC LIMIT 1`,
      )
    ).rows[0] as
      | {
          version: number;
          processors: { name: string }[];
          activity: string;
          purpose: string;
          data_classes: string[];
        }
      | undefined;
    if (ropa) {
      const missing = LINES.filter((l) => !ropa.processors.some((p) => p.name === l.key));
      if (missing.length) {
        const processors = [
          ...ropa.processors,
          ...missing.map((l) => ({
            name: l.key,
            role: 'processor',
            region: 'other',
            dataClasses: ['customer-content', 'internal'],
            contractRef: null,
          })),
        ];
        await c.query(
          `INSERT INTO compliance.ropa_entries (id, entry_key, version, org_id, kind, adapter_kind, activity, purpose, data_classes, processors, regions, retention_ref, status, change_note)
           SELECT gen_random_uuid(), entry_key, $2, NULL, kind, adapter_kind, activity, purpose, data_classes, $3::jsonb, regions, retention_ref, 'draft',
                  'dev seed: sandbox processors, NOT a DPO review'
             FROM compliance.ropa_entries WHERE entry_key = 'adapter:compute' AND org_id IS NULL AND version = $1`,
          [ropa.version, ropa.version + 1, JSON.stringify(processors)],
        );
        out.processors.push(...missing.map((l) => l.key));
      }
    }

    // optionally let one organization place customer content outside the Kingdom, so its region picker shows every region (new organizations stay in-Kingdom)
    if (org) {
      const o = (
        await c.query(
          `SELECT id FROM tenancy.organizations WHERE id::text = $1 OR name = $1 OR slug = $1 ORDER BY created_at LIMIT 2`,
          [org],
        )
      ).rows;
      if (o.length !== 1)
        throw new Error(`organization "${org}" not found (or ambiguous: pass its id)`);
      const orgId = o[0].id as string;
      // the Free plan's compute limit is 0 (hard), so compute offers are blocked for it; give this organization an org-scoped dev allowance.
      // The compute meter counts vCPU-hours a month (one running vCPU is about 730), so the limit must be in those units.
      const ALLOWANCE_VCPU_HOURS = 100_000;
      const enough =
        ((
          await c.query(
            `SELECT 1 FROM billing.effective_limits($1) WHERE meter_group = 'compute' AND source = 'override' AND limit_value >= $2`,
            [orgId, ALLOWANCE_VCPU_HOURS],
          )
        ).rowCount ?? 0) > 0;
      if (!enough) {
        await c.query(
          `INSERT INTO billing.entitlements (id, scope, source, kind, org_id, meter_group, limit_value, allowance, mode, enabled, note, created_by)
           VALUES (gen_random_uuid(), 'org_override', 'override', 'meter_limit', $1, 'compute', $2, $2, 'hard', true,
                   'dev seed: sandbox compute allowance in vCPU-hours (DRAFT-NOT-APPROVED, HG-02-01)', $3)`,
          [orgId, ALLOWANCE_VCPU_HOURS, creator],
        );
        out.allowance.push(`${org}: compute limit ${ALLOWANCE_VCPU_HOURS} vCPU-hours a month`);
      }
      const countries = [...new Set(LINES.flatMap((l) => l.regions.map((r) => r[1])))];
      const cur = (
        await c.query(
          `SELECT version, mode, allowed FROM compliance.residency_policies WHERE org_id = $1 ORDER BY version DESC LIMIT 1`,
          [orgId],
        )
      ).rows[0] as
        | {
            version: number;
            mode: string;
            allowed: { allowedCountriesByClass?: Record<string, string[]> };
          }
        | undefined;
      const have = cur?.allowed?.allowedCountriesByClass?.['customer-content'] ?? [];
      if (cur?.mode !== 'allow_listed' || countries.some((k) => !have.includes(k))) {
        await c.query(
          `INSERT INTO compliance.residency_policies (id, org_id, version, mode, allowed, exceptions, change_note, created_by)
           VALUES (gen_random_uuid(), $1, $2, 'allow_listed', $3::jsonb, '{}'::uuid[], 'dev seed: allow the sandbox regions', $4)`,
          [
            orgId,
            (cur?.version ?? 0) + 1,
            JSON.stringify({
              allowedCountriesByClass: {
                ...(cur?.allowed?.allowedCountriesByClass ?? {}),
                'customer-content': [...new Set([...have, ...countries])],
              },
            }),
            creator,
          ],
        );
        out.residency.push(`${org}: customer content allowed in ${countries.join(', ')}`);
      }
    }
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
