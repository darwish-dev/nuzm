/**
 * A deterministic Content-Security-Policy evaluator for the QA gate: it checks that a policy is strict and that every resource a page references is allowed by it
 * (so a page that would be blocked in a real browser fails here, without a browser). Covers the directives a static site uses: default-src, script-src, style-src,
 * img-src, font-src, connect-src, media-src, frame-src, form-action, base-uri, object-src. Source expressions: 'self', 'none', scheme (`data:`), host sources.
 */
export type CspDirectives = Map<string, string[]>;

export function parseCsp(policy: string): CspDirectives {
  const out: CspDirectives = new Map();
  for (const part of policy.split(';')) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    const name = toks.shift()?.toLowerCase();
    if (name && !out.has(name)) out.set(name, toks);
  }
  return out;
}

/** What a policy must not contain for a generated site (no model- or user-authored script or style is ever served: ADR-060 §7). */
export function strictnessProblems(policy: string): string[] {
  const d = parseCsp(policy);
  const out: string[] = [];
  if (!d.has('default-src')) out.push("default-src is missing (it must be 'self')");
  else if (d.get('default-src')!.join(' ') !== "'self'")
    out.push(`default-src must be 'self', got ${d.get('default-src')!.join(' ') || '(empty)'}`);
  for (const [name, srcs] of d)
    for (const s of srcs) {
      if (s === "'unsafe-inline'" || s === "'unsafe-eval'" || s === "'unsafe-hashes'")
        out.push(`${name} allows ${s}`);
      if (s === '*' || s === 'http:' || s === 'https:' || s === 'blob:' || s === 'filesystem:')
        out.push(`${name} allows the broad source ${s}`);
      if (/^https?:\/\/\*/.test(s)) out.push(`${name} allows the wildcard host ${s}`);
      if (/^http:\/\//i.test(s) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$|\/)/.test(s))
        out.push(`${name} allows the insecure origin ${s}`);
    }
  if (d.get('base-uri')?.join(' ') !== "'none'") out.push("base-uri must be 'none'");
  const fa = d.get('form-action');
  if (!fa) out.push("form-action is missing (it must be 'self' plus at most the forms origin)");
  return out;
}

const FETCH_FALLBACK: Record<string, string[]> = {
  'script-src': ['script-src', 'default-src'],
  'style-src': ['style-src', 'default-src'],
  'img-src': ['img-src', 'default-src'],
  'font-src': ['font-src', 'default-src'],
  'connect-src': ['connect-src', 'default-src'],
  'media-src': ['media-src', 'default-src'],
  'frame-src': ['frame-src', 'child-src', 'default-src'],
  'object-src': ['object-src', 'default-src'],
  'form-action': ['form-action'],
};

/** Is `url` (absolute, or relative to the page: then same-origin) allowed for `directive` on a page served from `pageOrigin`? Absent `form-action` allows everything (no fallback). */
export function cspAllows(
  policy: CspDirectives,
  directive: keyof typeof FETCH_FALLBACK,
  url: string,
  pageOrigin = 'https://site.invalid',
): boolean {
  const chain = FETCH_FALLBACK[directive] ?? [directive];
  let srcs: string[] | undefined;
  for (const name of chain) {
    srcs = policy.get(name);
    if (srcs) break;
  }
  if (!srcs) return directive === 'form-action';
  if (srcs.length === 0 || srcs.includes("'none'")) return false;
  let u: URL;
  try {
    u = new URL(url, pageOrigin);
  } catch {
    return false;
  }
  const page = new URL(pageOrigin);
  for (const s of srcs) {
    if (s === "'self'") {
      if (u.origin === page.origin) return true;
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:$/i.test(s)) {
      if (u.protocol.toLowerCase() === s.toLowerCase()) return true;
      continue;
    }
    if (s === '*') return true;
    try {
      const o = new URL(s);
      if (o.origin === u.origin) return true;
    } catch {
      /* host-source without scheme: not used by our policies */
    }
  }
  return false;
}
