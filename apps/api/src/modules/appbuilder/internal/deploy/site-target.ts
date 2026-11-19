import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../../common/errors';
import { SitePublisherPort, artifactHash, type Artifact, type TargetSite } from '../../../deploy';
import type { Row } from '../core';
import { untarGz } from './archive';
import {
  DeployTargetPort,
  ReleaseStorePort,
  type DeployTarget,
  type TargetDeployResult,
} from './ports';

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
};
const mimeOf = (p: string) => MIME[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'text/plain';

/** The static front end of a generated web app: `public/**` of the release, served from the site root, plus a static `health` marker for the health gate. */
export function staticArtifactOf(files: ReadonlyMap<string, string>): Artifact | null {
  const out: { path: string; mime: string; content: Uint8Array }[] = [];
  for (const [p, c] of files)
    if (p.startsWith('public/') && !p.endsWith('/'))
      out.push({
        path: p.slice('public/'.length),
        mime: mimeOf(p),
        content: Buffer.from(c, 'utf8'),
      });
  if (!out.some((f) => f.path === 'index.html')) return null;
  if (!out.some((f) => f.path === 'health'))
    out.push({
      path: 'health',
      mime: 'application/json',
      content: Buffer.from('{"status":"ok","scope":"static-frontend"}', 'utf8'),
    });
  return { hash: artifactHash(out), files: out };
}

/**
 * The deploy target of a web app on a HOSTING SITE (M06 site, `hosting.sites`), published through M09's `SitePublisherPort` (stage → smoke → activate; `restore` for
 * rollback). LIMITS, stated plainly: the port publishes STATIC FILES, so only the `public/` front end of the release is served; the Node back end and the database
 * migrations of the generated app have no compute path here (a compute-instance target does not exist yet: M05/M06 open items). `appliedMigrations` is therefore empty
 * and `migrations` are NOT applied — the migrations stay "pending" on the deployment and a destructive one still needs its approval. Production has
 * `UnavailableSitePublisher` (422 `unsupported_capability`); the in-memory fake node of the local reference is NOT a hosting node (NOT VERIFIED live).
 */
export class SitePublisherDeployTarget extends DeployTargetPort {
  constructor(
    private readonly db: Db,
    private readonly publisher: SitePublisherPort,
    private readonly releases: ReleaseStorePort,
  ) {
    super();
  }
  private async site(orgId: string, id: string): Promise<(TargetSite & { row: Row }) | null> {
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT id, name, status, runtime, data_region, domain_primary FROM hosting.sites WHERE id=$1 AND deleted_at IS NULL`,
            [id],
          )
        ).rows[0],
    )) as Row | undefined;
    return r
      ? {
          id: r.id as string,
          name: r.name as string,
          status: r.status as string,
          runtime: r.runtime as string,
          dataRegion: r.data_region as string,
          domain: (r.domain_primary as string | null) ?? null,
          row: r,
        }
      : null;
  }
  async resolve(
    orgId: string,
    target: { type: 'site' | 'instance'; id: string },
  ): Promise<DeployTarget | null> {
    if (target.type !== 'site') return null; // no compute-instance publish path exists
    if (!this.publisher.available())
      throw new ProblemException(
        'unsupported_capability',
        'no hosting publish path is configured: live publish needs a real hosting node (HG-05-01/02, HG-06-01)',
      );
    const s = await this.site(orgId, target.id);
    if (!s) return null;
    return {
      id: s.id,
      orgId,
      type: 'site',
      region: s.dataRegion,
      status: s.status === 'active' ? 'active' : 'suspended',
      newPaidResource: false,
      baseUrl: `https://${s.domain ?? `${s.name.toLowerCase()}.sites.nuzm.invalid`}`,
    };
  }
  async appliedMigrations(): Promise<number[]> {
    return [];
  }
  async deploy(
    orgId: string,
    targetId: string,
    release: Parameters<DeployTargetPort['deploy']>[2],
  ): Promise<TargetDeployResult> {
    const site = await this.site(orgId, targetId);
    if (!site) throw new Error('the hosting site is gone');
    const bytes = await this.releases.get(orgId, release.artifactRef);
    if (!bytes) throw new Error('the release artifact is missing');
    const art = staticArtifactOf(untarGz(bytes));
    if (!art) throw new Error('the release has no static front end (public/index.html)');
    const staged = await this.publisher.stage(site, art, release.deploymentId);
    const smoke = await this.publisher.smoke(site, 'staged', staged.stagingRef, ['/']);
    if (!smoke.ok) throw new Error('the staged site did not pass the smoke check');
    const { url } = await this.publisher.activate(site, staged.stagingRef);
    return { url, releaseRef: release.artifactRef };
  }
  async activate(orgId: string, targetId: string, releaseRef: string): Promise<void> {
    const site = await this.site(orgId, targetId);
    if (!site) throw new Error('the hosting site is gone');
    const bytes = await this.releases.get(orgId, releaseRef);
    const art = bytes ? staticArtifactOf(untarGz(bytes)) : null;
    if (!art) throw new Error('the earlier release is not available');
    await this.publisher.restore(site, art);
  }
  async currentRelease(orgId: string, targetId: string): Promise<string | null> {
    const site = await this.site(orgId, targetId);
    const hash = site ? await this.publisher.activeHash(site).catch(() => null) : null;
    if (!hash) return null;
    const rows = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT artifact_ref FROM deploy.app_deployments WHERE target_id = $1 AND state = 'live' ORDER BY created_at DESC LIMIT 1`,
            [targetId],
          )
        ).rows,
    )) as Row[];
    const ref = (rows[0]?.artifact_ref as string | undefined) ?? null;
    if (!ref) return null;
    const bytes = await this.releases.get(orgId, ref);
    const art = bytes ? staticArtifactOf(untarGz(bytes)) : null;
    return art && art.hash === hash ? ref : null;
  }
}
