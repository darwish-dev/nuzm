/**
 * AI Studio S-A1 (ADR-064, proposed): the manifest of a Skill — the front matter of its `SKILL.md`.
 * `name` and `description` are what Claude Code itself reads; the other keys are Nuzm registry metadata. The parser accepts a small,
 * safe YAML subset (scalars, inline `[a, b]` lists, `- item` block lists); it never evaluates anything, so a hostile manifest can only
 * fail validation.
 */
export type SkillCategory =
  | 'architecture'
  | 'code-quality'
  | 'testing'
  | 'security'
  | 'performance'
  | 'documentation'
  | 'frontend'
  | 'backend'
  | 'mobile'
  | 'business'
  | 'design';
export const SKILL_CATEGORIES: readonly SkillCategory[] = [
  'architecture',
  'code-quality',
  'testing',
  'security',
  'performance',
  'documentation',
  'frontend',
  'backend',
  'mobile',
  'business',
  'design',
];

export interface SkillManifest {
  /** lowercase letters, digits and hyphens, ≤ 64 (the Claude Code skill-name rule) */
  name: string;
  /** what the skill does and when to use it, ≤ 1024 characters */
  description: string;
  category?: SkillCategory;
  frameworks: string[];
  languages: string[];
  industries: string[];
  /** other skills (by name) this one needs */
  requires: string[];
  version?: string;
  /** SPDX identifier as declared by the author; verified by a person before publication */
  license?: string;
}
export interface SkillManifestError {
  field: string;
  message: string;
}
export type SkillManifestResult =
  { ok: true; manifest: SkillManifest; body: string } | { ok: false; errors: SkillManifestError[] };

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TAG = /^[a-z0-9][a-z0-9.+#-]{0,39}$/;
const MAX_MANIFEST_CHARS = 8_000;

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1);
  return t;
}

/** `key: value` pairs, `key: [a, b]` and `key:` followed by `- item` lines. Anything else is an error, not a guess. */
function parseFrontMatter(src: string): {
  data: Record<string, string | string[]>;
  errors: SkillManifestError[];
} {
  const data: Record<string, string | string[]> = {};
  const errors: SkillManifestError[] = [];
  let listKey: string | null = null;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) {
      errors.push({ field: 'front-matter', message: `unsupported line: ${line.slice(0, 60)}` });
      listKey = null;
      continue;
    }
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (key in data) errors.push({ field: key, message: 'duplicate key' });
    if (value === '') {
      data[key] = [];
      listKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map(unquote)
        .filter((x) => x !== '');
      listKey = null;
    } else {
      data[key] = unquote(value);
      listKey = null;
    }
  }
  return { data, errors };
}

const asList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** Parses a `SKILL.md` (front matter between `---` lines, then the body) and validates the manifest. */
export function parseSkillManifest(skillMd: string): SkillManifestResult {
  const text = skillMd.replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m)
    return { ok: false, errors: [{ field: 'front-matter', message: 'missing --- front matter' }] };
  if (m[1]!.length > MAX_MANIFEST_CHARS)
    return { ok: false, errors: [{ field: 'front-matter', message: 'front matter is too long' }] };
  const { data, errors } = parseFrontMatter(m[1]!);

  const one = (k: string): string | undefined => {
    const v = data[k];
    if (Array.isArray(v)) {
      if (v.length) errors.push({ field: k, message: 'must be a single value' });
      return undefined;
    }
    return v;
  };
  const name = one('name');
  const description = one('description');
  if (!name) errors.push({ field: 'name', message: 'required' });
  else if (name.length > 64 || !NAME.test(name))
    errors.push({ field: 'name', message: 'lowercase letters, digits and hyphens, at most 64' });
  if (!description) errors.push({ field: 'description', message: 'required' });
  else if (description.length > 1024)
    errors.push({ field: 'description', message: 'at most 1024 characters' });

  const category = one('category');
  if (category !== undefined && !SKILL_CATEGORIES.includes(category as SkillCategory))
    errors.push({ field: 'category', message: 'unknown category' });
  const version = one('version');
  if (version !== undefined && !SEMVER.test(version))
    errors.push({ field: 'version', message: 'must be semantic (1.2.3)' });

  const tags = (k: string): string[] => {
    const list = asList(data[k]).map((x) => x.toLowerCase());
    for (const x of list)
      if (!TAG.test(x)) errors.push({ field: k, message: `invalid value "${x.slice(0, 40)}"` });
    return [...new Set(list)];
  };
  const frameworks = tags('frameworks');
  const languages = tags('languages');
  const industries = tags('industries');
  const requires = asList(data.requires);
  for (const r of requires)
    if (!NAME.test(r) || r.length > 64)
      errors.push({ field: 'requires', message: `invalid skill name "${r.slice(0, 40)}"` });
  if (name && requires.includes(name))
    errors.push({ field: 'requires', message: 'a skill cannot require itself' });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    body: m[2]!,
    manifest: {
      name: name!,
      description: description!,
      ...(category ? { category: category as SkillCategory } : {}),
      frameworks,
      languages,
      industries,
      requires: [...new Set(requires)],
      ...(version ? { version } : {}),
      ...(one('license') ? { license: one('license') } : {}),
    },
  };
}
