import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import { validateSiteModel, type SiteModel } from '@nuzm/domain';
import { emitUsage, usageEventId } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { renderSiteCss } from '../../../common/site-css';
import type { BuilderConfig, Row } from './model';

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
export const modelHash = (m: SiteModel) => createHash('sha256').update(canonical(m)).digest('hex');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const ASSET_MAX_BYTES = 512 * 1024;

/** Content sniffing for uploaded images: the declared mime must match the magic bytes; SVG and everything else is refused (scripts in images). */
export function sniffImage(b: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length > 12 &&
    String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...b.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export interface CommitInput {
  orgId: string;
  projectId: string;
  model: SiteModel;
  parentId: string | null;
  source: 'user' | 'ai' | 'restore' | 'template' | 'system';
  label?: string | null;
  named?: boolean;
  runId?: string | null;
  restoredFrom?: string | null;
  userId?: string | null;
  /** new uploaded asset bytes by content hash (already size/sniff checked) */
  assetData?: Record<string, Uint8Array>;
}
/**
 * Create a NEW immutable version from a model: validate, hash, render the static output, index the pages, move the project head and emit `builder.build_minutes`.
 * Runs inside the caller's transaction (the project row is locked by the caller), so a version, its files and the head move commit together or not at all.
 */
export async function commitVersion(
  c: PoolClient,
  cfg: BuilderConfig,
  i: CommitInput,
): Promise<{ versionId: string; seq: number; buildMs: number; issues: unknown[] }> {
  const issues = validateSiteModel(i.model);
  if (issues.length)
    throw new ProblemException('op_invalid', 'the site model is not valid', issues as unknown[]);
  const t0 = performance.now();
  // uploaded images: new bytes, else carried forward from an earlier version of the project (content-addressed)
  const assetBytes: Record<string, Uint8Array> = { ...(i.assetData ?? {}) };
  for (const a of i.model.assets) {
    if (a.source !== 'upload' || !a.contentHash || assetBytes[a.contentHash]) continue;
    const f = (
      await c.query(
        `SELECT content FROM builder.project_files WHERE project_id=$1 AND content_hash=$2 AND content IS NOT NULL LIMIT 1`,
        [i.projectId, a.contentHash],
      )
    ).rows[0] as Row | undefined;
    if (!f)
      throw new ProblemException('op_invalid', `the bytes of uploaded asset ${a.id} are missing`);
    assetBytes[a.contentHash] = f.content as Uint8Array;
  }
  const out = await renderSiteCss(i.model, {
    ...(i.model.seo.baseUrl ? { baseUrl: i.model.seo.baseUrl } : {}),
    formsBaseUrl: `${cfg.formsBaseUrl}/p/${i.projectId}`,
    assetBytes,
  });
  const bad = out.issues.filter((x) => x.severity === 'error');
  if (bad.length)
    throw new ProblemException(
      'validation_failed',
      'the rendered output failed validation',
      bad.slice(0, 10) as unknown[],
    );
  const buildMs = Math.max(1, Math.round(performance.now() - t0));
  const versionId = uuidv7();
  const seq = Number(
    (
      await c.query(
        `SELECT coalesce(max(seq),0)+1 AS s FROM builder.project_versions WHERE project_id=$1`,
        [i.projectId],
      )
    ).rows[0]!.s,
  );
  const org = i.orgId;
  await c.query(
    `INSERT INTO builder.project_versions (id, org_id, project_id, parent_id, seq, site_model, model_hash, label, named, source, run_id, restored_from, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      versionId,
      org,
      i.projectId,
      i.parentId,
      seq,
      JSON.stringify(i.model),
      modelHash(i.model),
      i.label ?? null,
      i.named ?? Boolean(i.label),
      i.source,
      i.runId ?? null,
      i.restoredFrom ?? null,
      i.userId ?? null,
    ],
  );
  for (const f of out.files) {
    const bytes =
      typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : Buffer.from(f.content);
    if (bytes.length > 5 * 1024 * 1024)
      throw new ProblemException('payload_too_large', `${f.path} is larger than 5 MiB`);
    await c.query(
      `INSERT INTO builder.project_files (id, org_id, project_id, version_id, path, content_hash, size, mime, content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuidv7(), org, i.projectId, versionId, f.path, sha256(bytes), bytes.length, f.mime, bytes],
    );
  }
  for (const p of out.pages) {
    const page = i.model.pages.find((x) => x.id === p.pageId)!;
    await c.query(
      `INSERT INTO builder.pages (id, org_id, project_id, version_id, page_id, locale, slug, path, title, seo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        uuidv7(),
        org,
        i.projectId,
        versionId,
        p.pageId,
        p.locale,
        page.slug,
        p.path,
        p.title,
        JSON.stringify(page.seo ?? {}),
      ],
    );
  }
  // forms of the model get an ingest registration (idempotent per project and key)
  for (const f of i.model.forms)
    await c.query(
      `INSERT INTO builder.forms (id, org_id, project_id, form_key, name, fields, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (project_id, form_key) DO UPDATE SET name=EXCLUDED.name, fields=EXCLUDED.fields, updated_at=now()`,
      [uuidv7(), org, i.projectId, f.id, f.name, JSON.stringify(f.fields), i.userId ?? null],
    );
  await c.query(
    `UPDATE builder.projects SET head_version_id=$2, version=version+1, updated_at=now() WHERE id=$1`,
    [i.projectId, versionId],
  );
  const at = new Date().toISOString();
  await emitUsage(c, {
    eventId: usageEventId({
      orgId: org,
      meterId: 'builder.build_minutes',
      resourceId: versionId,
      windowStart: at,
    }),
    orgId: org,
    meterId: 'builder.build_minutes',
    quantity: (buildMs / 60000).toFixed(6),
    unit: 'minute',
    resourceId: versionId,
    windowStart: at,
    windowEnd: at,
    occurredAt: at,
    dimensions: { project_type: 'website' },
    dataRegion: cfg.dataRegion,
    source: 'builder@M09',
  });
  return { versionId, seq, buildMs, issues: out.issues };
}
