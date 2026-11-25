import { diffModels, type SiteModel } from '@nuzm/domain';
import { sha256Hex, type ArtifactFile } from './artifact';

/**
 * W3: an edit-by-prompt must be a MINIMAL diff, not a rewrite. This measures a change between two versions at three levels: the model (sections and texts that
 * changed), the structure (pages/sections added or removed) and the built files (how many output files differ byte-for-byte), and classifies it. The classification is
 * a measurement the edit flow and the QA evidence both use; it never decides to accept or reject by itself (a human approval gate does that, and `assertMinimalEdit` is
 * what a test or the repair loop calls to refuse an edit that touched far more than its instruction asked for).
 */
export interface EditDiffStats {
  sectionsBefore: number;
  sectionsChanged: number;
  sectionsAdded: number;
  sectionsRemoved: number;
  sectionsReordered: number;
  pagesAdded: number;
  pagesRemoved: number;
  pagesTouched: number;
  textsChanged: number;
  tokensChanged: boolean;
  /** share of existing sections that differ in any way (0..1) */
  changedFraction: number;
  filesBefore: number;
  filesChanged: number;
  filesAdded: number;
  filesRemoved: number;
  /** share of the OLD output files that are byte-identical in the new build (0..1): high = nothing else moved */
  filesPreserved: number;
  verdict: 'none' | 'minimal' | 'moderate' | 'rewrite';
}

export function measureEditDiff(
  before: SiteModel,
  after: SiteModel,
  files?: { before: ArtifactFile[]; after: ArtifactFile[] },
): EditDiffStats {
  const d = diffModels(before, after);
  const count = (k: string) => d.structural.filter((e) => e.kind === k).length;
  const sectionsBefore = before.pages.reduce((n, p) => n + p.sections.length, 0);
  const sectionsChanged = count('component_changed');
  const sectionsAdded = count('component_added');
  const sectionsRemoved = count('component_deleted');
  const sectionsReordered = count('components_reordered');
  const pagesAdded = count('page_added');
  const pagesRemoved = count('page_deleted');
  const touched = new Set<string>();
  for (const e of d.structural) if (e.pageId) touched.add(e.pageId);
  for (const t of d.text) {
    const m = /^page:([^.]+)/.exec(t.path);
    if (m?.[1]) touched.add(m[1]);
  }
  const tokensChanged = d.structural.some((e) => e.kind === 'tokens_changed');
  const textSections = new Set(
    d.text
      .map((t) => /^page:([^.]+)\.section:([^.]+)/.exec(t.path)?.slice(1, 3).join('/'))
      .filter(Boolean),
  );
  const changedSections = new Set([...textSections]).size + sectionsChanged;
  const changedFraction =
    sectionsBefore === 0
      ? d.text.length || d.structural.length
        ? 1
        : 0
      : Math.min(1, changedSections / sectionsBefore);

  let filesBefore = 0;
  let filesChanged = 0;
  let filesAdded = 0;
  let filesRemoved = 0;
  let filesPreserved = 1;
  if (files) {
    const a = new Map(files.before.map((f) => [f.path, sha256Hex(f.bytes)]));
    const b = new Map(files.after.map((f) => [f.path, sha256Hex(f.bytes)]));
    filesBefore = a.size;
    let same = 0;
    for (const [p, h] of a) {
      if (!b.has(p)) filesRemoved++;
      else if (b.get(p) !== h) filesChanged++;
      else same++;
    }
    for (const p of b.keys()) if (!a.has(p)) filesAdded++;
    filesPreserved = filesBefore === 0 ? 1 : same / filesBefore;
  }
  const nothing =
    d.structural.length === 0 &&
    d.text.length === 0 &&
    filesChanged + filesAdded + filesRemoved === 0;
  let verdict: EditDiffStats['verdict'];
  if (nothing) verdict = 'none';
  else if (pagesRemoved > 0 && pagesRemoved >= Math.max(1, before.pages.length / 2))
    verdict = 'rewrite';
  else if (changedFraction > 0.5) verdict = 'rewrite';
  else if (changedFraction > 0.2 || pagesAdded + pagesRemoved > 2 || sectionsRemoved > 3)
    verdict = 'moderate';
  else verdict = 'minimal';
  return {
    sectionsBefore,
    sectionsChanged,
    sectionsAdded,
    sectionsRemoved,
    sectionsReordered,
    pagesAdded,
    pagesRemoved,
    pagesTouched: touched.size,
    textsChanged: d.text.length,
    tokensChanged,
    changedFraction,
    filesBefore,
    filesChanged,
    filesAdded,
    filesRemoved,
    filesPreserved,
    verdict,
  };
}

export interface MinimalEditLimits {
  /** most existing sections that may change (default max(3, 15% of the site)) */
  maxSectionsChanged?: number;
  maxPagesTouched?: number;
  allowPageRemoval?: boolean;
  allowTokenChange?: boolean;
}
/** Problems that make an edit NOT minimal under the limits (empty = minimal). The text is what the edit agent is told when its change was too broad. */
export function assertMinimalEdit(s: EditDiffStats, lim: MinimalEditLimits = {}): string[] {
  const out: string[] = [];
  const maxSections = lim.maxSectionsChanged ?? Math.max(3, Math.ceil(s.sectionsBefore * 0.15));
  const changed = s.sectionsChanged + s.sectionsAdded + s.sectionsRemoved;
  if (changed > maxSections)
    out.push(
      `${changed} sections changed, added or removed (limit ${maxSections}): change only what the instruction asks for`,
    );
  if (lim.maxPagesTouched !== undefined && s.pagesTouched > lim.maxPagesTouched)
    out.push(`${s.pagesTouched} pages touched (limit ${lim.maxPagesTouched})`);
  if (s.pagesRemoved > 0 && !lim.allowPageRemoval) out.push(`${s.pagesRemoved} page(s) removed`);
  if (s.tokensChanged && !lim.allowTokenChange)
    out.push('the design tokens (colours, fonts, spacing) changed');
  if (s.verdict === 'rewrite') out.push('the edit rewrote most of the site');
  return out;
}
