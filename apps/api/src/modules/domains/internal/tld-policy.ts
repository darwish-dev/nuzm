import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { TldSupport } from '@nuzm/registrar-contracts';

/**
 * TLD sales policy loader and evaluator (spec/providers/tld-policy.yaml). Fail closed: a TLD that is not listed, not enabled, restricted without
 * evidence, or Saudi without evidence is BLOCKED at quote time. A malformed file stops the process.
 */
export interface TldPolicyEntry {
  tld: string;
  enabled: boolean;
  evidenceRef: string | null;
  note: string | null;
}
export interface TldPolicy {
  version: number;
  status: string;
  /** Changes whenever the file changes: stored with every eligibility evaluation. */
  ruleSetVersion: string;
  alwaysRestricted: string[];
  entries: Map<string, TldPolicyEntry>;
}

export const TLD_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

export function parseTldPolicy(text: string): TldPolicy {
  const fail = (m: string): never => {
    throw new Error(`tld policy: ${m}`);
  };
  const raw = parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return fail('not a mapping');
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1)
    fail('version must be a positive integer');
  if (typeof raw.status !== 'string') fail('status is required');
  const always = Array.isArray(raw.always_restricted_suffixes)
    ? (raw.always_restricted_suffixes as unknown[]).map((x) => String(x).toLowerCase())
    : fail('always_restricted_suffixes is required');
  if (!Array.isArray(raw.tlds)) fail('tlds must be a list');
  const entries = new Map<string, TldPolicyEntry>();
  for (const e of raw.tlds as Record<string, unknown>[]) {
    const tld = typeof e.tld === 'string' ? e.tld.toLowerCase() : '';
    if (!TLD_RE.test(tld)) fail(`bad tld ${JSON.stringify(e.tld)}`);
    if (entries.has(tld)) fail(`duplicate tld ${tld}`);
    if (typeof e.enabled !== 'boolean') fail(`${tld}: enabled must be true or false`);
    const evidenceRef =
      typeof e.evidence_ref === 'string' && e.evidence_ref.trim() !== ''
        ? e.evidence_ref.trim()
        : null;
    if (isSaudi(tld, always) && (e.enabled as unknown) === true && !evidenceRef)
      fail(`${tld}: a Saudi/restricted TLD cannot be enabled without evidence_ref (HG-07-02)`);
    entries.set(tld, {
      tld,
      enabled: e.enabled as boolean,
      evidenceRef,
      note: typeof e.note === 'string' ? e.note : null,
    });
  }
  const ruleSetVersion = `v${raw.version as number}-${simpleHash(JSON.stringify([...entries.values()]) + always.join(','))}`;
  return {
    version: raw.version as number,
    status: raw.status as string,
    ruleSetVersion,
    alwaysRestricted: always,
    entries,
  };
}

function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}
export const isSaudi = (tld: string, always: string[]) =>
  always.some((s) => tld === s || tld.endsWith(`.${s}`));

/** `TLD_POLICY_PATH`, else spec/providers/tld-policy.yaml found by walking up from this file or the working directory. */
export function loadTldPolicy(path = process.env.TLD_POLICY_PATH): TldPolicy {
  if (path) return parseTldPolicy(readFileSync(resolve(path), 'utf8'));
  for (let d = __dirname, i = 0; i < 12; i++, d = dirname(d)) {
    const f = join(d, 'spec/providers/tld-policy.yaml');
    if (existsSync(f)) return parseTldPolicy(readFileSync(f, 'utf8'));
  }
  const f = join(process.cwd(), 'spec/providers/tld-policy.yaml');
  if (existsSync(f)) return parseTldPolicy(readFileSync(f, 'utf8'));
  throw new Error('tld policy: spec/providers/tld-policy.yaml not found');
}

export type PolicyOutcome =
  | { result: 'allowed'; rule: string; reason: string; evidence: Record<string, unknown> }
  | {
      result: 'blocked';
      rule: string;
      reason: string;
      errorCode: 'unsupported_capability' | 'eligibility_blocked';
      evidence: Record<string, unknown>;
    };

export type DomainAction = 'register' | 'renew' | 'transfer_in';

/**
 * The platform's own decision for a TLD, given what the registrar account's probe said (`support`, undefined = the account does not list the TLD).
 * Blocked results carry the HTTP-facing error code: capability/policy absence is `unsupported_capability`; a registry rule the platform cannot
 * satisfy for this registrant is `eligibility_blocked` (decided later by the registrant-level rules).
 */
export function evaluateTld(
  policy: TldPolicy,
  tld: string,
  action: DomainAction,
  support: TldSupport | undefined,
): PolicyOutcome {
  const base = { tld, ruleSetVersion: policy.ruleSetVersion, action };
  const block = (
    rule: string,
    reason: string,
    errorCode: 'unsupported_capability' | 'eligibility_blocked' = 'unsupported_capability',
  ): PolicyOutcome => ({
    result: 'blocked',
    rule,
    reason,
    errorCode,
    evidence: base,
  });
  const entry = policy.entries.get(tld);
  const saudi = isSaudi(tld, policy.alwaysRestricted);
  if (!entry)
    return block(
      saudi ? 'policy.saudi_absent' : 'policy.not_in_portfolio',
      saudi
        ? 'unsupported: Saudi TLD routes are not enabled (HG-07-02, D-19)'
        : 'unsupported: this TLD is not in the sales portfolio',
    );
  if (!entry.enabled)
    return block('policy.disabled', 'unsupported: the TLD is switched off in the policy');
  if (saudi && !entry.evidenceRef)
    return block(
      'policy.saudi_no_evidence',
      'unsupported: Saudi TLD without recorded HG-07-02 evidence',
    );
  if (!support)
    return block(
      'registrar.not_listed',
      'unsupported: no verified registrar account lists this TLD',
    );
  const cap =
    action === 'register'
      ? support.register
      : action === 'renew'
        ? support.renew
        : support.transfer;
  if (cap !== 'supported')
    return block(
      `registrar.${action}_${cap}`,
      `unsupported: the registrar does not support ${action.replace('_', ' ')} for this TLD (${cap})`,
    );
  if ((support.restricted || support.eligibilityRules === 'registry') && !entry.evidenceRef)
    return block(
      'policy.restricted_no_evidence',
      'unsupported: the registry has eligibility rules and no eligibility route is recorded for this TLD',
    );
  return {
    result: 'allowed',
    rule: 'policy.allowed',
    reason: 'enabled in the policy and supported by a verified registrar account',
    evidence: { ...base, evidenceRef: entry.evidenceRef },
  };
}
