import { uuidv7 } from '@nuzm/platform';
import {
  INDEX_LIMITS,
  buildSearchDocuments,
  type IndexComponent,
  type SearchDoc,
} from '@nuzm/domain';
import type { StageDeps, StageJob } from './components-stage';

/**
 * Search indexing (S-K5): builds the bounded search documents of a version from what the earlier stages already proved (manifest, components, Design DNA) plus the README
 * and documentation sections of the package, and writes them in ONE transaction (a stopped or failed stage writes nothing). Nothing is parsed or executed: markdown is split
 * by heading with a linear, capped reader, and only text files that already passed the scans and were stored are read. Retrieval (the admin API) never reads source again.
 */
const MD_NOISE =
  /(?:^|\/)(?:node_modules|vendor|vendors|third_party|dist|build|out|coverage|\.next|\.dart_tool|__tests__|__mocks__)\/|(?:^|\/)(?:license|licence|changelog|code_of_conduct|contributing|security)[^/]*$/i;
const MD_WANTED = /(?:^|\/)(?:readme[^/]*|(?:docs?|documentation)\/[^/]+)\.(?:md|markdown|mdx)$/i;
const MD_MAX_BYTES = 64 * 1024;

interface FileRow {
  path: string;
  bytes: string;
  language: string | null;
  object_key: string | null;
}

export async function indexStage(d: StageDeps, job: StageJob): Promise<void> {
  const info = await d.db.withKnowledgeWorker(async (c) => {
    const v = (
      await c.query(
        `SELECT r.name FROM knowledge.resource_versions v JOIN knowledge.resources r ON r.id = v.resource_id WHERE v.id = $1`,
        [job.versionId],
      )
    ).rows[0] as { name: string } | undefined;
    const manifest = (
      await c.query(
        `SELECT manifest FROM knowledge.resource_manifests WHERE version_id = $1 ORDER BY schema_version DESC LIMIT 1`,
        [job.versionId],
      )
    ).rows[0] as { manifest: Record<string, unknown> } | undefined;
    const comps = (
      await c.query(
        `SELECT name, kind, framework, path, props, dependencies FROM knowledge.resource_components WHERE version_id = $1 ORDER BY path, name LIMIT 5000`,
        [job.versionId],
      )
    ).rows as {
      name: string;
      kind: string;
      framework: string | null;
      path: string;
      props: { name: string }[];
      dependencies: string[];
    }[];
    const dna = (
      await c.query(
        `SELECT result FROM knowledge.analysis_results WHERE version_id = $1 AND analyzer = 'design-dna' ORDER BY created_at DESC LIMIT 1`,
        [job.versionId],
      )
    ).rows[0] as { result: Record<string, unknown> } | undefined;
    const files = (
      await c.query(
        `SELECT path, bytes::text AS bytes, language, object_key FROM knowledge.resource_files WHERE version_id = $1 AND language = 'markdown' AND object_key IS NOT NULL ORDER BY path`,
        [job.versionId],
      )
    ).rows as FileRow[];
    return {
      name: v?.name ?? null,
      manifest: manifest?.manifest ?? null,
      comps,
      dna: dna?.result ?? null,
      files,
    };
  });
  if (info.name === null) throw d.stop('lease_lost');

  // README first, then documentation by depth and name: the most descriptive text is indexed before the cap
  const mdFiles = info.files
    .filter(
      (f) => MD_WANTED.test(f.path) && !MD_NOISE.test(f.path) && Number(f.bytes) <= MD_MAX_BYTES,
    )
    .sort(
      (a, b) =>
        Number(/readme/i.test(b.path)) - Number(/readme/i.test(a.path)) ||
        a.path.split('/').length - b.path.split('/').length ||
        (a.path < b.path ? -1 : 1),
    )
    .slice(0, INDEX_LIMITS.maxMarkdownFiles);
  await d.log(
    job,
    'info',
    'index.begin',
    `search indexing started over ${info.comps.length} components and ${mdFiles.length} documentation files; nothing from the package is executed`,
    { components: info.comps.length, documentation: mdFiles.length },
  );
  const docs: SearchDoc[] = await d.guarded(job, async (stopped) => {
    const markdown: { path: string; text: string }[] = [];
    for (const f of mdFiles) {
      const s = stopped();
      if (s) throw d.stop(s);
      markdown.push({ path: f.path, text: (await d.store.read(f.object_key!)).toString('utf8') });
    }
    return buildSearchDocuments({
      resource: { name: info.name! },
      manifest: info.manifest,
      components: info.comps as IndexComponent[],
      dna: info.dna,
      markdown,
    });
  });
  const byKind: Record<string, number> = {};
  for (const x of docs) byKind[x.docKind] = (byKind[x.docKind] ?? 0) + 1;
  const summary = { documents: docs.length, byKind, documentation: mdFiles.length };

  await d.db.withKnowledgeWorker(async (c) => {
    for (let i = 0; i < docs.length; i += 100) {
      const part = docs.slice(i, i + 100);
      await c.query(
        `INSERT INTO knowledge.resource_search_documents (id, version_id, org_id, doc_kind, ref, title, body, content_hash)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) ON CONFLICT DO NOTHING`,
        [
          part.map(() => uuidv7()),
          part.map(() => job.versionId),
          part.map(() => null),
          part.map((x) => x.docKind),
          part.map((x) => x.ref),
          part.map((x) => x.title),
          part.map((x) => x.body),
          part.map((x) => x.contentHash),
        ],
      );
    }
    const upd = await c.query(
      `UPDATE knowledge.resource_versions SET ingest_summary = coalesce(ingest_summary, '{}'::jsonb) || $2::jsonb WHERE id = $1 AND state = 'ANALYZING'`,
      [job.versionId, JSON.stringify({ index: summary })],
    );
    if (upd.rowCount !== 1) throw d.stop('lease_lost');
    await d.finish(c, job, summary);
    await d.setVersion(c, job.versionId, ['ANALYZING'], 'AWAITING_REVIEW', null);
    await d.writeLog(
      c,
      job.id,
      job.versionId,
      'info',
      'INDEX',
      'index.done',
      'search indexing finished; the package awaits review',
      summary,
    );
  });
}
