/**
 * Deployment TARGETS (Phase 2, Session 06). Pure and offline: nothing here calls a provider, a node or a clock.
 *
 * Two questions are answered here and nowhere else:
 *  1. Which KIND of target can a project of a given product type be deployed to (and is it deployable at all yet)? `TARGET_BY_PRODUCT_TYPE`.
 *  2. Which concrete STAGING TARGET is registered, how far is it verified, and may a deployment use it? `StagingTarget`, `assertStagingTargetUsable`.
 *
 * Evidence vocabulary (CLAUDE.md §6): a target is `SIMULATED` (a local stand-in), `NOT VERIFIED` (implemented and configured, never run against the real thing)
 * or `LIVE-VERIFIED` (a recorded live check with an evidence reference). A real target is refused unless the owner's approval reference is present: HG-05 (the cloud
 * provider account and the node it provides, docs/07 HG-05-01..04) and HG-06 (access to the node's hosting panel, HG-06-01; the panel is HestiaCP per D-52). Custom domains and the
 * preview wildcard additionally need DNS control (registrar or DNS provider access, HG-07 or an owner-supplied domain).
 *
 * HestiaCP (ADR-067 on the separate hosting line) is a SHARED web-hosting panel: it is a candidate for STATIC and PHP sites only. It is never a target for arbitrary
 * AI-generated server code; those projects need an isolated runtime (Session 04, Execution Gateway), which this module only names as `isolated_runtime`.
 */

