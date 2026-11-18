import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { csp, type SiteModel } from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { isUuid, previewHost, type BuilderConfig, type Row } from './model';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** 160-bit token as a DNS-safe lower-case base32 label (32 characters): the unguessable part of the preview host. */
export function newPreviewToken(): string {
  const b = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const x of b) {
    value = (value << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}
export const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
const VIEWPORTS = ['mobile', 'tablet', 'desktop'];

export interface PreviewDto {
  id: string;
  projectId: string;
  versionId: string;
  viewport: string;
  url: string;
  expiresAt: string;
  revoked: boolean;
}
export interface ServedFile {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

/**
 * Previews (M09 S39.4, ADR-021): the static output of a version served from an ISOLATED origin `<token>.<previewDomain>` — a different registrable domain from the
 * console and the API, so no cookie, storage or CORS relation exists. The token is 160 bits, only its hash is stored, it expires (default 30 min), is bound to its
 * organization and project, and dies with the project. The serving path reads files from the database only: it has no vault, no API token and makes no outbound call.
 */
export class PreviewService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly cfg: BuilderConfig,
  ) {}
  private url(token: string, locale: string) {
    return `${this.cfg.previewScheme}://${previewHost(token, this.cfg)}/${locale}/`;
  }
  async create(
    orgId: string,
    userId: string,
    projectId: string,
    b: Record<string, unknown>,
  ): Promise<PreviewDto> {
    if (!isUuid(projectId)) throw new ProblemException('not_found');
    const viewport = (b.viewport ?? 'desktop') as string;
    if (!VIEWPORTS.includes(viewport))
      throw new ProblemException('validation_failed', 'viewport must be mobile, tablet or desktop');
    if (b.versionId !== undefined && !isUuid(b.versionId))
      throw new ProblemException('validation_failed', 'versionId must be a uuid');
    const token = newPreviewToken();
    const id = uuidv7();
    const out = await this.db.withOrg(orgId, async (c) => {
      const p = (
        await c.query(
          `SELECT id, head_version_id, locales FROM builder.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
          [projectId],
        )
      ).rows[0] as Row | undefined;
      if (!p) throw new ProblemException('not_found');
      const active = Number(
        (
          await c.query(
            `SELECT count(*) n FROM builder.previews WHERE project_id=$1 AND revoked_at IS NULL AND expires_at > now()`,
            [projectId],
          )
        ).rows[0]!.n,
      );
      if (active >= this.cfg.maxActivePreviews)
        throw new ProblemException(
          'rate_limited',
          `at most ${this.cfg.maxActivePreviews} active previews per project`,
        );
      const vid = (b.versionId as string | undefined) ?? (p.head_version_id as string);
      if (
        !(
          await c.query(`SELECT 1 FROM builder.project_versions WHERE id=$1 AND project_id=$2`, [
            vid,
            projectId,
          ])
        ).rows[0]
      )
        throw new ProblemException('not_found', 'version not found');
      const r = (
        await c.query(
          `INSERT INTO builder.previews (id, org_id, project_id, version_id, token_hash, viewport, origin, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(mins => $8), $9) RETURNING expires_at`,
          [
            id,
            orgId,
            projectId,
            vid,
            tokenHash(token),
            viewport,
            previewHost('*', this.cfg),
            this.cfg.previewTtlMinutes,
            userId,
          ],
        )
      ).rows[0] as Row;
      return {
        vid,
        exp: new Date(r.expires_at as string).toISOString(),
        locale: (p.locales as string[])[0]!,
      };
    });
    await this.audit.record({
      action: 'builder.preview.created',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_preview', id },
      outcome: 'success',
      detail: { projectId },
    });
    return {
      id,
      projectId,
      versionId: out.vid,
      viewport,
      url: this.url(token, out.locale),
      expiresAt: out.exp,
      revoked: false,
    };
  }
  /** The token is only ever returned by `create`; the list shows ids and expiry, never a usable URL. */
  async list(orgId: string, projectId: string) {
    if (!isUuid(projectId)) throw new ProblemException('not_found');
    return this.db.withOrg(orgId, async (c) => {
      if (
        !(
          await c.query(`SELECT 1 FROM builder.projects WHERE id=$1 AND deleted_at IS NULL`, [
            projectId,
          ])
        ).rows[0]
      )
        throw new ProblemException('not_found');
      const rows = (
        await c.query(
          `SELECT id, version_id, viewport, expires_at, revoked_at FROM builder.previews WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50`,
          [projectId],
        )
      ).rows as Row[];
      return {
        items: rows.map((r) => ({
          id: r.id as string,
          projectId,
          versionId: r.version_id as string,
          viewport: r.viewport as string,
          expiresAt: new Date(r.expires_at as string).toISOString(),
          revoked: r.revoked_at !== null,
          active: r.revoked_at === null && new Date(r.expires_at as string).getTime() > Date.now(),
        })),
      };
    });
  }

  /** Serve one file. `host` must be exactly `<token>.<previewDomain>`; anything else (the console or API host, a wrong token) is a plain 404 with no detail. */
  async serve(host: string | undefined, token: string, rawPath: string): Promise<ServedFile> {
    const notFound: ServedFile = {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'not found',
    };
    const h = (host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!/^[a-z2-7]{32}$/.test(token) || h !== previewHost(token, this.cfg)) return notFound;
    const prev = (await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT pv.org_id, pv.project_id, pv.version_id, pv.expires_at, pv.revoked_at, p.deleted_at FROM builder.previews pv JOIN builder.projects p ON p.id = pv.project_id WHERE pv.token_hash=$1`,
            [tokenHash(token)],
          )
        ).rows[0],
    )) as Row | undefined;
    if (
      !prev ||
      prev.revoked_at ||
      prev.deleted_at ||
      new Date(prev.expires_at as string).getTime() <= Date.now()
    )
      return notFound;
    let path = decodeURIComponent(rawPath.split('?')[0] ?? '').replace(/^\/+/, '');
    if (path.includes('..') || path.includes('\\') || path.includes('\0')) return notFound;
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const org = prev.org_id as string;
    const row = await this.db.withOrg(org, async (c) => {
      const f = (
        await c.query(
          `SELECT mime, content FROM builder.project_files WHERE project_id=$1 AND version_id=$2 AND path=$3`,
          [prev.project_id, prev.version_id, path],
        )
      ).rows[0] as Row | undefined;
      const v = (
        await c.query(`SELECT site_model FROM builder.project_versions WHERE id=$1`, [
          prev.version_id,
        ])
      ).rows[0] as Row | undefined;
      return { f, model: v?.site_model as SiteModel | undefined };
    });
    if (!row.f || !row.model) return notFound;
    const policy = `${csp(row.model, { formsBaseUrl: this.cfg.formsBaseUrl })}; frame-ancestors ${this.cfg.consoleOrigin}`;
    return {
      status: 200,
      headers: {
        'content-type': row.f.mime as string,
        'content-security-policy': policy,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-origin',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
      },
      body: Buffer.from(row.f.content as Uint8Array),
    };
  }
}
