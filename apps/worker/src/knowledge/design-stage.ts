import { createHash } from 'node:crypto';
import { uuidv7 } from '@nuzm/platform';
import {
  DESIGN_ANALYZER_VERSION,
  DESIGN_LIMITS as L,
  assembleDesign,
  buildManifestV3,
  emptyDesignFacts,
  fitDna,
  type DesignAssembleFile,
  type DesignAssembleProject,
  type DesignComponentRef,
  type DesignFileFacts,
  type DesignFileKind,
} from '@nuzm/domain';
import { limitsMessage, runLanes } from './ast/parse-lanes';
import { ThreadParserSandbox, type ParseSandbox } from './ast/parser-sandbox';
import { DEFAULT_SANDBOX_LIMITS } from './ast/sandbox-protocol';
import type { StageDeps, StageJob } from './components-stage';

/**
 * Design analysis (S-K4): static reading of stylesheets, design-token JSON, JavaScript/TypeScript theme configuration and Flutter theme code, in the parser sandbox. Per-file
 * facts are cached by content hash across versions of the same resource; everything is assembled into theme tokens, theme variants and one Design DNA document per project, and
 * written together with the schema-3 manifest in ONE transaction (a stopped or failed stage writes nothing). Nothing from the package is executed: configuration files are
 * parsed as syntax trees, never required or evaluated.
 */
const NOISE =
  /(?:^|\/)(?:node_modules|bower_components|vendor|vendors|third_party|dist|build|out|coverage|\.next|\.dart_tool|storybook-static|__tests__|__mocks__)\/|\.min\.(?:css|js)$|\.(?:test|spec|stories|story)\.[cm]?[jt]sx?$|\.d\.ts$|\.(?:g|freezed|gr)\.dart$/i;
const TOKENS_JSON =
  /(?:^|\/)(?:theme|tokens?|design-?tokens?|style-dictionary|colou?rs?|palette)[^/]*\.json$|\.tokens\.json$|(?:^|\/)(?:tokens|design-tokens|theme)\/[^/]+\.json$/i;
const THEME_CONFIG =
  /(?:^|\/)(?:tailwind\.config|theme|themes|tokens|design-?tokens|colou?rs?|palette|chakra|mui-?theme)[^/]*\.[cm]?[jt]s$|(?:^|\/)(?:theme|themes|tokens|styles)\/[^/]+\.[cm]?[jt]s$/i;
const DART_THEME =
  /(?:^|\/)lib\/(?:.*\/)?[^/]*(?:theme|colou?rs?|palette|styles?|tokens?|design|constants?)[^/]*\.dart$|(?:^|\/)lib\/(?:.*\/)?(?:theme|themes)\/[^/]+\.dart$/i;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function designKindOf(path: string, language: string | null): DesignFileKind | null {
  if (NOISE.test(path)) return null;
  if (language === 'css' || language === 'scss' || language === 'less') return 'css';
  if (language === 'json' && TOKENS_JSON.test(path)) return 'tokens-json';
  if ((language === 'typescript' || language === 'javascript') && THEME_CONFIG.test(path))
    return 'theme-config';
  if (language === 'dart' && DART_THEME.test(path)) return 'dart-theme';
  return null;
}

interface FileRow {
  path: string;
  sha256: string;
  bytes: string;
  language: string | null;
  object_key: string | null;
}
interface ManifestProject {
  root: string;
  name: string | null;
  kind: string;
  detections?: { id?: string; confidence?: number }[];
}

