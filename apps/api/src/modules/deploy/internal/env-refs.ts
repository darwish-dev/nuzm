/**
 * Environment variables of a deployment (Phase 2, Session 06): NAMES and VAULT REFERENCES only. Pure and offline.
 *
 * Rule (CLAUDE.md §4 Secrets): a deployment request, a deployment row, a log line, an audit event and an API response may carry the NAME of a variable and the
 * `vault://` reference of its value, never the value. The value is resolved by the target at the moment of use (a hosting node's environment channel, or the runtime's
 * secret mount) and is never written back. A static site has no runtime to receive variables: for `static_hosting` only PUBLIC build-time variables
 * (`PUBLIC_*`, which the build inlines into the output and which are therefore not secret) are accepted.
 */

export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const VAULT_REF = /^vault:\/\/[a-z0-9][a-z0-9/_.-]{2,199}$/;
/** the variables the platform or the runtime itself owns: a customer binding may never override them */
const RESERVED = new Set([
  'PATH',
  'HOME',
  'USER',
  'PWD',
  'SHELL',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_ENV',
  'PORT',
  'HOSTNAME',
]);
const RESERVED_PREFIX = ['NUZM_', 'AI_', 'DATABASE_', 'PG', 'AWS_', 'KUBERNETES_'];
/** shapes that look like a pasted secret value rather than a reference */
const SECRET_SHAPES: readonly RegExp[] = [
  /^sk-[A-Za-z0-9_-]{16,}/, // API-key style
  /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /^AKIA[0-9A-Z]{16}$/,
  /^[a-z]+:\/\/[^/\s:]+:[^@\s]+@/, // scheme://user:password@host
];

export interface EnvBinding {
  name: string;
  /** `vault://…` reference of the value */
  ref: string;
  /** public build-time variable: inlined into static output, so it must not be secret */
  public?: boolean;
}

export type EnvProblem =
  | { code: 'invalid_name'; name: string }
  | { code: 'reserved_name'; name: string }
  | { code: 'duplicate_name'; name: string }
  | { code: 'not_a_vault_ref'; name: string }
  | { code: 'looks_like_secret_value'; name: string }
  | { code: 'secret_in_static_target'; name: string }
  | { code: 'too_many'; name: string };

export const MAX_ENV_BINDINGS = 64;

/**
 * Validate a list of bindings for a target kind. Problems carry the variable NAME only: the offending input is never echoed (it may be a pasted secret).
 */
export function validateEnvBindings(
  input: unknown,
  targetKind: 'static_hosting' | 'isolated_runtime',
): { ok: true; bindings: EnvBinding[] } | { ok: false; problems: EnvProblem[] } {
  const problems: EnvProblem[] = [];
  if (!Array.isArray(input)) return { ok: true, bindings: [] };
  if (input.length > MAX_ENV_BINDINGS)
    return { ok: false, problems: [{ code: 'too_many', name: '*' }] };
  const seen = new Set<string>();
  const bindings: EnvBinding[] = [];
  for (const raw of input) {
    const b = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name : '';
    if (!ENV_NAME.test(name)) {
      problems.push({ code: 'invalid_name', name: name.slice(0, 64).replace(/[^\w]/g, '?') });
      continue;
    }
    if (RESERVED.has(name) || RESERVED_PREFIX.some((p) => name.startsWith(p))) {
      problems.push({ code: 'reserved_name', name });
      continue;
    }
    if (seen.has(name)) {
      problems.push({ code: 'duplicate_name', name });
      continue;
    }
    seen.add(name);
    const ref = typeof b.ref === 'string' ? b.ref : '';
    if (SECRET_SHAPES.some((re) => re.test(ref))) {
      problems.push({ code: 'looks_like_secret_value', name });
      continue;
    }
    if (!VAULT_REF.test(ref)) {
      problems.push({ code: 'not_a_vault_ref', name });
      continue;
    }
    const pub = b.public === true;
    if (targetKind === 'static_hosting' && !(pub && name.startsWith('PUBLIC_'))) {
      // a static site has no runtime: only an explicitly public build-time variable is meaningful, anything else would be inlined or silently ignored
      problems.push({ code: 'secret_in_static_target', name });
      continue;
    }
    bindings.push({ name, ref, ...(pub ? { public: true } : {}) });
  }
  return problems.length ? { ok: false, problems } : { ok: true, bindings };
}

/** What may be stored, logged or returned about the bindings: names and reference paths, never values (there are none here) and never anything that is not a binding. */
export function describeEnvBindings(
  bindings: readonly EnvBinding[],
): { name: string; ref: string }[] {
  return bindings.map((b) => ({ name: b.name, ref: b.ref }));
}

/** A stable digest input so the approval hash binds the NAMES and references, in a fixed order. */
export function envBindingsFingerprint(bindings: readonly EnvBinding[]): string {
  return [...bindings]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((b) => `${b.name}=${b.ref}${b.public ? ':public' : ''}`)
    .join('\n');
}

const REDACTED = '[redacted]';
/**
 * Redact a log line before it is stored: the value of any `NAME=value` where NAME looks like a secret, bearer tokens, URL credentials and anything shaped like a pasted
 * secret. Applied to build output and node output, which the platform does not control. Idempotent.
 */
export function redactLogLine(line: string): string {
  let s = line;
  s = s.replace(
    /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|KEY|CREDENTIAL|PRIVATE)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/g,
    `$1=${REDACTED}`,
  );
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`);
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s]+)@/gi, `$1${REDACTED}@`);
  s = s.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    REDACTED,
  );
  s = s.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED);
  s = s.replace(/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, REDACTED);
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED);
  return s;
}
