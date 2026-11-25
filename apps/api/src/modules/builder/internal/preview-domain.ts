import { randomBytes } from 'node:crypto';

/**
 * Preview-domain routing, TLS and validation workflow (ADR-060 §1, §3, §8; owner decision B-DOMAIN is PENDING). This module assumes NOTHING exists: no DNS record, no
 * certificate, no edge. It does three things, all offline unless a caller injects live probes:
 *   1. `validatePreviewDomainConfig`: the configured names obey the isolation rules (a separate registrable domain, wildcard-certificate coverage, DNS limits);
 *   2. `renderEdgeConfig`: the nginx server block that maps `https://<token>.<domain>/<path>` to the API route, generated from the same configuration;
 *   3. `runPreviewDomainValidation`: the ordered checks to run once DNS and a certificate exist (wildcard DNS, certificate SANs and expiry, the isolation behaviour of the
 *      live edge). Every check whose probe is not supplied is reported `NOT VERIFIED`; a result is only ever `LIVE-VERIFIED` when a real probe returned it.
 */
export interface PreviewDomainConfig {
  previewDomain: string;
  scheme: 'http' | 'https';
  consoleOrigin: string;
  /** origin of the API (forms) host; the preview domain must be unrelated to it too */
  apiOrigin: string;
  /** hostname of the internal upstream the edge proxies to, e.g. `preview-api.internal:4000` */
  upstream?: string;
}
export interface DomainProblem {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

// Multi-label public suffixes that matter for this platform's markets. This is a conservative subset of the Public Suffix List (which is not vendored): an unknown
// two-label suffix is treated as a single-label TLD, which can only make the registrable-domain comparison STRICTER for names under it (it errs towards "same").
const MULTI_LABEL_SUFFIXES = new Set([
  'com.sa',
  'net.sa',
  'org.sa',
  'edu.sa',
  'gov.sa',
  'med.sa',
  'sch.sa',
  'pub.sa',
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'co.nz',
  'co.za',
  'com.br',
  'co.in',
  'com.eg',
  'com.tr',
  'co.jp',
  'com.ae',
  'co.ae',
  'com.kw',
  'com.qa',
  'com.bh',
  'com.om',
]);
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const two = labels.slice(-2).join('.');
  return MULTI_LABEL_SUFFIXES.has(two) ? labels.slice(-3).join('.') : two;
}
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local', 'internal']);

