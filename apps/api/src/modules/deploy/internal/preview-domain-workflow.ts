/**
 * Preview-domain configuration, routing, TLS and validation workflow (Phase 3, P3-S07; B-DOMAIN is still an OPEN owner decision).
 *
 * It ASSUMES NOTHING exists: no domain, no DNS record, no wildcard certificate. Every check is either static (the configuration itself) or goes through an injected port; a check whose
 * port is absent is `NOT VERIFIED` with the exact thing missing, never `PASS`. The order is the order an owner would act in, so the report is also the to-do list:
 *
 *   1 config        the preview domain is a valid host on a registrable domain separate from console, admin, API and marketing (ADR-060)           static
 *   2 wildcard DNS  `*.<preview domain>` resolves to the node (a random label is resolved, so a single specific record cannot pass for a wildcard)  DnsPort
 *   3 wildcard TLS  a certificate that covers `*.<preview domain>`, chains to a trusted root, expires in at least `minDaysLeft` days            TlsInspectPort
 *   4 routing       a temporary host answers for ITS deployment; an unknown label under the wildcard does NOT serve any site; the bare preview domain serves nothing   HostRoutingPort
 *   5 cookies       no console cookie can reach the preview origin (registrable-domain separation re-checked on the resolved name)                  static
 *
 * Evidence: a report over stand-in ports is SIMULATED. LIVE-VERIFIED is assigned only by an evidence record from a real run; this module never assigns it.
 */
import {
  assertIsolatedPreviewDomain,
  normaliseHost,
  registrableDomain,
  temporarySubdomain,
} from './preview-url';

export type CheckStatus = 'PASS' | 'FAIL' | 'NOT VERIFIED';
export interface DomainCheck {
  id: 'config' | 'wildcard_dns' | 'wildcard_tls' | 'routing' | 'cookies';
  title: string;
  status: CheckStatus;
  detail: string;
  /** what the owner or the node must provide for this check to run (empty when it ran) */
  needs: string[];
}
export interface PreviewDomainReport {
  previewDomain: string | null;
  origin: 'SIMULATED' | 'REAL';
  checks: DomainCheck[];
  /** every check PASS (never true while any is NOT VERIFIED) */
  allPass: boolean;
  /** the first check that is not PASS, in the order above (what to fix next) */
  next: DomainCheck['id'] | null;
}

export interface DnsPort {
  /** addresses the name resolves to (A/AAAA); empty = does not resolve */
  resolve(host: string): Promise<string[]>;
}
export interface TlsInspectPort {
  /** the certificate presented for `host` over a real handshake */
  inspect(host: string): Promise<{
    names: string[];
    notAfter: string;
    /** the chain validated to a trusted root for this host name */
    trusted: boolean;
  }>;
}
export interface HostRoutingPort {
  /** HTTPS status of `/` for a Host name, or 0 when the connection or TLS fails */
  status(host: string): Promise<number>;
}

export interface PreviewDomainInput {
  previewDomain: string | null;
  protectedDomains: readonly string[];
  /** the node's public address(es) the wildcard must resolve to; unknown = the DNS check cannot decide */
  nodeAddresses?: readonly string[];
  dns?: DnsPort;
  tls?: TlsInspectPort;
  routing?: HostRoutingPort;
  /** a deployment that is live on the node, to check that its temporary host routes to it; optional */
  sample?: { siteName: string; deploymentId: string; tagKey?: string };
  /** a random unguessable label used to tell a wildcard from a single record */
  randomLabel?: () => string;
  now?: () => Date;
  minDaysLeft?: number;
  origin: 'SIMULATED' | 'REAL';
}

const matchesWildcard = (names: string[], previewDomain: string) =>
  names.some((n) => {
    const x = normaliseHost(n);
    return x === `*.${previewDomain}`;
  });

