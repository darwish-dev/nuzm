/**
 * Pure helpers of the SSO connections screen (UI-M12-01). No I/O: unit-tested in `sso.spec.ts`. The API is the authority on every rule; these checks only
 * save a round trip. Response members that the SDK types loosely are narrowed with an allow-list: certificates and secrets are never read, kept or shown.
 */
import type { Schemas } from '@nuzm/sdk';

export const SSO_FLAG = 'enterprise.sso';
/** Roles just-in-time provisioning may assign: never an administrative role (the API refuses anything else too). */
export const JIT_ROLES = ['viewer', 'developer', 'billing_admin'] as const;
export type JitRole = (typeof JIT_ROLES)[number];

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export interface SsoDomain {
  domain: string;
  status: 'pending' | 'verified';
  txtName: string;
  txtValue: string | null;
  verifiedAt: string | null;
}
/** Domains with their DNS TXT proof status. `txtValue` is present only while a proof is pending. */
export function readDomains(raw: unknown): SsoDomain[] {
  return (Array.isArray(raw) ? raw : []).flatMap((x) => {
    const d = rec(x);
    const domain = str(d.domain);
    const txtName = str(d.txtName);
    if (!domain || !txtName) return [];
    return [
      {
        domain,
        status: d.status === 'verified' ? ('verified' as const) : ('pending' as const),
        txtName,
        txtValue: str(d.txtValue),
        verifiedAt: str(d.verifiedAt),
      },
    ];
  });
}

export function readJit(raw: unknown): { enabled: boolean; defaultRole: JitRole } {
  const j = rec(raw);
  const role = (JIT_ROLES as readonly string[]).includes(String(j.defaultRole))
    ? (j.defaultRole as JitRole)
    : 'viewer';
  return { enabled: j.enabled === true, defaultRole: role };
}

/** The public parts of a connection's configuration only (an allow-list): entity id, SSO URL, issuer, client id, and the NUMBER of signing certificates. */
export function readPublicConfig(raw: unknown): {
  entityId: string | null;
  ssoUrl: string | null;
  issuer: string | null;
  clientId: string | null;
  signingCertificates: number | null;
} {
  const c = rec(raw);
  return {
    entityId: str(c.entityId),
    ssoUrl: str(c.ssoUrl),
    issuer: str(c.issuer),
    clientId: str(c.clientId),
    signingCertificates: typeof c.signingCertificates === 'number' ? c.signingCertificates : null,
  };
}

/** Whether a test login has succeeded for the connection (the last stored result). The test login itself is not available yet (SCR-M12-05). */
export function testLoginSucceeded(raw: unknown): boolean {
  return rec(rec(raw).lastResult).ok === true;
}

/**
 * Enforcement can be turned ON only for an active connection with a verified domain AND a successful test login. Turning it OFF is always possible.
 * The API enforces the same (422 on the first request without a test login).
 */
export function canEnforce(c: {
  status: string;
  domains: SsoDomain[];
  testLogin: unknown;
}): boolean {
  return (
    c.status === 'active' &&
    c.domains.some((d) => d.status === 'verified') &&
    testLoginSucceeded(c.testLogin)
  );
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** "a.com, b.com ,, a.com" → ["a.com","b.com"] (lowercased, de-duplicated). */
export function splitDomains(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export interface SsoFields {
  protocol: 'saml' | 'oidc';
  name: string;
  domains: string;
  xml: string;
  metadataUrl: string;
  issuer: string;
  clientId: string;
  clientSecretRef: string;
  jitEnabled: boolean;
  jitRole: string;
}

const isHttps = (v: string) => {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

/** The body of a create request, or the name of the first invalid field. A secret VALUE can never be sent: only a `vault://` reference is accepted. */
export function createSsoBody(f: SsoFields): {
  body?: Schemas['SsoConnectionRequest'];
  error?: string;
} {
  const domains = splitDomains(f.domains);
  const name = f.name.trim();
  if (name.length < 1 || name.length > 120) return { error: 'name' };
  if (domains.length < 1 || domains.length > 10 || domains.some((d) => !DOMAIN.test(d)))
    return { error: 'domains' };
  if (!(JIT_ROLES as readonly string[]).includes(f.jitRole)) return { error: 'jitRole' };
  const base = {
    name,
    domains,
    jit: { enabled: f.jitEnabled, defaultRole: f.jitRole as JitRole },
  };
  if (f.protocol === 'saml') {
    const xml = f.xml.trim();
    const url = f.metadataUrl.trim();
    if ((xml === '') === (url === '')) return { error: 'metadata' }; // exactly one of the two
    if (url && !isHttps(url)) return { error: 'metadataUrl' };
    if (xml && !xml.startsWith('<')) return { error: 'xml' };
    return { body: { protocol: 'saml', ...base, ...(xml ? { xml } : { metadataUrl: url }) } };
  }
  if (!isHttps(f.issuer.trim())) return { error: 'issuer' };
  if (f.clientId.trim() === '' || f.clientId.trim().length > 200) return { error: 'clientId' };
  if (!/^vault:\/\/\S{1,300}$/.test(f.clientSecretRef.trim())) return { error: 'clientSecretRef' };
  return {
    body: {
      protocol: 'oidc',
      ...base,
      issuer: f.issuer.trim(),
      clientId: f.clientId.trim(),
      clientSecretRef: f.clientSecretRef.trim(),
    },
  };
}
