/**
 * The hosting-backed deployment TARGET (Phase 2, Session 06): `SitePublisherPort` composed from two narrow ports, so a HestiaCP-backed (or any) hosting node plugs in
 * later WITHOUT this module importing or duplicating hosting code.
 *
 *   HostingSiteOps     = the part of the hosting provider abstraction (`HostingAdapter`: probe, findByToken, issueCertificate, updateSite domains) that a publish needs.
 *                        Structural: a HestiaCP-backed `HostingAdapter` satisfies it through a thin mapping written in the hosting module when HG-05 is granted.
 *   ArtifactTransport  = the ONE thing `HostingAdapter` does not have: putting files on the node. HestiaCP's REST API has no file upload; the planned path is SFTP into
 *                        the site's document root (HESTIA-S1 report §G "SFTP file manager"). That path does not exist yet, so only the in-memory transport below does.
 *
 * Release layout on the node (identical for any transport): `<siteRoot>/releases/<releaseId>/…` per deployment, and `<siteRoot>/current` switched atomically (a symlink
 * or directory rename) to the chosen release. A deployment is therefore (1) upload to a NEW release directory, (2) verify what was written (hash read back from the node),
 * (3) smoke the staged URL, (4) switch `current`, (5) smoke live. Rollback switches `current` back to a retained release: no re-upload when it is still there. The last
 * `keepReleases` releases are retained; the live one is never pruned.
 *
 * Nothing here claims what a real node does: every result from the in-memory transport is SIMULATED.
 */
import {
  type Artifact,
  type SmokeResult,
  type TargetSite,
  SitePublisherPort,
  artifactHash,
} from './ports';
import { assertStagingTargetUsable, type StagingTarget } from './targets';
import { temporarySubdomain } from './preview-url';
import type { SslAction } from './ssl-flow';

export interface HostingSiteOps {
  /** does the site exist on the node and is it serving (reconcile-before-retry: asked before any retried segment) */
  siteState(site: TargetSite): Promise<{ exists: boolean; suspended: boolean } | null>;
  /** managed certificate for the given domains (ACME on the node); `custom` certificates are not offered */
  issueManagedCertificate(
    site: TargetSite,
    domains: string[],
  ): Promise<{ notAfter: string; domains: string[] }>;
}

export interface ReleaseInfo {
  releaseId: string;
  hash: string;
  files: number;
  bytes: number;
}

export interface ArtifactTransport {
  readonly simulated: boolean;
  /** write the artifact into a NEW release directory; never touches `current` */
  putRelease(site: TargetSite, releaseId: string, artifact: Artifact): Promise<ReleaseInfo>;
  /** the manifest hash of what is on the node, read back (not the one we sent) */
  readReleaseHash(site: TargetSite, releaseId: string): Promise<string | null>;
  /** atomic switch of `current`; returns the release that was current */
  switchCurrent(site: TargetSite, releaseId: string): Promise<{ previousReleaseId: string | null }>;
  currentRelease(site: TargetSite): Promise<string | null>;
  /** HTTP status of `path` served from a release (staged) or from `current` (live) */
  probe(
    site: TargetSite,
    where: { release: string } | 'live',
    path: string,
  ): Promise<{ status: number }>;
  hasRelease(site: TargetSite, releaseId: string): Promise<boolean>;
  removeRelease(site: TargetSite, releaseId: string): Promise<void>;
  /** release ids, oldest first */
  listReleases(site: TargetSite): Promise<string[]>;
}

/** The live hosting node path is not built: this transport refuses every call (never silently succeeds). */
export class UnavailableArtifactTransport implements ArtifactTransport {
  readonly simulated = false;
  private no(): never {
    throw new Error('no artifact upload path to a hosting node exists yet (SFTP planned; HG-05)');
  }
  putRelease(): never {
    return this.no();
  }
  readReleaseHash(): never {
    return this.no();
  }
  switchCurrent(): never {
    return this.no();
  }
  currentRelease(): never {
    return this.no();
  }
  probe(): never {
    return this.no();
  }
  hasRelease(): never {
    return this.no();
  }
  removeRelease(): never {
    return this.no();
  }
  listReleases(): never {
    return this.no();
  }
}

