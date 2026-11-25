/**
 * Preview and staging URLs with TEMPORARY SUBDOMAINS (Phase 2, Session 06). Pure: no DNS, no network, no clock.
 *
 * ADR-060 (preview origin isolation) applies to every host that serves generated content:
 *  - the serving domain is a SEPARATE registrable domain from the console and API domains (no shared cookie scope, no CORS relation);
 *  - one origin per deployment (the host name carries the identifier), so deployments are isolated from each other;
 *  - the label is unguessable enough not to be enumerated, and is never derived from a secret.
 * Without a configured preview domain (the simulated target) the URL ends in `.invalid` (RFC 6761: it can never resolve), so a simulated URL can never be mistaken for a live one.
 */
import { createHash, createHmac } from 'node:crypto';

/** Second-level public suffixes this approximation knows. The real check is a public-suffix list reviewed by the owner (STAGING-DEPLOYMENT-PLAN §5); this errs towards refusing. */
const TWO_LEVEL_SUFFIXES = new Set([
  'com.sa',
  'net.sa',
  'org.sa',
  'gov.sa',
  'edu.sa',
  'co.uk',
  'org.uk',
  'com.au',
  'co.jp',
  'com.br',
]);
/** hex characters of the tag in a temporary host name: 16 = 64 bits */
export const TAG_HEX = 16;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class PreviewDomainRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewDomainRefused';
  }
}

export const normaliseHost = (h: string): string => h.trim().toLowerCase().replace(/\.$/, '');

/** Approximate registrable domain (eTLD+1) of a host name. */
export function registrableDomain(host: string): string {
  const labels = normaliseHost(host).split('.');
  if (labels.length <= 2) return labels.join('.');
  const last2 = labels.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(last2) ? labels.slice(-3).join('.') : last2;
}

/**
 * Throws unless `previewDomain` is a valid host name on a registrable domain different from every protected one (console, admin, API, marketing site).
 * A parent or child relation counts as shared (a cookie set on a parent domain is readable by its subdomains).
 */
export function assertIsolatedPreviewDomain(
  previewDomain: string,
  protectedDomains: readonly string[],
): string {
  const p = normaliseHost(previewDomain);
  if (!HOST.test(p)) throw new PreviewDomainRefused('the preview domain is not a valid host name');
  if (p.endsWith('.invalid') || p.endsWith('.localhost') || p === 'localhost')
    throw new PreviewDomainRefused(
      'a preview domain must be a real registrable domain (simulated targets use no preview domain)',
    );
  const preg = registrableDomain(p);
  for (const raw of protectedDomains) {
    const q = normaliseHost(raw);
    if (!q) continue;
    if (p === q || p.endsWith(`.${q}`) || q.endsWith(`.${p}`) || registrableDomain(q) === preg)
      throw new PreviewDomainRefused(
        `the preview domain shares a registrable domain with ${q}: ADR-060 requires a separate one`,
      );
  }
  return p;
}

/** A DNS label from free text: lowercase letters, digits and single hyphens; never empty. */
export function dnsLabel(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'site';
}

export interface TemporaryPreview {
  label: string;
  host: string;
  url: string;
  /** `true` when the host can never resolve (no preview domain configured) */
  simulated: boolean;
}

/**
 * `<site>-<16 hex of sha256 or HMAC(deploymentId)>.<previewDomain>`: stable for one deployment (a retried segment gets the same URL), different for every deployment, and the
 * identifier is not reversible to the id. Total label length stays within the 63-character DNS limit.
 */
export function temporarySubdomain(input: {
  siteName: string;
  deploymentId: string;
  previewDomain: string | null;
  protectedDomains?: readonly string[];
  /**
   * Server-side secret (a vault-held key, never logged): with it the tag is an HMAC, so the host cannot be derived from a deployment id by anyone who lacks it. Without it
   * (simulated targets, tests) the tag is a plain hash. Either way it is 64 bits: a preview host that is not published must not be guessable by enumeration.
   */
  tagKey?: string;
}): TemporaryPreview {
  const tag = (
    input.tagKey
      ? createHmac('sha256', input.tagKey).update(input.deploymentId).digest('hex')
      : createHash('sha256').update(input.deploymentId).digest('hex')
  ).slice(0, TAG_HEX);
  const label = `${dnsLabel(input.siteName, 40)}-${tag}`;
  if (input.previewDomain === null) {
    const host = `${label}.staging.nuzm.invalid`;
    return { label, host, url: `https://${host}/`, simulated: true };
  }
  const domain = assertIsolatedPreviewDomain(input.previewDomain, input.protectedDomains ?? []);
  const host = `${label}.${domain}`;
  return { label, host, url: `https://${host}/`, simulated: false };
}

/** Is `host` a temporary preview host of `previewDomain` (used by the serving edge and by tests; the match is exact, never a suffix trick like `evil-preview.example`)? */
export function isTemporaryPreviewHost(host: string, previewDomain: string): boolean {
  const h = normaliseHost(host);
  const d = normaliseHost(previewDomain);
  if (!h.endsWith(`.${d}`)) return false;
  const label = h.slice(0, -(d.length + 1));
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?-[0-9a-f]{16}$/.test(label) && label.length <= 63;
}
