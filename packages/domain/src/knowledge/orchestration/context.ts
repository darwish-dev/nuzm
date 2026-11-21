import type { Schema } from '../../schema';

/**
 * Context assembly (S-K6): the bounded, ordered material a model receives when it adapts a copied template to a requirement. Pure and deterministic, so the customer can be
 * shown EXACTLY what would be sent (the preview endpoint) and so the golden tests pin it.
 *
 * Rules (AUDIT_AND_PLAN §4 and §6 rule 5):
 *  - Priority, highest first: the platform's policy for the adaptation mode (trusted, code), the customer's requirement, template facts, the workspace index, then file contents.
 *    Retrieved or project text is ALWAYS data (the run engine wraps every block in its untrusted-content fence); it never outranks an instruction.
 *  - Source of a template is sent to a model only when the template's permission allows AI processing: contents of files that are still the template's (unchanged since the
 *    copy) are withheld otherwise; only paths and sizes are sent. The customer's own work (added or modified files) is always eligible.
 *  - Everything is bounded: a token budget for the whole pack, a cap per file, a cap on the number of files; whatever does not fit is listed as excluded with the reason,
 *    never silently dropped. Token counts are an approximation (characters / 3, deliberately pessimistic for Arabic and code), not a billing figure.
 */
export type AdaptationMode = 'STRICT' | 'ADAPTIVE' | 'CREATIVE';
export type BlockKind = 'requirement' | 'template' | 'file_index' | 'file';
export type ExcludeReason =
  'ai_processing_not_allowed' | 'too_large' | 'over_budget' | 'too_many_files' | 'not_text';

export const CONTEXT_LIMITS = {
  /** default token budget of a pack */
  budgetTokens: 12_000,
  maxBudgetTokens: 60_000,
  /** a file longer than this is not sent whole */
  maxFileChars: 16_000,
  maxFiles: 40,
  /** entries of the workspace index */
  maxIndexEntries: 400,
  maxRequirementChars: 4_000,
} as const;

export const approxTokens = (s: string): number => Math.ceil(s.length / 3);

export interface WorkspaceFile {
  path: string;
  bytes: number;
  /** still byte-identical to the template's file (a baseline file the customer has not touched) */
  origin: 'template' | 'customer';
}
export interface ContextInput {
  requirement: { text: string | null; platform?: string | null; frameworks?: string[] };
  mode: AdaptationMode;
  template: {
    name: string;
    description: string | null;
    capabilities: string[];
    license: string | null;
    design?: { modes: string[]; roles: { role: string; hex: string }[]; families: string[] } | null;
  } | null;
  /** the template's `ai_processing` permission */
  aiProcessing: boolean;
  files: readonly WorkspaceFile[];
  /** text of the files that may be sent (path → content); a path missing here is not text */
  contents: ReadonlyMap<string, string>;
  budgetTokens?: number;
}
export interface ContextBlock {
  kind: BlockKind;
  /** the short label of the data block (the path of a file is in the text, not the label) */
  label: string;
  text: string;
  tokens: number;
}
export interface AssembledContext {
  /** trusted, from code: the instruction for the mode */
  policy: string;
  blocks: ContextBlock[];
  tokens: { used: number; budget: number };
  excluded: { path: string; reason: ExcludeReason }[];
  /** the files whose content is in the pack */
  included: string[];
  notes: string[];
}

export const MODE_POLICY: Record<AdaptationMode, string> = {
  STRICT:
    'Adaptation mode STRICT: keep the template as it is. Add or modify only what the requirement needs. Never delete or rename a template file and never change a dependency version.',
  ADAPTIVE:
    'Adaptation mode ADAPTIVE: adapt the template to the requirement while keeping its architecture and design tokens. Delete only files that are clearly unused by the result.',
  CREATIVE:
    'Adaptation mode CREATIVE: the template is a starting point; you may restructure it freely to fit the requirement.',
};