/** The 14 product types of the builder planner (`@nuzm/domain` `PRODUCT_TYPES`), repeated as a closed union so a new type forces a decision here (the spec checks they agree). */
export const PRODUCT_TYPES = [
  'website',
  'landing',
  'ecommerce',
  'webapp',
  'mobile',
  'flutter',
  'erp',
  'crm',
  'saas',
  'fullstack',
  'api',
  'database',
  'auth',
  'docs',
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/** What a project is published TO. */
export type DeployTargetKind =
  /** static files on a shared-hosting site (document root); HestiaCP or any `HostingAdapter` node can serve it */
  | 'static_hosting'
  /** an isolated runtime for server code (Session 04 Execution Gateway); NOT a shared-hosting panel */
  | 'isolated_runtime'
  /** a managed database (M08 data module): schema migrations, never a web target */
  | 'managed_database'
  /** app-store / device distribution: signed packages, never automated (CLAUDE.md §5) */
  | 'store_distribution';

/** Why a project type cannot be deployed yet. Each id names a dependency, never a promise. */
export type DeployBlocker =
  | 'HG-05' // a cloud provider account and a node (artifact upload path on a real node)
  | 'HG-06' // access to the node's hosting panel (HestiaCP, D-52) and to DNS for the preview and custom domains
  | 'S04-runtime' // an isolated runtime with an isolation attestation (Session 04, HG-10-02, D-21)
  | 'M08-data' // managed database provisioning and migration deploy
  | 'store-HG' // app-store accounts, signing keys, submissions (owner action only)
  | 'server-build'; // a server build/run recipe (start command, health path, env) the web-app pipeline does not produce for this type

export interface TargetRule {
  productType: ProductType;
  kind: DeployTargetKind;
  /**
   * `simulated`: the whole path (build → stage → smoke → switch → rollback) runs against the in-memory publisher TODAY, and is `NOT VERIFIED` on a real node until
   * HG-05/HG-06. `not_yet`: there is no deployment path; the API answers 422 `unsupported_capability` with the blockers.
   */
  readiness: 'simulated' | 'not_yet';
  /** the static output kind a `simulated` type publishes */
  publishes?: 'static_site' | 'static_webapp_export' | 'flutter_web_export';
  blockers: readonly DeployBlocker[];
  /** one line, English; the console carries the Arabic via i18n */
  note: string;
}

const rule = (r: TargetRule): TargetRule => r;

/**
 * Product type → target. The table is a `Record` over the closed union: a type added to `PRODUCT_TYPES` without a rule does not compile.
 * `fullstack` and `webapp` publish the STATIC export only (that is what the web-app pipeline builds and what `deploy.app_deployments` records); the server half of a
 * full-stack project needs an isolated runtime and is `not_yet`.
 */
export const TARGET_BY_PRODUCT_TYPE: Record<ProductType, TargetRule> = {
  website: rule({
    productType: 'website',
    kind: 'static_hosting',
    readiness: 'simulated',
    publishes: 'static_site',
    blockers: ['HG-05', 'HG-06'],
    note: 'Static site published to a hosting site (document root). Real node and panel: HG-05/HG-06; a custom domain also needs DNS control.',
  }),
  landing: rule({
    productType: 'landing',
    kind: 'static_hosting',
    readiness: 'simulated',
    publishes: 'static_site',
    blockers: ['HG-05', 'HG-06'],
    note: 'A landing page is a website: static files on a hosting site.',
  }),
  docs: rule({
    productType: 'docs',
    kind: 'static_hosting',
    readiness: 'simulated',
    publishes: 'static_site',
    blockers: ['HG-05', 'HG-06'],
    note: 'A documentation site builds to static files.',
  }),
  webapp: rule({
    productType: 'webapp',
    kind: 'static_hosting',
    readiness: 'simulated',
    publishes: 'static_webapp_export',
    blockers: ['HG-05', 'HG-06'],
    note: 'The static export of a browser app (built in a sandbox, supply-chain gate) is published like a site. A web app that needs a server process is not covered.',
  }),
  flutter: rule({
    productType: 'flutter',
    kind: 'static_hosting',
    readiness: 'not_yet',
    publishes: 'flutter_web_export',
    blockers: ['server-build', 'HG-05', 'HG-06', 'store-HG'],
    note: 'Only the Flutter WEB export could be static hosting, and the build recipe for it is not part of the pipeline yet. Device packages are store distribution.',
  }),
  ecommerce: rule({
    productType: 'ecommerce',
    kind: 'isolated_runtime',
    readiness: 'not_yet',
    blockers: ['S04-runtime', 'M08-data', 'HG-05', 'HG-06'],
    note: 'A shop needs a server (cart, orders, payments) and a database: an isolated runtime, not shared hosting. A static storefront alone is a website.',
  }),
  saas: rule({
    productType: 'saas',
    kind: 'isolated_runtime',
    readiness: 'not_yet',
    blockers: ['S04-runtime', 'M08-data', 'HG-05', 'HG-06'],
    note: 'Multi-tenant server application with a database and authentication: isolated runtime.',
  }),
  erp: rule({
    productType: 'erp',
    kind: 'isolated_runtime',
    readiness: 'not_yet',
    blockers: ['S04-runtime', 'M08-data', 'HG-05', 'HG-06'],
    note: 'Server application with a database: isolated runtime.',
  }),
  crm: rule({
    productType: 'crm',
    kind: 'isolated_runtime',
    readiness: 'not_yet',
    blockers: ['S04-runtime', 'M08-data', 'HG-05', 'HG-06'],
    note: 'Server application with a database: isolated runtime.',
  }),
  fullstack: rule({
    productType: 'fullstack',
    kind: 'isolated_runtime',
    readiness: 'not_yet',
    blockers: ['S04-runtime', 'M08-data', 'server-build', 'HG-05', 'HG-06'],
    note: 'Front end plus server plus database: the server half needs an isolated runtime; only its static front end could use static hosting.',
  }),
  api: rule({
    productType: 'api',
    kind: 'isolated_runtime',
    readiness: 'not_yet',
    blockers: ['S04-runtime', 'server-build', 'HG-05', 'HG-06'],
    note: 'A server process behind a health path: isolated runtime.',
  }),
  auth: rule({
    productType: 'auth',
    kind: 'isolated_runtime',
    readiness: 'not_yet',
    blockers: ['S04-runtime', 'M08-data', 'server-build'],
    note: 'An authentication service is a server component with secrets and a database: isolated runtime, never shared hosting.',
  }),
  database: rule({
    productType: 'database',
    kind: 'managed_database',
    readiness: 'not_yet',
    blockers: ['M08-data'],
    note: 'A schema is applied to a managed database as reviewed migrations. It has no web target and is not published through the deployments endpoint.',
  }),
  mobile: rule({
    productType: 'mobile',
    kind: 'store_distribution',
    readiness: 'not_yet',
    blockers: ['store-HG'],
    note: 'Signed device packages and store submissions are owner actions (CLAUDE.md §5); the platform never submits them.',
  }),
};

/** The builder project TYPES (`builder.projects.type`: website, webapp, mobile) that the deployments endpoint sees; a type with no rule is refused, never guessed. */
export const BUILDER_PROJECT_TYPE_TO_PRODUCT: Record<string, ProductType> = {
  website: 'website',
  webapp: 'webapp',
  mobile: 'mobile',
};

export interface TargetDecision {
  allowed: boolean;
  rule: TargetRule;
  /** 422 `unsupported_capability` message when `allowed` is false */
  message: string | null;
}

/** May a product type be deployed through the deployments endpoint? `simulated` types are allowed (and labelled SIMULATED unless a verified target is registered). */
export function decideTarget(productType: string): TargetDecision | null {
  const r = (TARGET_BY_PRODUCT_TYPE as Record<string, TargetRule | undefined>)[productType];
  if (!r) return null;
  if (r.readiness === 'simulated') return { allowed: true, rule: r, message: null };
  return {
    allowed: false,
    rule: r,
    message: `${productType} projects are not deployable yet: target ${r.kind}, blocked by ${r.blockers.join(', ')}`,
  };
}

/* ───────────── staging target model ───────────── */

export type TargetVerification = 'SIMULATED' | 'NOT VERIFIED' | 'LIVE-VERIFIED';
export type TargetProvider = 'in_memory' | 'hosting_panel' | 'isolated_runtime';

/**
 * One registered target a deployment may publish to. `approvalRef` is the owner's recorded decision (HG-05/HG-06: the node and its panel access); `evidenceRef` is the recorded live check. A `LIVE-VERIFIED` target without evidence, or a real one without approval, is unusable.
 */
export interface StagingTarget {
  id: string;
  kind: DeployTargetKind;
  provider: TargetProvider;
  verification: TargetVerification;
  /** data region of the node (residency check runs before anything is placed) */
  region: string;
  /** registrable domain that serves temporary staging subdomains (ADR-060: never a subdomain of the console or API domain); null for a simulated target */
  previewDomain: string | null;
  approvalRef: string | null;
  evidenceRef: string | null;
}

export class StagingTargetRefused extends Error {
  constructor(
    readonly reason:
      | 'approval_missing'
      | 'evidence_missing'
      | 'preview_domain_missing'
      | 'kind_mismatch'
      | 'not_implemented',
    message: string,
  ) {
    super(message);
    this.name = 'StagingTargetRefused';
  }
}

/** Is this target allowed to receive a deployment for `productType`? Refuses (never degrades) so a real target can never be used by accident. */
export function assertStagingTargetUsable(target: StagingTarget, productType: string): void {
  const d = decideTarget(productType);
  if (!d || !d.allowed)
    throw new StagingTargetRefused(
      'not_implemented',
      d?.message ?? `unknown product type ${productType}`,
    );
  if (target.kind !== d.rule.kind)
    throw new StagingTargetRefused(
      'kind_mismatch',
      `a ${target.kind} target cannot receive a ${productType} project (needs ${d.rule.kind})`,
    );
  if (target.provider === 'in_memory') {
    if (target.verification !== 'SIMULATED')
      throw new StagingTargetRefused('evidence_missing', 'an in-memory target is always SIMULATED');
    return;
  }
  if (target.provider === 'isolated_runtime')
    throw new StagingTargetRefused(
      'not_implemented',
      'the isolated runtime target is Session 04 (Execution Gateway); it needs an isolation attestation and is not wired to deployments',
    );
  // a real hosting node
  if (!target.approvalRef)
    throw new StagingTargetRefused(
      'approval_missing',
      'a real hosting target needs the owner approval reference (HG-05/HG-06) recorded on it',
    );
  if (!target.previewDomain)
    throw new StagingTargetRefused(
      'preview_domain_missing',
      'a real staging target needs a preview domain (ADR-060 isolated origin)',
    );
  if (target.verification === 'LIVE-VERIFIED' && !target.evidenceRef)
    throw new StagingTargetRefused(
      'evidence_missing',
      'LIVE-VERIFIED needs a recorded evidence reference',
    );
}

/** The label shown in the API, console and reports for a deployment made through a target. */
export function evidenceLabel(target: Pick<StagingTarget, 'verification'>): TargetVerification {
  return target.verification;
}

/** The local reference target (`AI_LOCAL_REFERENCE=true`): in memory, SIMULATED, no preview domain. */
export const SIMULATED_STAGING_TARGET: StagingTarget = Object.freeze({
  id: 'simulated-local',
  kind: 'static_hosting',
  provider: 'in_memory',
  verification: 'SIMULATED',
  region: 'local',
  previewDomain: null,
  approvalRef: null,
  evidenceRef: null,
});