/** In-memory node: per-site release directories and a `current` pointer, with fault injection. NOT a hosting node. */
export class InMemoryArtifactTransport implements ArtifactTransport {
  readonly simulated = true;
  private readonly releases = new Map<string, Map<string, Artifact>>();
  private readonly current = new Map<string, string>();
  /** corrupt what is stored for the next `putRelease` (integrity check must catch it) */
  corruptNextPut = false;
  /** answer `status` for these paths from `current` or from a release */
  failPaths = new Map<string, number>();
  puts = 0;
  private dir(site: TargetSite) {
    let d = this.releases.get(site.id);
    if (!d) this.releases.set(site.id, (d = new Map()));
    return d;
  }
  async putRelease(site: TargetSite, releaseId: string, artifact: Artifact) {
    this.puts++;
    let stored = artifact;
    if (this.corruptNextPut) {
      this.corruptNextPut = false;
      stored = {
        hash: artifact.hash,
        files: artifact.files.map((f, i) =>
          i === 0 ? { ...f, content: new Uint8Array([...f.content, 0]) } : f,
        ),
      };
    }
    this.dir(site).set(releaseId, stored);
    return {
      releaseId,
      hash: artifactHash(stored.files),
      files: stored.files.length,
      bytes: stored.files.reduce((n, f) => n + f.content.byteLength, 0),
    };
  }
  async readReleaseHash(site: TargetSite, releaseId: string) {
    const a = this.dir(site).get(releaseId);
    return a ? artifactHash(a.files) : null;
  }
  async switchCurrent(site: TargetSite, releaseId: string) {
    if (!this.dir(site).has(releaseId)) throw new Error('release not found on the node');
    const previousReleaseId = this.current.get(site.id) ?? null;
    this.current.set(site.id, releaseId);
    return { previousReleaseId };
  }
  async currentRelease(site: TargetSite) {
    return this.current.get(site.id) ?? null;
  }
  async probe(site: TargetSite, where: { release: string } | 'live', path: string) {
    const forced = this.failPaths.get(path);
    if (forced !== undefined) return { status: forced };
    const id = where === 'live' ? this.current.get(site.id) : where.release;
    const a = id ? this.dir(site).get(id) : undefined;
    if (!a) return { status: 404 };
    const file = path.endsWith('/')
      ? `${path.replace(/^\//, '')}index.html`
      : path.replace(/^\//, '');
    return { status: a.files.some((f) => f.path === file) ? 200 : 404 };
  }
  async hasRelease(site: TargetSite, releaseId: string) {
    return this.dir(site).has(releaseId);
  }
  async removeRelease(site: TargetSite, releaseId: string) {
    if (this.current.get(site.id) === releaseId)
      throw new Error('the live release is never removed');
    this.dir(site).delete(releaseId);
  }
  async listReleases(site: TargetSite) {
    return [...this.dir(site).keys()];
  }
}

export class ReleaseIntegrityError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string | null,
  ) {
    super('the release on the node does not match the artifact that was sent');
    this.name = 'ReleaseIntegrityError';
  }
}

export interface HostingTargetOptions {
  /** how many releases are kept per site (the live one counts); default 5 */
  keepReleases?: number;
  /** the isolated preview domain for temporary staging hosts (ADR-060); null = simulated `.invalid` hosts */
  previewDomain?: string | null;
  protectedDomains?: readonly string[];
}