export async function analyzeDesignStage(d: StageDeps, job: StageJob): Promise<void> {
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
    ).rows as FileRow[];
    const m = (
      await c.query(
        `SELECT manifest FROM knowledge.resource_manifests WHERE version_id = $1 AND schema_version = '2'`,
        [job.versionId],
      )
    ).rows[0] as { manifest: Record<string, unknown> } | undefined;
    const comps = (
      await c.query(
        `SELECT name, kind, framework, path FROM knowledge.resource_components WHERE version_id = $1 ORDER BY path, name LIMIT 5000`,
        [job.versionId],
      )
    ).rows as DesignComponentRef[];
    return { resourceId: v?.resource_id ?? null, files, v2: m?.manifest ?? null, comps };
  });
  if (!info.resourceId) throw d.stop('lease_lost');
  const v2 = info.v2 ?? {};
  const mprojects = (Array.isArray(v2.projects) ? (v2.projects as ManifestProject[]) : []).filter(
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

  const eligible = info.files
    .filter((f) => f.object_key)
    .map((f) => ({ f, kind: designKindOf(f.path, f.language) }))
    .filter((x): x is { f: FileRow; kind: DesignFileKind } => x.kind !== null)
    .filter((x) => !exampleRoots.has(ownerOf(x.f.path)));
  const cands = eligible.slice(0, L.maxFiles);
  const truncatedFiles = eligible.length > cands.length;
  const hashOf = (x: { f: FileRow; kind: DesignFileKind }) => sha(`${x.f.sha256}|${x.kind}`);

  // cache: results of earlier versions of the same resource (and of this one, after a retry)
  const cached = new Map<string, DesignFileFacts>();
  const wanted = [...new Set(cands.map(hashOf))];
  if (wanted.length) {
    const rows = await d.db.withKnowledgeWorker(
      async (c) =>
        (
          await c.query(
            `SELECT DISTINCT ON (ar.content_hash) ar.content_hash, ar.result FROM knowledge.analysis_results ar JOIN knowledge.resource_versions v ON v.id = ar.version_id WHERE v.resource_id = $1 AND ar.analyzer = 'design-file' AND ar.analyzer_version = $2 AND ar.content_hash = ANY($3::text[])`,
            [info.resourceId, DESIGN_ANALYZER_VERSION, wanted],
          )
        ).rows as { content_hash: string; result: DesignFileFacts }[],
    );
    for (const r of rows) cached.set(r.content_hash, r.result);
  }
  const factsByHash = new Map<string, DesignFileFacts>(cached);
  const fresh: { hash: string; facts: DesignFileFacts }[] = [];
  await d.log(
    job,
    'info',
    'design.begin',
    `design analysis started over ${cands.length} style, token and theme files (${cached.size} results reused); nothing from the package is executed`,
    { files: cands.length, reused: cached.size },
  );

  const sandbox: ParseSandbox = d.parser ?? new ThreadParserSandbox(d.parserOptions);
  const ownsSandbox = !d.parser;
  const result = await d.guarded(job, async (stopped) => {
    try {
      const todo: typeof cands = [];
      const seen = new Set<string>();
      for (const x of cands) {
        const h = hashOf(x);
        if (factsByHash.has(h) || seen.has(h)) continue;
        seen.add(h);
        todo.push(x);
      }
      if (todo.length) {
        const rep = await runLanes({
          sandbox,
          files: todo.map((x) => ({
            hash: hashOf(x),
            path: x.f.path,
            kind: x.kind,
            objectKey: x.f.object_key!,
            bytes: Number(x.f.bytes),
          })),
          read: (k) => d.store.read(k),
          stopped,
          stop: (why) => d.stop(why),
          budgetMs: d.parserBudgetMs ?? 600_000,
          maxFailures: d.parserMaxFailures ?? 25,
          maxFileBytes: d.parserOptions?.maxFileBytes ?? DEFAULT_SANDBOX_LIMITS.maxFileBytes,
          empty: (f, skipped) => emptyDesignFacts(f.kind, skipped),
        });
        for (const x of todo) {
          const h = hashOf(x);
          const r = rep.results.get(h)!;
          factsByHash.set(h, r.facts);
          if (r.cache) fresh.push({ hash: h, facts: r.facts });
        }
        const m = limitsMessage('design', rep.limited, todo.length);
        await d.log(job, m.level, m.code, m.message, {
          files: todo.length,
          limited: rep.limited,
          sandbox: sandbox.stats(),
          ms: rep.ms,
          threads: sandbox.size,
        });
      }
    } finally {
      if (ownsSandbox) await sandbox.close();
    }
    const aprojects: DesignAssembleProject[] = roots.map((r) => {
      const mp = mprojects.find((p) => p.root === r);
      return {
        root: r,
        name: mp?.name ?? null,
        kind: mp?.kind ?? 'application',
        frameworks: (mp?.detections ?? [])
          .filter((x) => typeof x.id === 'string' && (x.confidence ?? 0) >= 0.5)
          .map((x) => x.id!)
          .slice(0, 20),
      };
    });
    const afiles: DesignAssembleFile[] = cands.map((x) => ({
      path: x.f.path,
      project: ownerOf(x.f.path),
      facts: factsByHash.get(hashOf(x))!,
    }));
    return assembleDesign(
      afiles,
      info.comps.filter((c) => !exampleRoots.has(ownerOf(c.path))),
      aprojects,
    );
  });
  if (truncatedFiles) result.dna.stats.truncated.push('files');
  const dna = fitDna(result.dna);
  const manifest = buildManifestV3(v2, dna);
  const aggHash = sha(
    JSON.stringify([DESIGN_ANALYZER_VERSION, cands.map((x) => `${x.f.path}:${hashOf(x)}`)]),
  );
  const summary = {
    files: dna.stats.files,
    tokens: dna.stats.tokens,
    variants: dna.stats.variants,
    projects: dna.projects.length,
    filesReused: cached.size,
    skipped: dna.stats.skipped,
    truncated: dna.stats.truncated,
  };

  await d.db.withKnowledgeWorker(async (c) => {
    for (const x of fresh) {
      const j = JSON.stringify(x.facts);
      if (j.length > 150_000) continue;
      await c.query(
        `INSERT INTO knowledge.analysis_results (id, version_id, org_id, analyzer, analyzer_version, content_hash, result, evidence) VALUES ($1,$2,NULL,'design-file',$3,$4,$5::jsonb,'[]'::jsonb) ON CONFLICT DO NOTHING`,
        [uuidv7(), job.versionId, DESIGN_ANALYZER_VERSION, x.hash, j],
      );
    }
    const toks = result.tokens.filter((t) => t.sourcePath.length <= 500);
    for (let i = 0; i < toks.length; i += 1000) {
      const part = toks.slice(i, i + 1000);
      await c.query(
        `INSERT INTO knowledge.theme_tokens (id, version_id, org_id, category, name, value, source_path, mode, line, origin, dynamic, resolved_value)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::int[], $10::text[], $11::boolean[], $12::text[]) ON CONFLICT DO NOTHING`,
        [
          part.map(() => uuidv7()),
          part.map(() => job.versionId),
          part.map(() => null),
          part.map((t) => t.category),
          part.map((t) => t.name),
          part.map((t) => (t.dynamic ? null : t.value)),
          part.map((t) => t.sourcePath),
          part.map((t) => t.mode),
          part.map((t) => t.line),
          part.map((t) => t.origin),
          part.map((t) => t.dynamic),
          part.map((t) => t.resolvedValue),
        ],
      );
    }
    for (let i = 0; i < result.variants.length; i += 200) {
      const part = result.variants.slice(i, i + 200);
      await c.query(
        `INSERT INTO knowledge.theme_variants (id, version_id, org_id, kind, name, descriptor)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::jsonb[]) ON CONFLICT DO NOTHING`,
        [
          part.map(() => uuidv7()),
          part.map(() => job.versionId),
          part.map(() => null),
          part.map((v) => v.kind),
          part.map((v) => v.name.slice(0, 120)),
          part.map((v) => JSON.stringify(v.descriptor)),
        ],
      );
    }
    await c.query(
      `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES ($1,$2,NULL,'3',$3::jsonb) ON CONFLICT (version_id, schema_version) DO NOTHING`,
      [uuidv7(), job.versionId, JSON.stringify(manifest)],
    );
    await c.query(
      `INSERT INTO knowledge.analysis_results (id, version_id, org_id, analyzer, analyzer_version, content_hash, result, evidence) VALUES ($1,$2,NULL,'design-dna',$3,$4,$5::jsonb,'[]'::jsonb) ON CONFLICT DO NOTHING`,
      [uuidv7(), job.versionId, DESIGN_ANALYZER_VERSION, aggHash, JSON.stringify(dna)],
    );
    const upd = await c.query(
      `UPDATE knowledge.resource_versions SET ingest_summary = coalesce(ingest_summary, '{}'::jsonb) || $2::jsonb WHERE id = $1 AND state = 'ANALYZING'`,
      [job.versionId, JSON.stringify({ design: summary })],
    );
    if (upd.rowCount !== 1) throw d.stop('lease_lost');
    await d.finish(c, job, summary);
    await d.setVersion(c, job.versionId, ['ANALYZING'], 'AWAITING_REVIEW', null);
    await d.writeLog(
      c,
      job.id,
      job.versionId,
      'info',
      'DESIGN',
      'design.done',
      'design analysis finished; the package awaits review',
      summary,
    );
  });
}