export async function validatePreviewDomain(i: PreviewDomainInput): Promise<PreviewDomainReport> {
  const checks: DomainCheck[] = [];
  const add = (c: DomainCheck) => checks.push(c);
  const pd = i.previewDomain ? normaliseHost(i.previewDomain) : null;
  const now = (i.now ?? (() => new Date()))();
  const min = i.minDaysLeft ?? 14;

  // 1 config
  let cfgOk = false;
  if (!pd) {
    add({
      id: 'config',
      title: 'preview domain configured and separate from console/API (ADR-060)',
      status: 'NOT VERIFIED',
      detail: 'no preview domain is configured (decision B-DOMAIN is open)',
      needs: [
        'B-DOMAIN: the owner picks a preview domain on a registrable domain that is not the console, admin, API or marketing domain',
      ],
    });
  } else {
    try {
      assertIsolatedPreviewDomain(pd, i.protectedDomains);
      cfgOk = true;
      add({
        id: 'config',
        title: 'preview domain configured and separate from console/API (ADR-060)',
        status: 'PASS',
        detail: `${pd} is on ${registrableDomain(pd)}, separate from ${i.protectedDomains.length} protected domain(s)`,
        needs: [],
      });
    } catch (e) {
      add({
        id: 'config',
        title: 'preview domain configured and separate from console/API (ADR-060)',
        status: 'FAIL',
        detail: e instanceof Error ? e.message : String(e),
        needs: ['a preview domain on its own registrable domain'],
      });
    }
  }

  const blocked = (
    id: DomainCheck['id'],
    title: string,
    why: string,
    needs: string[],
  ): DomainCheck => ({
    id,
    title,
    status: 'NOT VERIFIED',
    detail: why,
    needs,
  });
  const label = (i.randomLabel ?? (() => `nz-probe-${Math.random().toString(36).slice(2, 12)}`))();

  // 2 wildcard DNS
  const dnsTitle = 'wildcard DNS resolves to the node';
  if (!cfgOk) add(blocked('wildcard_dns', dnsTitle, 'needs a valid preview domain first', []));
  else if (!i.dns)
    add(
      blocked('wildcard_dns', dnsTitle, 'no DNS resolver was supplied', [
        'a DNS resolver port (a real run uses the system resolver)',
      ]),
    );
  else if (!i.nodeAddresses || i.nodeAddresses.length === 0)
    add(
      blocked('wildcard_dns', dnsTitle, 'the node address is not known', [
        'HG-05: the node and its public address',
      ]),
    );
  else {
    const [wild, bare] = await Promise.all([
      i.dns.resolve(`${label}.${pd}`).catch(() => []),
      i.dns.resolve(`${label}-b.${pd}`).catch(() => []),
    ]);
    const want = new Set(i.nodeAddresses);
    const ok =
      wild.length > 0 &&
      bare.length > 0 &&
      wild.every((a) => want.has(a)) &&
      bare.every((a) => want.has(a));
    add({
      id: 'wildcard_dns',
      title: dnsTitle,
      status: ok ? 'PASS' : 'FAIL',
      detail: ok
        ? 'two unrelated random labels both resolve to the node (a wildcard, not a single record)'
        : wild.length === 0 || bare.length === 0
          ? `a random label under *.${pd} does not resolve: the wildcard record is missing`
          : 'a random label resolves to an address that is not the node',
      needs: ok ? [] : [`a wildcard record *.${pd} pointing at the node`],
    });
  }

  // 3 wildcard TLS
  const tlsTitle = 'wildcard certificate valid for the preview domain';
  if (!cfgOk) add(blocked('wildcard_tls', tlsTitle, 'needs a valid preview domain first', []));
  else if (!i.tls)
    add(
      blocked('wildcard_tls', tlsTitle, 'no TLS inspector was supplied', [
        'a TLS inspector port (a real run does a real handshake)',
      ]),
    );
  else {
    try {
      const c = await i.tls.inspect(`${label}.${pd}`);
      const days = (Date.parse(c.notAfter) - now.getTime()) / 86_400_000;
      const problems: string[] = [];
      if (!c.trusted) problems.push('the chain does not validate to a trusted root');
      if (!matchesWildcard(c.names, pd)) problems.push(`the certificate does not cover *.${pd}`);
      if (!(days >= min))
        problems.push(
          `expires in ${Number.isFinite(days) ? Math.floor(days) : 'an unknown number of'} days (minimum ${min})`,
        );
      add({
        id: 'wildcard_tls',
        title: tlsTitle,
        status: problems.length ? 'FAIL' : 'PASS',
        detail: problems.length
          ? problems.join('; ')
          : `covers *.${pd}, trusted, ${Math.floor(days)} days left`,
        needs: problems.length
          ? [
              `a wildcard certificate for *.${pd} (DNS-01 challenge; DNS API access stays with the node's ACME client)`,
            ]
          : [],
      });
    } catch (e) {
      add({
        id: 'wildcard_tls',
        title: tlsTitle,
        status: 'FAIL',
        detail: `the TLS handshake failed: ${e instanceof Error ? e.message : String(e)}`,
        needs: [`a wildcard certificate for *.${pd}`],
      });
    }
  }

  // 4 routing
  const routeTitle = 'temporary hosts route to their deployment only; unknown labels serve nothing';
  if (!cfgOk) add(blocked('routing', routeTitle, 'needs a valid preview domain first', []));
  else if (!i.routing)
    add(
      blocked('routing', routeTitle, 'no routing probe was supplied', [
        'a routing probe port (a real run does HTTPS GETs by host name)',
      ]),
    );
  else {
    const problems: string[] = [];
    const unknown = await i.routing.status(`${label}.${pd}`).catch(() => 0);
    if (unknown === 200)
      problems.push(
        'an unknown label under the wildcard answered 200: a catch-all serves something',
      );
    const bare = await i.routing.status(pd).catch(() => 0);
    if (bare === 200) problems.push('the bare preview domain answered 200');
    let sampleNote = 'no live sample deployment given: only the negative routes were checked';
    if (i.sample) {
      const host = temporarySubdomain({
        siteName: i.sample.siteName,
        deploymentId: i.sample.deploymentId,
        previewDomain: pd,
        protectedDomains: i.protectedDomains,
        ...(i.sample.tagKey ? { tagKey: i.sample.tagKey } : {}),
      }).host;
      const s = await i.routing.status(host).catch(() => 0);
      if (s !== 200) problems.push(`the sample deployment's temporary host answered ${s}, not 200`);
      sampleNote = `sample host answered ${s}`;
    }
    add({
      id: 'routing',
      title: routeTitle,
      status: problems.length ? 'FAIL' : i.sample ? 'PASS' : 'NOT VERIFIED',
      detail: problems.length
        ? problems.join('; ')
        : `unknown label ${unknown}, bare domain ${bare}; ${sampleNote}`,
      needs: problems.length
        ? ['fix the node routing so only a valid temporary host serves its deployment']
        : i.sample
          ? []
          : ['a deployed sample release to check the positive route'],
    });
  }

  // 5 cookies (static): the platform hosts must not share a registrable domain with the preview host
  const ckTitle = 'console cookies cannot reach the preview origin';
  if (!cfgOk) add(blocked('cookies', ckTitle, 'needs a valid preview domain first', []));
  else {
    const shared = i.protectedDomains.filter((p) => registrableDomain(p) === registrableDomain(pd));
    add({
      id: 'cookies',
      title: ckTitle,
      status: shared.length ? 'FAIL' : 'PASS',
      detail: shared.length
        ? `shares ${registrableDomain(pd)} with ${shared.join(', ')}`
        : `${registrableDomain(pd)} is not the registrable domain of any protected host (a console cookie is never sent to a preview host)`,
      needs: [],
    });
  }

  const next = checks.find((c) => c.status !== 'PASS')?.id ?? null;
  return {
    previewDomain: pd,
    origin: i.origin,
    checks,
    allPass: checks.length > 0 && checks.every((c) => c.status === 'PASS'),
    next,
  };
}

/* ---------- SIMULATED ports (for tests and the dry-run checklist; never a real name server or certificate) ---------- */
export class SimulatedDns implements DnsPort {
  constructor(
    private readonly records: { wildcardFor?: string; address: string; single?: string[] },
  ) {}
  async resolve(host: string): Promise<string[]> {
    const h = normaliseHost(host);
    if (this.records.single?.includes(h)) return [this.records.address];
    if (
      this.records.wildcardFor &&
      h.endsWith(`.${this.records.wildcardFor}`) &&
      h.split('.').length === this.records.wildcardFor.split('.').length + 1
    )
      return [this.records.address];
    return [];
  }
}
export class SimulatedTls implements TlsInspectPort {
  constructor(
    private readonly cert: { names: string[]; notAfter: string; trusted: boolean } | null,
  ) {}
  async inspect() {
    if (!this.cert) throw new Error('no certificate is presented');
    return this.cert;
  }
}
export class SimulatedRouting implements HostRoutingPort {
  constructor(
    private readonly served: Set<string>,
    private readonly catchAll = false,
  ) {}
  async status(host: string) {
    const h = normaliseHost(host);
    return this.served.has(h) || this.catchAll ? 200 : 404;
  }
}