export function hostOf(origin: string): string | undefined {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function validatePreviewDomainConfig(cfg: PreviewDomainConfig): DomainProblem[] {
  const out: DomainProblem[] = [];
  const err = (code: string, message: string) => out.push({ code, severity: 'error', message });
  const warn = (code: string, message: string) => out.push({ code, severity: 'warning', message });
  const d = cfg.previewDomain;
  if (
    d !== d.toLowerCase() ||
    d.endsWith('.') ||
    d.includes('*') ||
    d.includes('/') ||
    d.includes(':')
  )
    err(
      'domain_form',
      'the preview domain must be a lowercase DNS name with no wildcard, port, path or trailing dot',
    );
  const labels = d.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)))
    err(
      'domain_labels',
      'the preview domain is not a valid DNS name (RFC 1123 labels, at least two)',
    );
  // `<32-char token>.<domain>` must be a legal DNS name
  if (32 + 1 + d.length > 253)
    err(
      'domain_length',
      'a preview host (32-character token + domain) would exceed 253 characters',
    );
  const tld = labels[labels.length - 1] ?? '';
  const prod = cfg.scheme === 'https';
  if (prod && RESERVED_TLDS.has(tld))
    warn(
      'reserved_tld',
      `".${tld}" is a reserved/non-resolvable top-level name: fine for tests, impossible for a real preview origin`,
    );
  if (cfg.scheme === 'http' && !/(^|\.)localhost$/.test(d))
    err('insecure_scheme', 'http is only acceptable on a *.localhost preview domain (development)');

  const consoleHost = hostOf(cfg.consoleOrigin);
  const apiHost = hostOf(cfg.apiOrigin);
  if (!consoleHost) err('console_origin', 'the console origin is not a URL');
  if (!apiHost) err('api_origin', 'the API origin is not a URL');
  const prevReg = registrableDomain(d);
  for (const [label, h] of [
    ['console', consoleHost],
    ['API', apiHost],
  ] as const) {
    if (!h) continue;
    // development only: `*.localhost` and loopback hosts cannot be separate registrable domains; browsers still treat each `<token>.preview.localhost` as its own origin
    if (
      cfg.scheme === 'http' &&
      /(^|\.)localhost$/.test(d) &&
      (/(^|\.)localhost$/.test(h) || h === '127.0.0.1' || h === '[::1]')
    ) {
      warn(
        'dev_loopback',
        `development: the ${label} host ${h} and the preview domain are both loopback names; production needs a separate registrable domain`,
      );
      continue;
    }
    if (h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`))
      err(
        `${label.toLowerCase()}_related`,
        `the preview domain and the ${label} host are the same or nested (${h}): previews would share cookies and storage with it`,
      );
    else if (registrableDomain(h) === prevReg)
      err(
        `${label.toLowerCase()}_same_site`,
        `the preview domain shares the registrable domain "${prevReg}" with the ${label} host ${h}: it must be a SEPARATE registrable domain (ADR-060 §1)`,
      );
  }
  return out;
}

/** Does a certificate with these subject alternative names serve `host`? A wildcard covers exactly ONE label (RFC 6125 §6.4.3), so `*.a.b` does not cover `x.y.a.b`. */
export function certCovers(sans: string[], host: string): boolean {
  const h = host.toLowerCase();
  return sans.some((raw) => {
    const s = raw.toLowerCase().replace(/^dns:/, '');
    if (s === h) return true;
    if (!s.startsWith('*.')) return false;
    const rest = s.slice(2);
    const i = h.indexOf('.');
    return (
      i > 0 &&
      h.slice(i + 1) === rest &&
      !h.slice(0, i).includes('*') &&
      rest.split('.').length >= 2
    );
  });
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The nginx server block for the preview edge, generated from the configuration (the checked-in file is an annotated example of the same shape). */
export function renderEdgeConfig(
  cfg: PreviewDomainConfig,
  opts: { certPath?: string; keyPath?: string } = {},
): string {
  const problems = validatePreviewDomainConfig(cfg).filter((p) => p.severity === 'error');
  if (problems.length)
    throw new Error(`refusing to render an edge config: ${problems.map((p) => p.code).join(', ')}`);
  const upstream = cfg.upstream ?? 'preview-api.internal:4000';
  if (!/^[a-z0-9.-]+(:\d{2,5})?$/i.test(upstream)) throw new Error('upstream must be host[:port]');
  const cert = opts.certPath ?? '/etc/ssl/preview/wildcard.crt';
  const key = opts.keyPath ?? '/etc/ssl/preview/wildcard.key';
  for (const p of [cert, key])
    if (!/^\/[A-Za-z0-9_./-]+$/.test(p))
      throw new Error('certificate paths must be plain absolute paths');
  return `# GENERATED from the preview-domain configuration. Not applied anywhere; no DNS record or certificate is assumed to exist (B-DOMAIN pending).
# Maps https://<token>.${cfg.previewDomain}/<path> to the API route /_preview/<token>/<path>.
# The serving process must run with NO egress and NO access to the vault or the internal network (network policy, HG-12-01).
server {
  listen 443 ssl;
  server_name ~^(?<token>[a-z2-7]{32})\\.${reEscape(cfg.previewDomain)}$;
  ssl_certificate     ${cert};   # must cover *.${cfg.previewDomain} (a wildcard covers ONE label)
  ssl_certificate_key ${key};
  ssl_protocols TLSv1.2 TLSv1.3;
  proxy_hide_header Set-Cookie;
  proxy_set_header Cookie "";
  proxy_set_header Authorization "";
  # only previews are reachable on this host: any other server_name is refused by the default server below
  location / {
    proxy_set_header Host $host;
    proxy_pass http://${upstream}/_preview/$token$request_uri;
  }
}
server {
  listen 443 ssl default_server;
  server_name _;
  ssl_reject_handshake on;
}
`;
}

export type CheckStatus = 'PASS' | 'FAIL' | 'NOT VERIFIED' | 'LIVE-VERIFIED' | 'LIVE-FAILED';
export interface DomainCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}
/** The live probes a validation can use. All optional: each missing one leaves its checks `NOT VERIFIED`. None is ever called by default. */
export interface DomainProbes {
  /** addresses the name resolves to ([] = NXDOMAIN) */
  resolve?(host: string): Promise<string[]>;
  /** the certificate the server presents for SNI `host`: subject alternative names, validity end and whether the chain verified */
  tlsCertificate?(host: string): Promise<{ sans: string[]; notAfter: string; chainOk: boolean }>;
  /** GET without following redirects */
  get?(
    url: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}
const randomToken = () => {
  const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
  return Array.from(randomBytes(32), (b) => B32[b % 32]).join('');
};

export async function runPreviewDomainValidation(
  cfg: PreviewDomainConfig,
  probes: DomainProbes = {},
  now: () => Date = () => new Date(),
): Promise<{ checks: DomainCheck[]; verified: boolean }> {
  const checks: DomainCheck[] = [];
  const add = (id: string, title: string, status: CheckStatus, detail: string) =>
    checks.push({ id, title, status, detail });
  const problems = validatePreviewDomainConfig(cfg);
  const errors = problems.filter((p) => p.severity === 'error');
  add(
    'config',
    'names obey the isolation rules',
    errors.length ? 'FAIL' : 'PASS',
    errors.length
      ? errors.map((p) => p.message).join(' | ')
      : `separate registrable domain ${registrableDomain(cfg.previewDomain)}${problems.length ? ` (warnings: ${problems.map((p) => p.code).join(', ')})` : ''}`,
  );
  if (errors.length) {
    for (const [id, title] of [
      ['dns', 'wildcard DNS resolves'],
      ['tls', 'certificate covers *.<domain>, valid ≥ 14 days, chain verifies'],
      ['isolation', 'the live edge isolates previews'],
    ] as const)
      add(id, title, 'NOT VERIFIED', 'skipped: the configuration is invalid');
    return { checks, verified: false };
  }
  const probeHost = `${randomToken()}.${cfg.previewDomain}`; // a name no preview owns: the edge must treat it exactly like any unknown token
  // 1. wildcard DNS
  if (!probes.resolve)
    add(
      'dns',
      'wildcard DNS resolves',
      'NOT VERIFIED',
      `no DNS probe supplied; B-DOMAIN is pending, so no record is assumed for *.${cfg.previewDomain}`,
    );
  else {
    try {
      const a = await probes.resolve(probeHost);
      add(
        'dns',
        'wildcard DNS resolves',
        a.length ? 'LIVE-VERIFIED' : 'LIVE-FAILED',
        a.length
          ? `${probeHost} -> ${a.slice(0, 3).join(', ')}`
          : `${probeHost} does not resolve: add a wildcard record for *.${cfg.previewDomain}`,
      );
    } catch (e) {
      add('dns', 'wildcard DNS resolves', 'LIVE-FAILED', `lookup failed: ${(e as Error).message}`);
    }
  }
  // 2. certificate
  if (!probes.tlsCertificate)
    add(
      'tls',
      'certificate covers *.<domain>, valid ≥ 14 days, chain verifies',
      'NOT VERIFIED',
      'no TLS probe supplied; no certificate is assumed to exist',
    );
  else {
    try {
      const c = await probes.tlsCertificate(probeHost);
      const days = (new Date(c.notAfter).getTime() - now().getTime()) / 86_400_000;
      const why = [
        certCovers(c.sans, probeHost)
          ? ''
          : `SANs [${c.sans.slice(0, 4).join(', ')}] do not cover ${probeHost}`,
        c.chainOk ? '' : 'the chain does not verify',
        days >= 14 ? '' : `expires in ${Math.floor(days)} days`,
      ].filter(Boolean);
      add(
        'tls',
        'certificate covers *.<domain>, valid ≥ 14 days, chain verifies',
        why.length ? 'LIVE-FAILED' : 'LIVE-VERIFIED',
        why.length ? why.join('; ') : `valid ${Math.floor(days)} more days`,
      );
    } catch (e) {
      add(
        'tls',
        'certificate covers *.<domain>, valid ≥ 14 days, chain verifies',
        'LIVE-FAILED',
        `handshake failed: ${(e as Error).message}`,
      );
    }
  }
  // 3. isolation as seen through the real edge
  if (!probes.get)
    add(
      'isolation',
      'the live edge isolates previews',
      'NOT VERIFIED',
      'no HTTP probe supplied; ADR-060 §8 network isolation is infrastructure and is not provable from code',
    );
  else {
    const url = (p: string) => `${cfg.scheme}://${probeHost}${p}`;
    const fails: string[] = [];
    try {
      const unknown = await probes.get(url('/'), {
        cookie: 'session=probe',
        authorization: 'Bearer probe',
      });
      if (unknown.status !== 404)
        fails.push(`an unknown token answered ${unknown.status}, not 404`);
      if (unknown.body !== 'not found') fails.push('the 404 body is not the uniform "not found"');
      const h = Object.fromEntries(
        Object.entries(unknown.headers).map(([k, v]) => [k.toLowerCase(), v]),
      );
      if ('set-cookie' in h) fails.push('the preview host sets cookies');
      if (Object.keys(h).some((k) => k.startsWith('access-control-')))
        fails.push('the preview host sends CORS headers');
      const api = await probes.get(url('/v1/me'));
      if (api.status !== 404)
        fails.push(`/v1/me on the preview host answered ${api.status}, not 404`);
      const health = await probes.get(url('/health'));
      if (health.status !== 404)
        fails.push(`/health on the preview host answered ${health.status}, not 404`);
      add(
        'isolation',
        'the live edge isolates previews',
        fails.length ? 'LIVE-FAILED' : 'LIVE-VERIFIED',
        fails.length
          ? fails.join('; ')
          : 'unknown token, API paths and cookies all handled as ADR-060 requires',
      );
    } catch (e) {
      add(
        'isolation',
        'the live edge isolates previews',
        'LIVE-FAILED',
        `request failed: ${(e as Error).message}`,
      );
    }
  }
  return {
    checks,
    verified: checks.every((c) => c.status === 'PASS' || c.status === 'LIVE-VERIFIED'),
  };
}
