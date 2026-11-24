import { createHash } from 'node:crypto';

export interface TargetSite {
  id: string;
  name: string;
  status: string;
  runtime: string;
  dataRegion: string;
  domain: string | null;
}
export interface ArtifactFile {
  path: string;
  mime: string;
  content: Uint8Array;
}
export interface Artifact {
  hash: string;
  files: ArtifactFile[];
}
export interface SmokeResult {
  ok: boolean;
  tls: boolean | null;
  results: { path: string; status: number }[];
}
export const artifactHash = (files: { path: string; content: Uint8Array }[]): string => {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1)))
    h.update(`${f.path}\0${createHash('sha256').update(f.content).digest('hex')}\n`);
  return h.digest('hex');
};

/**
 * What the deploy pipeline needs from a hosting node. The M06 `HostingAdapter` has NO deploy/upload method (it manages sites, domains, certificates, backups), so this
 * is a PORT: the fake below serves tests and the local reference; production has `UnavailableSitePublisher` (422 `unsupported_capability`) until the hosting module gains an artifact
 * upload path (SFTP into the site root, planned with the file manager). Nothing here claims what a real node can do.
 */
export abstract class SitePublisherPort {
  abstract available(): boolean;
  /** upload the artifact next to the live site without switching */
  abstract stage(
    site: TargetSite,
    artifact: Artifact,
    deploymentId: string,
  ): Promise<{ stagingRef: string }>;
  /** HTTP 200 on every path (and TLS when the site URL is https) */
  abstract smoke(
    site: TargetSite,
    where: 'staged' | 'live',
    stagingRef: string | null,
    paths: string[],
  ): Promise<SmokeResult>;
  abstract activate(site: TargetSite, stagingRef: string): Promise<{ url: string }>;
  /** serve THIS artifact again (rollback); `null` removes the content */
  abstract restore(site: TargetSite, artifact: Artifact | null): Promise<void>;
  abstract activeHash(site: TargetSite): Promise<string | null>;
}
export class UnavailableSitePublisher extends SitePublisherPort {
  available() {
    return false;
  }
  private no(): never {
    throw new Error('no hosting publish path is configured');
  }
  stage(): never {
    return this.no();
  }
  smoke(): never {
    return this.no();
  }
  activate(): never {
    return this.no();
  }
  restore(): never {
    return this.no();
  }
  activeHash(): never {
    return this.no();
  }
}
/** In-memory fake node: records what is live per site, with fault injection for the smoke checks. NOT a hosting node: nothing about a real one is verified. */
export class InMemorySitePublisher extends SitePublisherPort {
  readonly live = new Map<string, Artifact>();
  readonly staged = new Map<string, Artifact>();
  failSmoke: 'staged' | 'live' | null = null;
  failPaths = new Set<string>();
  stageCalls = 0;
  available() {
    return true;
  }
  async stage(_s: TargetSite, a: Artifact, deploymentId: string) {
    this.stageCalls++;
    this.staged.set(deploymentId, a);
    return { stagingRef: deploymentId };
  }
  async smoke(
    _s: TargetSite,
    where: 'staged' | 'live',
    ref: string | null,
    paths: string[],
  ): Promise<SmokeResult> {
    const files = new Set(
      (where === 'staged' ? this.staged.get(ref ?? '') : this.live.get(_s.id))?.files.map(
        (f) => f.path,
      ) ?? [],
    );
    const results = paths.map((p) => {
      const file = p.endsWith('/') ? `${p.replace(/^\//, '')}index.html` : p.replace(/^\//, '');
      return {
        path: p,
        status:
          this.failSmoke === where || this.failPaths.has(p) ? 503 : files.has(file) ? 200 : 404,
      };
    });
    return { ok: results.every((r) => r.status === 200), tls: true, results };
  }
  async activate(s: TargetSite, ref: string) {
    this.live.set(s.id, this.staged.get(ref)!);
    this.staged.delete(ref);
    return { url: `https://${s.domain ?? `${s.name.toLowerCase()}.sites.nuzm.invalid`}/` };
  }
  async restore(s: TargetSite, a: Artifact | null) {
    if (a) this.live.set(s.id, a);
    else this.live.delete(s.id);
  }
  async activeHash(s: TargetSite) {
    return this.live.get(s.id)?.hash ?? null;
  }
}

/**
 * Deployments of project types other than `website` (M10: `webapp`) are served by their own module through this delegate, registered at bootstrap by the owning module.
 * M09 owns `/v1/deployments/**`; it dispatches by the type of the project (create, list) or by which table holds the deployment (get, logs, rollback).
 * The shapes are the delegate's own (`deploy.app_deployments`, M10 migration 1440).
 */
export interface WebappDeployDelegate {
  create(orgId: string, userId: string, body: Record<string, unknown>): Promise<unknown>;
  list(orgId: string, projectId: string, limit: number): Promise<unknown>;
  /** null when the deployment is not a deployment of this delegate */
  find(orgId: string, id: string): Promise<{ id: string } | null>;
  get(orgId: string, id: string): Promise<unknown>;
  logs(orgId: string, id: string): Promise<unknown>;
  rollback(orgId: string, userId: string, id: string): Promise<unknown>;
}
