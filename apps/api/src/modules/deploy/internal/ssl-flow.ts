/**
 * SSL configuration flow of a deployment target (Phase 2, Session 06). A pure planner: given what is known, it answers WHAT TO DO NEXT. It performs nothing, so it can be
 * tested exhaustively offline, and the executor (the hosting module's `issueCertificate`, on a real node) is a separate, gated step.
 *
 * Two host kinds:
 *  - `temporary`: a staging subdomain under the isolated preview domain (ADR-060). Served by the edge with ONE wildcard certificate for `*.<previewDomain>`; no per-site
 *    issuance. The wildcard certificate itself is an owner/ops item: DNS-01 validation needs DNS API access for the preview domain, and the edge needs the node/panel access of HG-06.
 *  - `custom`: the customer's own domain. Needs DNS control proof first, then a MANAGED certificate (the hosting node's ACME client). Customer-uploaded certificates are
 *    `unsupported` by the HostingAdapter capability until built and tested.
 */

export type SslHostKind = 'temporary' | 'custom';
export type SslState =
  | 'not_required' // plain-HTTP-free: covered by the wildcard at the edge
  | 'awaiting_dns' // custom domain: the customer must create the records
  | 'issuing'
  | 'active'
  | 'expiring'
  | 'failed';

export type SslAction =
  | { kind: 'none' }
  | { kind: 'show_dns_records' }
  | { kind: 'verify_dns' }
  | { kind: 'issue_managed'; domains: string[] }
  | { kind: 'renew_managed'; domains: string[] }
  | { kind: 'wait'; reason: 'issuance_in_progress' }
  | { kind: 'retry_issue'; domains: string[]; afterSeconds: number }
  | { kind: 'blocked'; blocker: 'HG-06' | 'unsupported_custom_certificate' };

export interface SslInput {
  hostKind: SslHostKind;
  host: string;
  /** the target is a stand-in: nothing real is issued */
  simulated: boolean;
  /** HG-06 (node/panel access) recorded for this target: needed for any real certificate, since a managed certificate is issued by the node's panel */
  hg06Approved: boolean;
  /** custom domains: did the DNS proof succeed */
  dnsVerified: boolean;
  cert: {
    state: 'none' | 'issuing' | 'active' | 'failed';
    notAfter: string | null;
    failures: number;
  };
  /** ISO time of the decision (injected: this module never reads a clock) */
  now: string;
  /** a customer-supplied certificate was requested */
  customCertificateRequested?: boolean;
}

export interface SslPlan {
  state: SslState;
  action: SslAction;
  /** how the plan is labelled everywhere it is shown */
  label: 'SIMULATED' | 'NOT VERIFIED';
}

export const RENEW_BEFORE_DAYS = 30;
const RETRY_BACKOFF_SECONDS = [60, 300, 1800, 7200];

export function planSsl(i: SslInput): SslPlan {
  const label = i.simulated ? 'SIMULATED' : 'NOT VERIFIED';
  if (i.customCertificateRequested)
    return {
      state: 'failed',
      action: { kind: 'blocked', blocker: 'unsupported_custom_certificate' },
      label,
    };
  if (i.hostKind === 'temporary') {
    // the wildcard is the edge's: a real one is HG-06, the simulated one is free
    if (!i.simulated && !i.hg06Approved)
      return { state: 'awaiting_dns', action: { kind: 'blocked', blocker: 'HG-06' }, label };
    return { state: 'not_required', action: { kind: 'none' }, label };
  }
  if (!i.simulated && !i.hg06Approved)
    return { state: 'awaiting_dns', action: { kind: 'blocked', blocker: 'HG-06' }, label };
  if (!i.dnsVerified)
    return {
      state: 'awaiting_dns',
      action: i.cert.failures > 0 ? { kind: 'verify_dns' } : { kind: 'show_dns_records' },
      label,
    };
  const domains = [i.host];
  switch (i.cert.state) {
    case 'none':
      return { state: 'issuing', action: { kind: 'issue_managed', domains }, label };
    case 'issuing':
      return { state: 'issuing', action: { kind: 'wait', reason: 'issuance_in_progress' }, label };
    case 'failed':
      return {
        state: 'failed',
        action: {
          kind: 'retry_issue',
          domains,
          afterSeconds:
            RETRY_BACKOFF_SECONDS[Math.min(i.cert.failures, RETRY_BACKOFF_SECONDS.length) - 1] ??
            RETRY_BACKOFF_SECONDS[0]!,
        },
        label,
      };
    case 'active': {
      if (i.cert.notAfter) {
        const left = (Date.parse(i.cert.notAfter) - Date.parse(i.now)) / 86_400_000;
        if (!(left > 0))
          return { state: 'failed', action: { kind: 'renew_managed', domains }, label };
        if (left <= RENEW_BEFORE_DAYS)
          return { state: 'expiring', action: { kind: 'renew_managed', domains }, label };
      }
      return { state: 'active', action: { kind: 'none' }, label };
    }
  }
}

/**
 * The smoke check of a deployment is an HTTPS check when the live URL is https. This answers whether a deployment may be switched live given the SSL plan: a custom
 * domain must have an ACTIVE or EXPIRING certificate; a temporary host is always served by the wildcard.
 */
export function canSwitchLive(plan: SslPlan, hostKind: SslHostKind): boolean {
  if (hostKind === 'temporary') return plan.state === 'not_required';
  return plan.state === 'active' || plan.state === 'expiring';
}
