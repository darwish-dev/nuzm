/**
 * AI Studio S-A1 (ADR-064, proposed): composes a project's `CLAUDE.md` from instruction layers.
 * Precedence, lowest first: platform < framework < template < project < customer. A higher layer replaces a lower layer's rule with
 * the same key — except that a SECURITY rule can never be weakened (stricter wins), and every replacement or contradiction is
 * REPORTED instead of silently concatenated. Text the customer writes inside the customer block survives regeneration verbatim.
 */
export type InstructionSource = 'platform' | 'framework' | 'template' | 'project' | 'customer';
export const INSTRUCTION_PRECEDENCE: readonly InstructionSource[] = [
  'platform',
  'framework',
  'template',
  'project',
  'customer',
];
export type RuleStrength = 'must' | 'should' | 'never' | 'may';
export interface InstructionRule {
  /** stable identity for override/conflict detection, e.g. `ui.rtl`; rules without a key are only added */
  key?: string;
  text: string;
  strength: RuleStrength;
  /** security rules cannot be weakened by a higher layer */
  security?: boolean;
}
export interface InstructionSection {
  id: string;
  title: string;
  rules: InstructionRule[];
}
export interface InstructionLayer {
  source: InstructionSource;
  sections: InstructionSection[];
}
export interface ComposedRule extends InstructionRule {
  source: InstructionSource;
}
export interface InstructionConflict {
  kind: 'overridden' | 'weakened_security_kept' | 'contradiction';
  sectionId: string;
  key?: string;
  winner: InstructionSource;
  loser: InstructionSource;
  detail: string;
}
export interface InstructionError {
  source: InstructionSource;
  message: string;
}
export interface ComposedInstructions {
  sections: { id: string; title: string; rules: ComposedRule[] }[];
  conflicts: InstructionConflict[];
  errors: InstructionError[];
}

const SECTION_ID = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_RULE_CHARS = 500;
/** how binding a strength is: `never` and `must` bind, `should` advises, `may` permits */
const STRICTNESS: Record<RuleStrength, number> = { may: 0, should: 1, must: 2, never: 2 };
const normText = (t: string) =>
  t
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '');

export function validateInstructionLayer(layer: InstructionLayer): InstructionError[] {
  const errors: InstructionError[] = [];
  const seen = new Set<string>();
  for (const s of layer.sections) {
    if (!SECTION_ID.test(s.id))
      errors.push({ source: layer.source, message: `invalid section id "${s.id.slice(0, 40)}"` });
    if (seen.has(s.id))
      errors.push({ source: layer.source, message: `duplicate section "${s.id}"` });
    seen.add(s.id);
    const keys = new Set<string>();
    for (const r of s.rules) {
      if (!r.text.trim()) errors.push({ source: layer.source, message: `empty rule in "${s.id}"` });
      if (r.text.length > MAX_RULE_CHARS)
        errors.push({
          source: layer.source,
          message: `rule over ${MAX_RULE_CHARS} characters in "${s.id}"`,
        });
      if (/[\r\n]/.test(r.text))
        errors.push({ source: layer.source, message: `rule with a line break in "${s.id}"` });
      if (r.key) {
        if (keys.has(r.key))
          errors.push({ source: layer.source, message: `duplicate rule key "${r.key}"` });
        keys.add(r.key);
      }
    }
  }
  return errors;
}

