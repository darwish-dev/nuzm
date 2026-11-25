/**
 * `HostingSiteOps` over the REAL `HestiaHostingAdapter` surface (Phase 3, P3-S07). The deploy module imports nothing from the hosting module: it declares the few structural types it
 * needs (a strict subset of the hosting module's `HostingAdapter`: `findByToken`, `issueCertificate`, `probe`), so a `HestiaHostingAdapter` instance satisfies `HostingAdapterSubset`
 * without a cast, and the wiring in the hosting module only has to supply the org-scoped `SiteBindingResolver` (which node, which account context, which on-node site name).
 *
 * Rules carried over from the adapter contract (docs/09 rule 3, CLAUDE.md section 4):
 *   - an `uncertain` or `failed` answer is NEVER read as "absent" or "done": `siteState` throws, so the deploy segment is retried only after a reconcile, never on a guess;
 *   - every certificate request has a deterministic idempotency token (site, sorted domains), so a retry after a timeout reconciles instead of ordering twice;
 *   - the per-site binding is resolved per call, org-scoped by the hosting module: a site of another organization resolves to `null` and is reported as missing.
 * Nothing here was run against a node: every behaviour is READ from the adapter source and exercised over a stand-in (SIMULATED); a real run is NOT VERIFIED until HG-05/HG-06.
 */
import { createHash } from 'node:crypto';
import type { HostingSiteOps } from './hosting-target';
import type { TargetSite } from './ports';

/** structural subset of the hosting module's `OperationResult<T>` */
export interface OpResult<T> {
  status: 'succeeded' | 'accepted' | 'failed' | 'uncertain';
  data?: T;
  error?: { category?: string; message?: string };
}
/** structural subset of `HostingAdapter`; a `HestiaHostingAdapter` is assignable to it */
export interface HostingAdapterSubset<Ctx = unknown, Node = unknown> {
  findByToken(
    ctx: Ctx,
    node: Node,
    siteName: string,
  ): Promise<OpResult<{ name: string; suspended: boolean; domains: string[] } | null>>;
  issueCertificate(
    ctx: Ctx,
    node: Node,
    siteName: string,
    req: { domains: string[]; mode: 'managed' | 'custom'; customCertRef?: string },
    t: { idempotencyToken: string; operationId: string },
  ): Promise<OpResult<{ certId: string; notAfter: string; domains: string[] }>>;
}
/** what the hosting module resolves for a deploy site: the adapter arguments and the on-node account name. `null` = unknown to this organization. */
export interface SiteBinding<Ctx = unknown, Node = unknown> {
  ctx: Ctx;
  node: Node;
  siteName: string;
}
export type SiteBindingResolver<Ctx = unknown, Node = unknown> = (
  site: TargetSite,
) => Promise<SiteBinding<Ctx, Node> | null>;

export class SiteOpsUncertain extends Error {
  constructor(what: string) {
    super(`${what}: the result is uncertain; reconcile before any retry`);
    this.name = 'SiteOpsUncertain';
  }
}

export const certificateToken = (siteId: string, domains: string[]): string =>
  `cert-${createHash('sha256')
    .update(
      `${siteId}\0${[...domains]
        .map((d) => d.toLowerCase())
        .sort()
        .join(',')}`,
    )
    .digest('hex')
    .slice(0, 32)}`;

export class HestiaSiteOps<Ctx = unknown, Node = unknown> implements HostingSiteOps {
  constructor(
    private readonly adapter: HostingAdapterSubset<Ctx, Node>,
    private readonly resolve: SiteBindingResolver<Ctx, Node>,
    /** the operation id of the surrounding deployment segment, for the adapter's own audit */
    private readonly operationId: () => string,
  ) {}

  async siteState(site: TargetSite): Promise<{ exists: boolean; suspended: boolean } | null> {
    const b = await this.resolve(site);
    if (!b) return { exists: false, suspended: false }; // another organization's site is indistinguishable from a missing one
    const r = await this.adapter.findByToken(b.ctx, b.node, b.siteName);
    if (r.status === 'uncertain') throw new SiteOpsUncertain('looking the site up on the node');
    if (r.status === 'failed')
      throw new Error(
        `the node could not be asked about the site (${r.error?.category ?? 'unknown'})`,
      );
    if (r.data === null || r.data === undefined) {
      // `findByToken` says "provably absent" with a succeeded result and null data; anything else without data is not an answer
      if (r.status === 'succeeded') return { exists: false, suspended: false };
      throw new SiteOpsUncertain('looking the site up on the node');
    }
    return { exists: true, suspended: r.data.suspended };
  }

  async issueManagedCertificate(
    site: TargetSite,
    domains: string[],
  ): Promise<{ notAfter: string; domains: string[] }> {
    if (domains.length === 0) throw new Error('a certificate needs at least one domain');
    const b = await this.resolve(site);
    if (!b) throw new Error('the site does not exist on the node');
    const r = await this.adapter.issueCertificate(
      b.ctx,
      b.node,
      b.siteName,
      { domains, mode: 'managed' },
      { idempotencyToken: certificateToken(site.id, domains), operationId: this.operationId() },
    );
    if (r.status === 'uncertain') throw new SiteOpsUncertain('issuing the certificate');
    if (r.status !== 'succeeded' || !r.data)
      throw new Error(`the certificate was not issued (${r.error?.category ?? r.status})`);
    return { notAfter: r.data.notAfter, domains: r.data.domains };
  }
}