const clean = (s: string, max: number) =>
  // eslint-disable-next-line no-control-regex -- control characters are removed on purpose
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);

const CONFIG =
  /(^|\/)(package\.json|tsconfig[^/]*\.json|next\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|pubspec\.yaml|vite\.config\.[cm]?[jt]s)$/;
const ENTRY =
  /(^|\/)(app\/(layout|page)|pages\/(_app|index)|src\/(main|index|app)|main|index)\.[cm]?[jt]sx?$/;

/** Higher first. Customer work, then configuration, then entry points, then the rest; ties by path. */
function rank(f: WorkspaceFile): number {
  return (
    (f.origin === 'customer' ? 100 : 0) +
    (CONFIG.test(f.path) ? 20 : 0) +
    (ENTRY.test(f.path) ? 10 : 0)
  );
}

export function assembleContext(input: ContextInput): AssembledContext {
  const budget = Math.max(
    1_000,
    Math.min(CONTEXT_LIMITS.maxBudgetTokens, input.budgetTokens ?? CONTEXT_LIMITS.budgetTokens),
  );
  const blocks: ContextBlock[] = [];
  const excluded: AssembledContext['excluded'] = [];
  const notes: string[] = [];
  let used = 0;
  const push = (kind: BlockKind, label: string, text: string): boolean => {
    const tokens = approxTokens(text);
    if (used + tokens > budget) return false;
    blocks.push({ kind, label, text, tokens });
    used += tokens;
    return true;
  };

  // 1. the customer's requirement (data)
  const r = input.requirement;
  const req = [
    r.text
      ? `Requirement:\n${clean(r.text, CONTEXT_LIMITS.maxRequirementChars)}`
      : 'Requirement: (none given)',
    r.platform ? `Platform: ${clean(r.platform, 30)}` : '',
    r.frameworks?.length
      ? `Frameworks: ${r.frameworks
          .slice(0, 10)
          .map((x) => clean(x, 40))
          .join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  push('requirement', 'requirement', req);

  // 2. template facts (metadata, never source)
  if (input.template) {
    const t = input.template;
    const lines = [
      `Template: ${clean(t.name, 120)}`,
      t.description ? `Description: ${clean(t.description, 400)}` : '',
      t.license ? `License: ${clean(t.license, 40)}` : '',
      t.capabilities.length
        ? `Capabilities: ${t.capabilities
            .slice(0, 30)
            .map((c) => clean(c, 60))
            .join(', ')}`
        : '',
      t.design?.families.length
        ? `Fonts: ${t.design.families
            .slice(0, 4)
            .map((c) => clean(c, 40))
            .join(', ')}`
        : '',
      t.design?.roles.length
        ? `Role colours: ${t.design.roles
            .slice(0, 12)
            .map((c) => `${clean(c.role, 20)} ${clean(c.hex, 12)}`)
            .join(', ')}`
        : '',
    ].filter(Boolean);
    push('template', 'template', lines.join('\n'));
  }

  // 3. the workspace index: every path with its size and who wrote it (bounded)
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const index = files.slice(0, CONTEXT_LIMITS.maxIndexEntries);
  if (files.length > index.length) notes.push(`index_truncated:${files.length}`);
  push(
    'file_index',
    'workspace',
    `Project files (${files.length}). Format: path | bytes | written by\n` +
      index.map((f) => `${clean(f.path, 300)} | ${f.bytes} | ${f.origin}`).join('\n'),
  );

  // 4. file contents, by priority, within the budget
  const ranked = [...files].sort((a, b) => rank(b) - rank(a) || (a.path < b.path ? -1 : 1));
  const included: string[] = [];
  let sent = 0;
  for (const f of ranked) {
    if (f.origin === 'template' && !input.aiProcessing) {
      excluded.push({ path: f.path, reason: 'ai_processing_not_allowed' });
      continue;
    }
    const text = input.contents.get(f.path);
    if (text === undefined) {
      excluded.push({ path: f.path, reason: 'not_text' });
      continue;
    }
    if (text.length > CONTEXT_LIMITS.maxFileChars) {
      excluded.push({ path: f.path, reason: 'too_large' });
      continue;
    }
    if (sent >= CONTEXT_LIMITS.maxFiles) {
      excluded.push({ path: f.path, reason: 'too_many_files' });
      continue;
    }
    if (!push('file', `file-${sent + 1}`, `path: ${clean(f.path, 300)}\n${text}`)) {
      excluded.push({ path: f.path, reason: 'over_budget' });
      continue;
    }
    included.push(f.path);
    sent++;
  }
  if (!input.aiProcessing && files.some((f) => f.origin === 'template'))
    notes.push('template_contents_withheld');
  return {
    policy: MODE_POLICY[input.mode],
    blocks,
    tokens: { used, budget },
    excluded,
    included,
    notes,
  };
}

/* ───────────── the model's answer: patches against the workspace ───────────── */

export const ADAPT_MAX_PATCHES = 40;
export const ADAPT_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'patches'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 1000 },
    patches: {
      type: 'array',
      maxItems: ADAPT_MAX_PATCHES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'path'],
        properties: {
          op: { enum: ['add', 'modify', 'delete'] },
          path: { type: 'string', minLength: 1, maxLength: 300 },
          content: { type: 'string', maxLength: 200_000 },
        },
      },
    },
  },
};

export interface ProposedPatch {
  op: 'add' | 'modify' | 'delete';
  path: string;
  content?: string;
}

const depsOf = (json: string): Record<string, string> | null => {
  try {
    const p = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies'])
      for (const [n, v] of Object.entries((p[k] ?? {}) as Record<string, unknown>))
        out[`${k}:${n}`] = String(v);
    return out;
  } catch {
    return null;
  }
};

/**
 * Static check of a proposed change set against the workspace and the adaptation mode (no execution). The messages go back to the model through the repair loop, so it can
 * fix its own answer; the same checks run again, deterministically, before anything is applied.
 */
export function checkProposal(
  mode: AdaptationMode,
  patches: readonly ProposedPatch[],
  workspace: ReadonlyMap<string, string>,
  baseline: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of patches) {
    if (seen.has(p.path)) out.push(`${p.path} appears twice`);
    seen.add(p.path);
    if (p.op === 'add' && workspace.has(p.path)) out.push(`${p.path} already exists (use modify)`);
    if (p.op !== 'add' && !workspace.has(p.path)) out.push(`${p.path} does not exist`);
    if (p.op !== 'delete' && typeof p.content !== 'string') out.push(`${p.path} needs content`);
    if (p.op === 'delete' && p.content !== undefined)
      out.push(`${p.path}: a delete has no content`);
  }
  const baselineDeletes = patches.filter(
    (p) => p.op === 'delete' && Object.hasOwn(baseline, p.path),
  );
  if (mode === 'STRICT') {
    for (const p of baselineDeletes)
      out.push(`STRICT mode: ${p.path} is a template file and cannot be deleted`);
    for (const p of patches)
      if (p.op === 'modify' && /(^|\/)package\.json$/.test(p.path)) {
        const before = depsOf(workspace.get(p.path) ?? '');
        const after = depsOf(p.content ?? '');
        if (before && after)
          for (const [k, v] of Object.entries(before))
            if (after[k] !== v)
              out.push(`STRICT mode: ${p.path} changes or removes dependency ${k.split(':')[1]}`);
      }
  } else if (mode === 'ADAPTIVE') {
    const limit = Math.max(1, Math.floor(Object.keys(baseline).length * 0.2));
    if (baselineDeletes.length > limit)
      out.push(
        `ADAPTIVE mode: at most ${limit} template files may be deleted, ${baselineDeletes.length} proposed`,
      );
  }
  return out.slice(0, 12);
}
