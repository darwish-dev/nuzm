import { createHash } from 'node:crypto';
import { uuidv7, type Db } from '@nuzm/platform';
import type { KnowledgeObjectStore } from '@nuzm/adapter-knowledge-store';
import {
  COMPONENT_ANALYZER_VERSION,
  COMPONENT_LIMITS as L,
  aliasesOf,
  assemble,
  buildManifestV2,
  emptyFacts,
  parseJsonc,
  type AssembleFile,
  type AssembleProject,
  type FileFacts,
} from '@nuzm/domain';
import { DEFAULT_SANDBOX_LIMITS } from './ast/sandbox-protocol';
import { limitsMessage, runLanes } from './ast/parse-lanes';
import { ThreadParserSandbox, type ParseSandbox, type SandboxOptions } from './ast/parser-sandbox';

type Tx = Parameters<Parameters<Db['withKnowledgeWorker']>[0]>[0];
export interface StageJob {
  id: string;
  versionId: string;
}
export interface StageDeps {
  db: Db;
  store: KnowledgeObjectStore;
  guarded<T>(
    job: StageJob,
    fn: (stopped: () => 'cancelled' | 'lease_lost' | null) => Promise<T>,
  ): Promise<T>;
  log(
    job: StageJob,
    level: 'info' | 'warn' | 'error',
    code: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  finish(c: Tx, job: StageJob, result: unknown): Promise<void>;
  setVersion(
    c: Tx,
    versionId: string,
    from: string[],
    to: string,
    reason: string | null,
  ): Promise<number>;
  writeLog(
    c: Tx,
    jobId: string,
    versionId: string,
    level: string,
    stage: string,
    code: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  stop(why: 'cancelled' | 'lease_lost'): Error;
  /** Parser sandbox: injected by tests; by default a pool of isolated threads is created for the stage and closed at its end. */
  parser?: ParseSandbox;
  parserOptions?: SandboxOptions;
  /** Wall-clock budget of the whole parsing phase and the number of sandbox failures tolerated before the remaining files are skipped (defaults 10 min / 25). */
  parserBudgetMs?: number;
  parserMaxFailures?: number;
  /** The DESIGN stage (S-K4) follows: COMPONENTS queues it in the same transaction instead of moving the version to review. */
  design?: boolean;
}
const TS_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const SKIP =
  /(?:\.d\.ts$|\.min\.[cm]?js$|\.(?:test|spec|stories|story)\.[cm]?[jt]sx?$|\.(?:g|freezed|gr|mocks|config)\.dart$|(?:^|\/)(?:__tests__|__mocks__|dist|build|out|coverage|\.next|\.dart_tool|generated|vendor|public|storybook-static)\/|^(?:test|integration_test)\/|\/(?:test|integration_test)\/)/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
interface ManifestProject {
  root: string;
  name: string | null;
  kind: string;
  ecosystems?: string[];
  entryPoints?: { path: string }[];
  build?: { flutter?: { platforms?: string[] } };
}

/**
 * Component and architecture analysis (S-K2c): parse-only, per-file facts cached by content hash across versions of the same resource, assembled into components,
 * relationships and an architecture summary, written together with the schema-2 manifest in ONE transaction (so a stopped or failed stage writes nothing).
 */
export async function analyzeComponentsStage(d: StageDeps, job: StageJob): Promise<void> {
  const info = await d.db.withKnowledgeWorker(async (c) => {
    const v = (
      await c.query(`SELECT resource_id FROM knowledge.resource_versions WHERE id = $1`, [
        job.versionId,
      ])
    ).rows[0] as { resource_id: string } | undefined;
    const files = (
      await c.query(
        `SELECT path, sha256, bytes::text AS bytes, language, object_key FROM knowledge.resource_files WHERE version_id = $1 ORDER BY path`,
        [job.versionId],
      )
    ).rows as {
      path: string;
      sha256: string;
      bytes: string;
      language: string | null;
      object_key: string | null;
    }[];
    const m = (
      await c.query(
        `SELECT manifest FROM knowledge.resource_manifests WHERE version_id = $1 AND schema_version = '1'`,
        [job.versionId],
      )
    ).rows[0] as { manifest: Record<string, unknown> } | undefined;
    return { resourceId: v?.resource_id ?? null, files, v1: m?.manifest ?? null };
  });
  if (!info.resourceId) throw d.stop('lease_lost');
  const v1 = info.v1 ?? {};
  const mprojects = (Array.isArray(v1.projects) ? (v1.projects as ManifestProject[]) : []).filter(
    (p) => p && typeof p.root === 'string',
  );
  const roots = mprojects.length ? mprojects.map((p) => p.root) : ['.'];
  const ownerOf = (path: string): string => {
    let best = '.';
    for (const r of roots)
      if (r === '.' || path.startsWith(`${r}/`))
        if (best === '.' || r.length > best.length) best = r;
    return best;
  };
  const allExamples = mprojects.length > 0 && mprojects.every((p) => p.kind === 'example');
  const exampleRoots = new Set(
    allExamples ? [] : mprojects.filter((p) => p.kind === 'example').map((p) => p.root),
  );
  const cands = info.files
    .filter(
      (f) =>
        f.object_key &&
        !SKIP.test(f.path) &&
        (f.language === 'dart' ||
          (TS_EXT.test(f.path) && (f.language === 'typescript' || f.language === 'javascript'))),
    )
    .filter((f) => !exampleRoots.has(ownerOf(f.path)))
    .slice(0, L.maxFiles);
  const truncated =
    info.files.filter(
      (f) => f.object_key && !SKIP.test(f.path) && (f.language === 'dart' || TS_EXT.test(f.path)),
    ).length > cands.length;
  const variant = (p: string) =>
    p.endsWith('.dart') ? 'dart' : /\.(?:tsx|jsx)$/.test(p) ? 'jsx' : 'ts';
  const hashOf = (f: { sha256: string; path: string }) => sha(`${f.sha256}|${variant(f.path)}`);

  // cache: results of earlier versions of the same resource (and of this one, after a retry)
  const cached = new Map<string, FileFacts>();
  const wanted = [...new Set(cands.map(hashOf))];
  if (wanted.length) {
    const rows = await d.db.withKnowledgeWorker(
      async (c) =>
        (
          await c.query(
            `SELECT DISTINCT ON (ar.content_hash) ar.content_hash, ar.result FROM knowledge.analysis_results ar JOIN knowledge.resource_versions v ON v.id = ar.version_id WHERE v.resource_id = $1 AND ar.analyzer = 'ast-file' AND ar.analyzer_version = $2 AND ar.content_hash = ANY($3::text[])`,
            [info.resourceId, COMPONENT_ANALYZER_VERSION, wanted],
          )
        ).rows as { content_hash: string; result: FileFacts }[],
    );
    for (const r of rows) cached.set(r.content_hash, r.result);
  }
  const factsByHash = new Map<string, FileFacts>(cached);
  const fresh: { hash: string; facts: FileFacts }[] = [];
  const tsconfigs = new Map<string, Record<string, unknown> | null>();
  await d.log(
    job,
    'info',
    'components.begin',
    `component analysis started over ${cands.length} source files (${cached.size} results reused); nothing from the package is executed`,
    { files: cands.length, reused: cached.size },
  );
  const parseFiles = async (stopped: () => 'cancelled' | 'lease_lost' | null): Promise<void> => {
    const todo: typeof cands = [];
    const seen = new Set<string>();
    for (const f of cands) {
      const h = hashOf(f);
      if (factsByHash.has(h) || seen.has(h)) continue;
      seen.add(h);
      todo.push(f);
    }
    if (!todo.length) return;
    const rep = await runLanes({
      sandbox,
      files: todo.map((f) => ({
        hash: hashOf(f),
        path: f.path,
        kind: f.path.endsWith('.dart') ? ('dart' as const) : ('ts' as const),
        objectKey: f.object_key!,
        bytes: Number(f.bytes),
      })),
      read: (k) => d.store.read(k),
      stopped,
      stop: (why) => d.stop(why),
      budgetMs: d.parserBudgetMs ?? 600_000,
      maxFailures: d.parserMaxFailures ?? 25,
      maxFileBytes: d.parserOptions?.maxFileBytes ?? DEFAULT_SANDBOX_LIMITS.maxFileBytes,
      empty: (f, skipped) => emptyFacts(f.kind, skipped),
    });
    // deterministic order, whatever the threads' timing
    for (const f of todo) {
      const h = hashOf(f);
      const r = rep.results.get(h)!;
      factsByHash.set(h, r.facts);
      if (r.cache) fresh.push({ hash: h, facts: r.facts });
    }
    const m = limitsMessage('components', rep.limited, todo.length);
    await d.log(job, m.level, m.code, m.message, {
      files: todo.length,
      limited: rep.limited,
      sandbox: sandbox.stats(),
      ms: rep.ms,
      threads: sandbox.size,
    });
  };
  const sandbox: ParseSandbox = d.parser ?? new ThreadParserSandbox(d.parserOptions);
  const ownsSandbox = !d.parser;
  const assembled = await d.guarded(job, async (stopped) => {
    try {
      await parseFiles(stopped);
    } finally {
      if (ownsSandbox) await sandbox.close();
    }
    // tsconfig aliases per project
    for (const r of roots) {
      const p = r === '.' ? 'tsconfig.json' : `${r}/tsconfig.json`;
      const row = info.files.find((x) => x.path === p && x.object_key);
      tsconfigs.set(
        r,
        row ? parseJsonc((await d.store.read(row.object_key!)).toString('utf8')) : null,
      );
    }
    const aprojects: AssembleProject[] = roots.map((r) => {
      const mp = mprojects.find((p) => p.root === r);
      return {
        root: r,
        name: mp?.name ?? null,
        kind: mp?.kind ?? 'application',
        aliases: aliasesOf(r, tsconfigs.get(r) ?? null),
        dartPackage: mp?.ecosystems?.includes('pub') ? (mp.name ?? null) : null,
        entryPoints: (mp?.entryPoints ?? []).map((e) => e.path),
        platforms: mp?.build?.flutter?.platforms ?? [],
      };
    });
    const afiles: AssembleFile[] = cands.map((f) => ({
      path: f.path,
      project: ownerOf(f.path),
      facts: factsByHash.get(hashOf(f))!,
    }));
    const routes = (
      Array.isArray(v1.routes)
        ? (v1.routes as { kind: string; path: string; file: string; project: string }[])
        : []
    ).filter((r) => r && typeof r.file === 'string');
    return assemble(afiles, aprojects, routes);
  });
  if (truncated) assembled.architecture.stats.truncated.push('files');
  const manifest = buildManifestV2(v1, assembled);
  const fileHashes = cands.map((f) => `${f.path}:${hashOf(f)}`);
  const aggHash = sha(JSON.stringify([COMPONENT_ANALYZER_VERSION, fileHashes]));
  const summary = {
    components: assembled.components.length,
    relationships: assembled.relationships.length,
    filesAnalysed: cands.length,
    filesReused: cached.size,
    cycles: assembled.architecture.cycles.length,
    truncated: assembled.architecture.stats.truncated,
    skipped: assembled.architecture.stats.skipped,
  };

  await d.db.withKnowledgeWorker(async (c) => {
    // per-file facts (the incremental cache): only the files that were really parsed in this run
    for (const x of fresh) {
      const j = JSON.stringify(x.facts);
      if (j.length > 190_000) continue;
      await c.query(
        `INSERT INTO knowledge.analysis_results (id, version_id, org_id, analyzer, analyzer_version, content_hash, result, evidence) VALUES ($1,$2,NULL,'ast-file',$3,$4,$5::jsonb,'[]'::jsonb) ON CONFLICT DO NOTHING`,
        [uuidv7(), job.versionId, COMPONENT_ANALYZER_VERSION, x.hash, j],
      );
    }
    for (let i = 0; i < assembled.components.length; i += 150) {
      const part = assembled.components.slice(i, i + 150).filter((r) => r.path.length <= 500);
      if (!part.length) continue;
      const args: unknown[] = [];
      const values = part.map((r) => {
        const o = args.length;
        args.push(
          uuidv7(),
          job.versionId,
          r.name,
          r.kind,
          r.framework,
          r.path,
          JSON.stringify(r.props),
          r.dependencies,
          r.styleDeps,
          r.assets,
          r.platforms,
        );
        return `($${o + 1},$${o + 2},NULL,$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7}::jsonb,$${o + 8}::text[],$${o + 9}::text[],$${o + 10}::text[],$${o + 11}::text[],false)`;
      });
      await c.query(
        `INSERT INTO knowledge.resource_components (id, version_id, org_id, name, kind, framework, path, props, dependencies, style_deps, assets, platforms, reuse_allowed) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
        args,
      );
    }
    const rels = assembled.relationships.filter(
      (r) => r.fromRef.length <= 500 && r.toRef.length <= 500,
    );
    for (let i = 0; i < rels.length; i += 1000) {
      const part = rels.slice(i, i + 1000);
      await c.query(
        `INSERT INTO knowledge.resource_relationships (id, version_id, org_id, from_kind, from_ref, to_kind, to_ref, relation, evidence)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::jsonb[]) ON CONFLICT DO NOTHING`,
        [
          part.map(() => uuidv7()),
          part.map(() => job.versionId),
          part.map(() => null),
          part.map((r) => r.fromKind),
          part.map((r) => r.fromRef),
          part.map((r) => r.toKind),
          part.map((r) => r.toRef),
          part.map((r) => r.relation),
          part.map((r) => JSON.stringify(r.evidence)),
        ],
      );
    }
    await c.query(
      `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES ($1,$2,NULL,'2',$3::jsonb) ON CONFLICT (version_id, schema_version) DO NOTHING`,
      [uuidv7(), job.versionId, JSON.stringify(manifest)],
    );
    await c.query(
      `INSERT INTO knowledge.analysis_results (id, version_id, org_id, analyzer, analyzer_version, content_hash, result, evidence) VALUES ($1,$2,NULL,'ast-components',$3,$4,$5::jsonb,'[]'::jsonb) ON CONFLICT DO NOTHING`,
      [uuidv7(), job.versionId, COMPONENT_ANALYZER_VERSION, aggHash, JSON.stringify(summary)],
    );
    const upd = await c.query(
      `UPDATE knowledge.resource_versions SET ingest_summary = coalesce(ingest_summary, '{}'::jsonb) || $2::jsonb WHERE id = $1 AND state = 'ANALYZING'`,
      [job.versionId, JSON.stringify({ components: summary })],
    );
    if (upd.rowCount !== 1) throw d.stop('lease_lost');
    await d.finish(c, job, summary);
    if (d.design)
      await c.query(
        `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind) VALUES ($1,$2,NULL,'DESIGN') ON CONFLICT DO NOTHING`,
        [uuidv7(), job.versionId],
      );
    else await d.setVersion(c, job.versionId, ['ANALYZING'], 'AWAITING_REVIEW', null);
    await d.writeLog(
      c,
      job.id,
      job.versionId,
      'info',
      'COMPONENTS',
      'components.done',
      d.design
        ? 'component analysis finished; design analysis follows'
        : 'component analysis finished; the package awaits review',
      summary,
    );
  });
}