export class HostingTargetPublisher extends SitePublisherPort {
  /** simulated while the transport or the target is a stand-in */
  readonly simulated: boolean;
  private readonly keep: number;
  constructor(
    private readonly ops: HostingSiteOps,
    /** exposed so tests and the rehearsal can inspect the node's releases */
    readonly transport: ArtifactTransport,
    readonly target: StagingTarget,
    private readonly opts: HostingTargetOptions = {},
  ) {
    super();
    this.simulated = transport.simulated || target.verification === 'SIMULATED';
    this.keep = Math.max(2, opts.keepReleases ?? 5);
  }
  available(): boolean {
    try {
      assertStagingTargetUsable(this.target, 'website');
      return true;
    } catch {
      return false;
    }
  }
  /**
   * The seal: every operation that touches the node first re-checks the target gate. A real target without the owner's approval reference (or without a preview
   * domain, or LIVE-VERIFIED without evidence) can therefore never place, switch or restore anything, even if something constructs this class by mistake.
   */
  private seal(): void {
    assertStagingTargetUsable(this.target, 'website');
  }
  async stage(site: TargetSite, artifact: Artifact, deploymentId: string) {
    this.seal();
    const state = await this.ops.siteState(site);
    if (!state?.exists) throw new Error('the site does not exist on the node');
    if (state.suspended) throw new Error('the site is suspended on the node');
    if (artifactHash(artifact.files) !== artifact.hash)
      throw new Error('the artifact hash does not match its files');
    const info = await this.transport.putRelease(site, deploymentId, artifact);
    // integrity: the hash READ BACK from the node must be the one we sent
    const back = await this.transport.readReleaseHash(site, deploymentId);
    if (back !== artifact.hash || info.hash !== artifact.hash) {
      await this.transport.removeRelease(site, deploymentId).catch(() => undefined);
      throw new ReleaseIntegrityError(artifact.hash, back);
    }
    return { stagingRef: deploymentId };
  }
  async smoke(
    site: TargetSite,
    where: 'staged' | 'live',
    stagingRef: string | null,
    paths: string[],
  ): Promise<SmokeResult> {
    const w = where === 'live' ? ('live' as const) : { release: stagingRef ?? '' };
    const results: { path: string; status: number }[] = [];
    for (const p of paths)
      results.push({ path: p, status: (await this.transport.probe(site, w, p)).status });
    // TLS: https is always the scheme of a served URL here; on a real node the HTTPS probe reports it (NOT VERIFIED)
    return { ok: results.every((r) => r.status === 200), tls: true, results };
  }
  async activate(site: TargetSite, stagingRef: string) {
    this.seal();
    await this.transport.switchCurrent(site, stagingRef);
    await this.prune(site);
    const host =
      site.domain ??
      temporarySubdomain({
        siteName: site.name,
        deploymentId: stagingRef,
        previewDomain: this.opts.previewDomain ?? null,
        protectedDomains: this.opts.protectedDomains ?? [],
      }).host;
    return { url: `https://${host}/` };
  }
  async discard(site: TargetSite, stagingRef: string) {
    if ((await this.transport.currentRelease(site)) === stagingRef) return; // never the live one
    await this.transport.removeRelease(site, stagingRef);
  }
  /** Serve THIS artifact again: switch to the retained release when it is still on the node, otherwise upload it as a new release first. `null` = serve nothing. */
  async restore(site: TargetSite, artifact: Artifact | null) {
    this.seal();
    if (!artifact) return; // removing content is not offered by a release layout: `current` keeps pointing at the last good release
    const releases = await this.transport.listReleases(site);
    for (const id of releases) {
      if ((await this.transport.readReleaseHash(site, id)) === artifact.hash) {
        await this.transport.switchCurrent(site, id);
        return;
      }
    }
    const id = `restore-${artifact.hash.slice(0, 12)}`;
    await this.transport.putRelease(site, id, artifact);
    if ((await this.transport.readReleaseHash(site, id)) !== artifact.hash)
      throw new ReleaseIntegrityError(artifact.hash, null);
    await this.transport.switchCurrent(site, id);
  }
  async activeHash(site: TargetSite) {
    const cur = await this.transport.currentRelease(site);
    return cur ? this.transport.readReleaseHash(site, cur) : null;
  }
  /** Keep the newest `keepReleases`, never the live one. */
  private async prune(site: TargetSite) {
    const live = await this.transport.currentRelease(site);
    const all = await this.transport.listReleases(site);
    const excess = all.length - this.keep;
    for (const id of all.slice(0, Math.max(0, excess))) {
      if (id !== live) await this.transport.removeRelease(site, id).catch(() => undefined);
    }
  }
  /** Execute one SSL action chosen by `planSsl`. Only managed certificates exist; everything else is a no-op or refused by the planner. */
  async applySsl(site: TargetSite, action: SslAction) {
    this.seal();
    if (action.kind === 'issue_managed' || action.kind === 'renew_managed')
      return this.ops.issueManagedCertificate(site, action.domains);
    return null;
  }
}

/** A hosting-ops stand-in for the simulated target: the site exists, certificates are fabricated 90-day records labelled by the caller as SIMULATED. */
export class InMemoryHostingSiteOps implements HostingSiteOps {
  suspended = new Set<string>();
  missing = new Set<string>();
  issued: { siteId: string; domains: string[] }[] = [];
  constructor(private readonly now: () => number = () => Date.now()) {}
  async siteState(site: TargetSite) {
    return { exists: !this.missing.has(site.id), suspended: this.suspended.has(site.id) };
  }
  async issueManagedCertificate(site: TargetSite, domains: string[]) {
    this.issued.push({ siteId: site.id, domains });
    return { notAfter: new Date(this.now() + 90 * 86_400_000).toISOString(), domains };
  }
}
