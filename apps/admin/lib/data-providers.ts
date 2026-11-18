/** Pure helpers of the admin data provider screen (UI-M08-15). No I/O: unit-tested in `data-providers.spec.ts`. */

export const SERVICES = [
  'database',
  'cache',
  'object-storage',
  'transactional-email',
  'mailbox',
] as const;
export const ENVIRONMENTS = ['local', 'staging', 'production'] as const;
export type Service = (typeof SERVICES)[number];
export type Environment = (typeof ENVIRONMENTS)[number];

export interface ProviderRow {
  id: string;
  service: string;
  family: string;
  providerCode: string;
  providerAccountId?: string | null;
  environment: Environment;
  enabled: boolean;
  verifiedAt?: string | null;
  evidenceRef?: string | null;
  adrRef?: string | null;
  adrAcceptedAt?: string | null;
  probe?: Record<string, unknown> | null;
  requestedBy?: string | null;
  approvedBy?: string | null;
  enabledAt?: string | null;
  blockers: string[];
  version: number;
}

/** A dev-reference provider (mock-*, local-*, environment=local) is a stand-in: NOT VERIFIED against any real service. */
export const isDevReference = (r: Pick<ProviderRow, 'environment' | 'providerCode'>) =>
  r.environment === 'local' || /^(mock|local)-/.test(r.providerCode);

/** What a stored probe says, safely read (the server stores `probedAt`, `evidenceKinds`, `passed`, `capabilities`). */
export function probeOf(p: Record<string, unknown> | null | undefined): {
  probedAt?: string;
  passed: boolean;
  evidenceKinds: string[];
  capabilities: [string, string][];
} | null {
  if (!p) return null;
  const caps =
    typeof p.capabilities === 'object' && p.capabilities !== null
      ? Object.entries(p.capabilities as Record<string, unknown>).map(
          ([k, v]) => [k, String(v)] as [string, string],
        )
      : [];
  return {
    probedAt: typeof p.probedAt === 'string' ? p.probedAt : undefined,
    passed: p.passed === true,
    evidenceKinds: Array.isArray(p.evidenceKinds) ? p.evidenceKinds.map(String) : [],
    capabilities: caps.sort(([a], [b]) => a.localeCompare(b)),
  };
}
export const capabilitySummary = (caps: [string, string][]) => ({
  supported: caps.filter(([, v]) => v === 'supported').length,
  total: caps.length,
});

export const ADR_REF = /^ADR-[0-9]{3}$/;
export const validAdr = (v: string) => ADR_REF.test(v.trim());
export const validEvidenceRef = (v: string) => v.trim().length >= 3 && v.trim().length <= 300;
const SECRET_KEY = /(secret|password|token|api_?key|private)/i;

/**
 * The body of a `configure` action. The config must be a JSON object; credentials are vault references only (`credentialRef: vault://...`), and any
 * secret-looking key is refused here as well as by the API.
 */
export function configureBody(f: {
  id?: string;
  service: string;
  family: string;
  providerCode: string;
  account: string;
  environment: string;
  adrRef: string;
  config: string;
}): {
  body?: Record<string, unknown>;
  error?: 'service' | 'family' | 'code' | 'environment' | 'adr' | 'config' | 'secret' | 'vault';
} {
  if (!(SERVICES as readonly string[]).includes(f.service)) return { error: 'service' };
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(f.family.trim())) return { error: 'family' };
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(f.providerCode.trim())) return { error: 'code' };
  if (!(ENVIRONMENTS as readonly string[]).includes(f.environment)) return { error: 'environment' };
  const dev = /^(mock|local)-/.test(f.providerCode.trim());
  if (dev !== (f.environment === 'local')) return { error: 'environment' };
  if (f.adrRef.trim() && !validAdr(f.adrRef)) return { error: 'adr' };
  let config: unknown = {};
  if (f.config.trim()) {
    try {
      config = JSON.parse(f.config);
    } catch {
      return { error: 'config' };
    }
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    return { error: 'config' };
  const c = config as Record<string, unknown>;
  for (const k of Object.keys(c))
    if (SECRET_KEY.test(k) && k !== 'credentialRef') return { error: 'secret' };
  if (
    c.credentialRef !== undefined &&
    !/^vault:\/\/[A-Za-z0-9][A-Za-z0-9._\-/]{1,200}$/.test(String(c.credentialRef))
  )
    return { error: 'vault' };
  const account = f.account.trim();
  return {
    body: {
      action: 'configure',
      ...(f.id ? { id: f.id } : {}),
      service: f.service,
      family: f.family.trim(),
      providerCode: f.providerCode.trim(),
      providerAccountId: account || null,
      environment: f.environment,
      ...(f.adrRef.trim() ? { adrRef: f.adrRef.trim() } : {}),
      config: c,
    },
  };
}

/** `datetime-local` text (no zone) → the RFC 3339 instant the API expects; null when empty, invalid or in the future. */
export function verifiedAtIso(local: string, now = Date.now()): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime()) || d.getTime() > now + 60_000) return null;
  return d.toISOString();
}

/**
 * Why a control is unavailable to the current person (shown instead of hiding it), or null when it can be used. The API stays the authority;
 * this only avoids offering an action that is certain to be refused.
 */
export function enableBlock(
  r: ProviderRow,
  me: { id: string; can: (p: string) => boolean },
): 'no_permission' | 'two_person' | 'blocked' | null {
  if (!me.can('admin:data:approve')) return 'no_permission';
  if (r.environment !== 'local' && r.requestedBy && r.requestedBy === me.id) return 'two_person';
  const hard = r.blockers.filter(
    (b) =>
      b !== 'second_approver_missing' &&
      !(r.environment === 'local' && b === 'enable_not_requested'),
  );
  return hard.length > 0 ? 'blocked' : null;
}
