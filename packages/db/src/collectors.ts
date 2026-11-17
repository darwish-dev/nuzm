import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';
import { checkDatabase } from './checks';
import { checkClassification } from './classification';
import { COLLECTOR_NAMES } from './controls';
import { discoverMigrations, type Manifest } from './migrations';
import { adapterKindsFromDocs, checkRopaCoverage } from './ropa-coverage';
import { checkResidencyHooks } from './residency-hooks';

/** What a collector sees. `root` is the repository root. */
export interface CollectorCtx {
  url: string;
  manifest: Manifest;
  root: string;
  migrationsDir: string;
}
export interface Collected {
  /** Deterministic: no timestamps, no run ids. The same input state produces the same result and so the same hash. */
  result: unknown;
  ok: boolean;
  summary: Record<string, string | number | boolean>;
}
export interface Collector {
  name: (typeof COLLECTOR_NAMES)[number];
  /** Bump when what the collector measures changes: it is part of the hash. */
  version: string;
  run(ctx: CollectorCtx): Promise<Collected>;
}

/** JSON with sorted keys, so equal values always serialize equally. */
export function canonical(v: unknown): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(norm)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.entries(x as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, val]) => [k, norm(val)]),
          )
        : x;
  return JSON.stringify(norm(v));
}
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const evidenceHash = (collector: string, version: string, result: unknown) =>
  sha256(canonical({ collector, version, result }));

const violationsResult = (v: { kind: string; object: string; detail: string }[]): Collected => ({
  ok: v.length === 0,
  result: { violations: v.map((x) => ({ kind: x.kind, object: x.object, detail: x.detail })) },
  summary: { violations: v.length },
});

export const COLLECTORS: Collector[] = [
  {
    name: 'db.ownership-rls-check',
    version: '1',
    run: async (c) => violationsResult(await checkDatabase(c.url, c.manifest)),
  },
  {
    name: 'db.classification-coverage',
    version: '1',
    run: async (c) => {
      const v = await checkClassification(c.url, c.manifest);
      const out = violationsResult(v);
      const columns = Object.values(c.manifest.classification.columns).reduce(
        (n, t) => n + Object.keys(t).length,
        0,
      );
      (out.result as Record<string, unknown>).classifiedColumns = columns;
      out.summary.classifiedColumns = columns;
      return out;
    },
  },
  {
    name: 'audit.chain-verification',
    version: '1',
    run: async (c) => {
      const cl = new Client({ connectionString: c.url });
      await cl.connect();
      try {
        await cl.query('BEGIN');
        await cl.query(`SELECT set_config('app.platform_scope', 'admin', true)`);
        const chains = (
          await cl.query(`SELECT chain_key FROM audit.chain_heads ORDER BY chain_key`)
        ).rows.map((r) => r.chain_key as string);
        let checked = 0;
        const broken: { chain: string; firstBadSeq: string; reason: string }[] = [];
        for (const k of chains) {
          const r = (await cl.query(`SELECT * FROM audit.verify_chain($1)`, [k])).rows[0]!;
          checked += Number(r.checked);
          if (!r.ok)
            broken.push({ chain: k, firstBadSeq: String(r.first_bad_seq), reason: r.reason });
        }
        await cl.query('ROLLBACK');
        return {
          ok: broken.length === 0,
          result: { chains: chains.length, rowsChecked: checked, broken },
          summary: { chains: chains.length, rowsChecked: checked, broken: broken.length },
        };
      } finally {
        await cl.end();
      }
    },
  },
  {
    name: 'db.migration-lint',
    version: '1',
    run: async (c) => {
      try {
        const files = discoverMigrations(c.migrationsDir, c.manifest);
        const list = files
          .map((f) => ({
            ordinal: f.ordinal,
            schema: f.schema,
            slug: f.slug,
            checksum: f.checksum,
            reversible: f.downSql !== null,
          }))
          .sort((a, b) => a.ordinal - b.ordinal);
        return {
          ok: true,
          result: { migrations: list.length, digest: sha256(canonical(list)) },
          summary: { migrations: list.length },
        };
      } catch (e) {
        return {
          ok: false,
          result: { error: String((e as Error).message).slice(0, 1500) },
          summary: { migrations: 0 },
        };
      }
    },
  },
  {
    name: 'scan.secrets-and-lockfile',
    version: '1',
    run: async (c) => {
      const r = spawnSync('pnpm', ['--silent', 'scan:secrets'], { cwd: c.root, encoding: 'utf8' });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join('\n');
      const lock = sha256(readFileSync(join(c.root, 'pnpm-lock.yaml')));
      // the scan prints a summary line; the number of files walked varies with build output, so only the verdict, the rules and the hits go into the evidence
      const line = /secret scan[^\n]*/i.exec(out)?.[0] ?? '';
      const hits = Number(/(\d+) hits?/.exec(line)?.[1] ?? -1);
      const rules = Number(/(\d+) rules?/.exec(line)?.[1] ?? -1);
      return {
        ok: r.status === 0,
        result: {
          exitCode: r.status,
          rules,
          hits,
          lockfileSha256: lock,
          vulnerabilityDatabaseQueried: false,
        },
        summary: { exitCode: r.status ?? -1, hits, lockfile: lock.slice(0, 12) },
      };
    },
  },
  {
    name: 'config.security-snapshot',
    version: '1',
    run: async (c) => {
      const next = (app: string) => {
        const text = readFileSync(join(c.root, 'apps', app, 'next.config.mjs'), 'utf8');
        const headers = [...text.matchAll(/key: '([^']+)', value: ('([^']*)'|[A-Za-z_]+)/g)].map(
          (m) => ({ key: m[1]!, value: m[3] ?? `(computed: ${m[2]})` }),
        );
        const cspBlock = /const csp = [\s\S]*?;\n/.exec(text)?.[0] ?? '';
        return { headers, cspSha256: sha256(cspBlock) };
      };
      const apiText = readFileSync(join(c.root, 'apps/api/src/app.setup.ts'), 'utf8');
      const api = [...apiText.matchAll(/reply\.header\('([^']+)', '([^']+)'\)/g)].map((m) => ({
        key: m[1]!,
        value: m[2]!,
      }));
      const result = {
        scope:
          'application source configuration; not a probe of a running deployment; TLS termination is outside the application',
        api,
        web: next('web'),
        admin: next('admin'),
      };
      const total = api.length + result.web.headers.length + result.admin.headers.length;
      return { ok: total > 0, result, summary: { headers: total } };
    },
  },
  {
    name: 'compliance.ropa-coverage',
    version: '1',
    run: async (c) => {
      const v = await checkRopaCoverage(
        c.url,
        c.manifest,
        join(c.root, 'docs/09-provider-adapter-interfaces.md'),
      );
      return violationsResult(v);
    },
  },
  {
    name: 'compliance.residency-hooks',
    version: '1',
    run: async (c) => {
      const v = await checkResidencyHooks(
        c.url,
        join(c.root, 'spec/compliance/residency-hooks.yaml'),
        join(c.root, 'docs/09-provider-adapter-interfaces.md'),
        c.root,
        adapterKindsFromDocs,
      );
      return violationsResult(v);
    },
  },
];

