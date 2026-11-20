/**
 * AI Studio S-A1 (ADR-064, proposed): which Skills a project should get. Compatibility-based, never "install everything":
 * a skill is RECOMMENDED when its scope matches the project; it is INSTALLED AUTOMATICALLY only when it is also approved, scanned
 * clean, ships no executable files and every skill it requires is installable too. Everything else is listed with the reason.
 */
export type SkillScope = 'global' | 'framework' | 'language' | 'template' | 'industry' | 'customer';
export interface SkillCatalogEntry {
  slug: string;
  version: string;
  scope: SkillScope;
  frameworks: readonly string[];
  languages: readonly string[];
  industries: readonly string[];
  requires: readonly string[];
  approval: 'approved' | 'pending' | 'rejected' | 'disabled';
  scan: 'clean' | 'review' | 'reject';
  executable: boolean;
}
export interface SkillProjectProfile {
  frameworks: readonly string[];
  languages: readonly string[];
  industry?: string;
  /** default skills of the template the project was created from */
  templateSkills?: readonly string[];
  /** skills the customer asked for explicitly (still subject to approval and scan) */
  requested?: readonly string[];
  /** allow executable skills the customer explicitly asked for */
  allowExecutableRequested?: boolean;
}
export type SkillBlockReason =
  | 'not_approved'
  | 'scan_not_clean'
  | 'executable_needs_opt_in'
  | 'missing_dependency'
  | 'dependency_blocked'
  | 'dependency_cycle'
  | 'unknown_skill';
export interface SkillResolution {
  /** auto-installable skills, dependencies first */
  install: string[];
  /** recommended but not installed automatically, with the reason */
  blocked: { slug: string; reason: SkillBlockReason; detail?: string }[];
  /** why each installed skill was chosen */
  reasons: Record<string, string>;
}

const norm = (xs: readonly string[] | undefined) => new Set((xs ?? []).map((x) => x.toLowerCase()));

function matchReason(e: SkillCatalogEntry, p: SkillProjectProfile): string | null {
  const fw = norm(p.frameworks);
  const lang = norm(p.languages);
  if (p.requested?.includes(e.slug)) return 'requested by the customer';
  if (p.templateSkills?.includes(e.slug)) return 'default of the project template';
  switch (e.scope) {
    case 'global':
      return 'platform baseline';
    case 'framework':
      return e.frameworks.some((f) => fw.has(f.toLowerCase()))
        ? `framework: ${e.frameworks.join(', ')}`
        : null;
    case 'language':
      return e.languages.some((l) => lang.has(l.toLowerCase()))
        ? `language: ${e.languages.join(', ')}`
        : null;
    case 'industry':
      return p.industry && e.industries.some((i) => i.toLowerCase() === p.industry!.toLowerCase())
        ? `industry: ${p.industry}`
        : null;
    case 'template':
    case 'customer':
      return null; // only by template defaults or an explicit request
  }
}

/** Resolves the skill set of a project against the catalog (latest entry per slug is the one given). */
export function resolveSkills(
  catalog: readonly SkillCatalogEntry[],
  profile: SkillProjectProfile,
): SkillResolution {
  const bySlug = new Map(catalog.map((e) => [e.slug, e]));
  const reasons: Record<string, string> = {};
  const blocked = new Map<string, { reason: SkillBlockReason; detail?: string }>();

  const wanted: string[] = [];
  for (const e of catalog) {
    const why = matchReason(e, profile);
    if (why) {
      wanted.push(e.slug);
      reasons[e.slug] = why;
    }
  }
  for (const s of [...(profile.templateSkills ?? []), ...(profile.requested ?? [])])
    if (!bySlug.has(s) && !blocked.has(s)) blocked.set(s, { reason: 'unknown_skill' });

  const own = (e: SkillCatalogEntry): SkillBlockReason | null => {
    if (e.approval !== 'approved') return 'not_approved';
    if (e.scan !== 'clean') return 'scan_not_clean';
    if (e.executable && !(profile.allowExecutableRequested && profile.requested?.includes(e.slug)))
      return 'executable_needs_opt_in';
    return null;
  };

  // depth-first over `requires`; a skill is installable only if it and its whole closure are
  const state = new Map<string, 'visiting' | 'ok' | 'bad'>();
  const order: string[] = [];
  const visit = (slug: string, path: string[]): boolean => {
    const st = state.get(slug);
    if (st === 'ok') return true;
    if (st === 'bad') return false;
    if (st === 'visiting') {
      blocked.set(slug, { reason: 'dependency_cycle', detail: [...path, slug].join(' → ') });
      return false;
    }
    const e = bySlug.get(slug);
    if (!e) {
      state.set(slug, 'bad');
      return false;
    }
    state.set(slug, 'visiting');
    const ownBlock = own(e);
    let ok = ownBlock === null;
    if (ownBlock) blocked.set(slug, { reason: ownBlock });
    for (const dep of e.requires) {
      if (!bySlug.has(dep)) {
        if (!blocked.has(slug)) blocked.set(slug, { reason: 'missing_dependency', detail: dep });
        ok = false;
        continue;
      }
      if (!visit(dep, [...path, slug])) {
        if (!blocked.has(slug)) blocked.set(slug, { reason: 'dependency_blocked', detail: dep });
        ok = false;
      }
    }
    state.set(slug, ok ? 'ok' : 'bad');
    if (ok) {
      order.push(slug);
      reasons[slug] ??= 'required by another skill';
    }
    return ok;
  };
  for (const s of wanted) visit(s, []);

  const install = order.filter((s, i) => order.indexOf(s) === i);
  for (const k of Object.keys(reasons)) if (!install.includes(k)) delete reasons[k];
  return {
    install,
    blocked: [...blocked]
      .map(([slug, b]) => ({ slug, ...b }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    reasons,
  };
}