/** Merges the layers by precedence. Invalid layers are reported and skipped, never half-applied. */
export function composeInstructions(layers: readonly InstructionLayer[]): ComposedInstructions {
  const errors: InstructionError[] = [];
  const conflicts: InstructionConflict[] = [];
  const ordered = [...layers].sort(
    (a, b) => INSTRUCTION_PRECEDENCE.indexOf(a.source) - INSTRUCTION_PRECEDENCE.indexOf(b.source),
  );
  const sections = new Map<string, { id: string; title: string; rules: ComposedRule[] }>();
  for (const layer of ordered) {
    const errs = validateInstructionLayer(layer);
    if (errs.length) {
      errors.push(...errs);
      continue;
    }
    for (const s of layer.sections) {
      let target = sections.get(s.id);
      if (!target) {
        target = { id: s.id, title: s.title, rules: [] };
        sections.set(s.id, target);
      } else target.title = s.title || target.title; // the higher layer may rename the heading
      for (const r of s.rules) {
        const incoming: ComposedRule = { ...r, text: r.text.trim(), source: layer.source };
        const byKey = r.key ? target.rules.findIndex((x) => x.key === r.key) : -1;
        if (byKey >= 0) {
          const old = target.rules[byKey]!;
          const weaker =
            STRICTNESS[incoming.strength] < STRICTNESS[old.strength] ||
            (old.strength !== incoming.strength && old.strength === 'never');
          if (old.security && weaker) {
            conflicts.push({
              kind: 'weakened_security_kept',
              sectionId: s.id,
              key: r.key,
              winner: old.source,
              loser: layer.source,
              detail: 'a higher layer tried to relax a security rule; the stricter rule is kept',
            });
            continue;
          }
          conflicts.push({
            kind: 'overridden',
            sectionId: s.id,
            key: r.key,
            winner: layer.source,
            loser: old.source,
            detail: 'replaced by a higher-precedence layer',
          });
          target.rules[byKey] = { ...incoming, security: incoming.security || old.security };
          continue;
        }
        // unkeyed: the same statement once with "must" and once with "never" is a contradiction, not two rules
        const same = target.rules.findIndex((x) => normText(x.text) === normText(incoming.text));
        if (same >= 0) {
          const old = target.rules[same]!;
          if (
            (old.strength === 'must' && incoming.strength === 'never') ||
            (old.strength === 'never' && incoming.strength === 'must')
          ) {
            const keepOld = old.security === true;
            conflicts.push({
              kind: 'contradiction',
              sectionId: s.id,
              winner: keepOld ? old.source : layer.source,
              loser: keepOld ? layer.source : old.source,
              detail: keepOld
                ? 'contradicts a security rule; the security rule is kept'
                : 'contradicts a lower layer; the higher layer wins',
            });
            if (!keepOld) target.rules[same] = incoming;
          }
          continue; // a duplicate statement is not repeated
        }
        target.rules.push(incoming);
      }
    }
  }
  return { sections: [...sections.values()], conflicts, errors };
}

export const CUSTOMER_BLOCK_START = '<!-- nuzm:customer:start -->';
export const CUSTOMER_BLOCK_END = '<!-- nuzm:customer:end -->';
const GENERATED_NOTE =
  '<!-- nuzm:generated — this file is regenerated from the project settings; write your own rules between the customer markers below, they are always kept -->';
const LABEL: Record<RuleStrength, string> = {
  must: 'Must',
  should: 'Should',
  never: 'Never',
  may: 'May',
};

/** The customer's own text from an existing file, or null when there is none (markers missing or out of order). */
export function extractCustomerBlock(markdown: string): string | null {
  const a = markdown.indexOf(CUSTOMER_BLOCK_START);
  const b = markdown.indexOf(CUSTOMER_BLOCK_END);
  if (a < 0 || b < 0 || b < a) return null;
  return markdown
    .slice(a + CUSTOMER_BLOCK_START.length, b)
    .replace(/^\n/, '')
    .replace(/\n$/, '');
}

export function renderInstructions(
  composed: ComposedInstructions,
  opts: { title?: string; customerBlock?: string | null } = {},
): string {
  const out: string[] = [
    `# ${opts.title ?? 'Project Development Instructions'}`,
    '',
    GENERATED_NOTE,
    '',
  ];
  for (const s of composed.sections) {
    if (!s.rules.length) continue;
    out.push(`## ${s.title}`, '');
    for (const r of s.rules) out.push(`- **${LABEL[r.strength]}:** ${r.text}`);
    out.push('');
  }
  out.push(
    '## Project-specific notes',
    '',
    CUSTOMER_BLOCK_START,
    opts.customerBlock ?? '',
    CUSTOMER_BLOCK_END,
    '',
  );
  return out.join('\n');
}

/** Regenerates `CLAUDE.md` from the layers while keeping whatever the customer wrote in their block. */
export function regenerateInstructions(
  existing: string | null,
  layers: readonly InstructionLayer[],
  opts: { title?: string } = {},
): { markdown: string; composed: ComposedInstructions } {
  const composed = composeInstructions(layers);
  const customerBlock = existing ? extractCustomerBlock(existing) : null;
  return { markdown: renderInstructions(composed, { ...opts, customerBlock }), composed };
}