export interface CollectionReport {
  collector: string;
  ok: boolean;
  hash: string;
  summary: Record<string, string | number | boolean>;
  /** controls that received a NEW evidence row / that already had this exact evidence */
  created: string[];
  unchanged: string[];
}

/**
 * Run the collectors and record their output as AUTOMATED evidence for every control whose catalog entry lists the collector. An item is immutable and
 * unique per (control, collector, hash): re-running over identical input adds nothing (AC-M04-09). A failing collector still records its (failing) result:
 * evidence is what was observed, not what was hoped. Runs under the admin role (the runtime role cannot write automated evidence).
 */
export async function collectEvidence(
  ctx: CollectorCtx,
  only?: string[],
): Promise<CollectionReport[]> {
  const reports: CollectionReport[] = [];
  const cl = new Client({ connectionString: ctx.url });
  await cl.connect();
  try {
    const catalog = (
      await cl.query(`SELECT control_id, evidence_spec FROM compliance.control_catalog`)
    ).rows as { control_id: string; evidence_spec: { type: string; collector?: string }[] }[];
    if (catalog.length === 0)
      throw new Error('the control catalog is empty: run `pnpm compliance:sync-controls` first');
    for (const col of COLLECTORS) {
      if (only && !only.includes(col.name)) continue;
      const got = await col.run(ctx);
      const hash = evidenceHash(col.name, col.version, got.result);
      const rep: CollectionReport = {
        collector: col.name,
        ok: got.ok,
        hash,
        summary: got.summary,
        created: [],
        unchanged: [],
      };
      for (const ctl of catalog.filter((x) =>
        x.evidence_spec.some((e) => e.type === 'automated' && e.collector === col.name),
      )) {
        const ins = await cl.query(
          `INSERT INTO compliance.evidence_items (id, control_id, type, source, content_hash, collector, collector_version, summary)
           VALUES (gen_random_uuid(), $1, 'automated', 'ci', $2, $3, $4, $5::jsonb)
           ON CONFLICT (control_id, collector, content_hash) WHERE type = 'automated' DO NOTHING RETURNING id`,
          [
            ctl.control_id,
            hash,
            col.name,
            col.version,
            JSON.stringify({ ok: got.ok, ...got.summary }),
          ],
        );
        (ins.rowCount ? rep.created : rep.unchanged).push(ctl.control_id);
      }
      reports.push(rep);
    }
    return reports;
  } finally {
    await cl.end();
  }
}
