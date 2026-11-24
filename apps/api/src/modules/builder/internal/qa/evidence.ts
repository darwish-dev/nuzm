import { createHash } from 'node:crypto';
import type { QaReport } from './types';

/**
 * Evidence record of a website generation run (T1 part 1; docs/phase3/PHASE-3-PLAN.md §6). It binds the brief, the model that answered, what the run cost, the artifact
 * that came out (hash) and the QA report of exactly that artifact. `label` says what the record IS: a record can only be `LIVE-VERIFIED` when a real (non-simulated) model
 * answered under a recorded owner approval AND the QA was qualified (every gate ran, axe included). Anything else is `SIMULATED` or `NOT VERIFIED`: a mock result is never
 * promoted to a real one by this module, and the validator refuses a record that claims it.
 */
export type EvidenceLabel = 'LIVE-VERIFIED' | 'SIMULATED' | 'NOT VERIFIED';
export interface WebsiteEvidence {
  schema: 'nuzm.evidence.website/1';
  id: string;
  createdAt: string;
  label: EvidenceLabel;
  /** the synthetic brief (never customer data): id, language and the hash of its text */
  brief: { id: string; locale: 'ar' | 'en'; sha256: string; synthetic: true };
  model: { id: string; provider: string; simulated: boolean };
  /** reference of the recorded owner approval in docs/parallel/OWNER-APPROVAL-PACK.md; null when none (then the record cannot be LIVE-VERIFIED) */
  approvalRef: string | null;
  run: {
    id: string;
    state: string;
    tokensIn: number;
    tokensOut: number;
    /** minor units; integer */
    costMinor: number;
    currency: string;
    durationMs: number;
  };
  artifact: {
    rootHash: string;
    files: number;
    bytes: number;
    pagesPerLocale: Record<string, number>;
  };
  qa: QaReport;
  acceptance: {
    minFivePagesPerLocale: boolean;
    axeViolations: Record<string, number>;
    axeRan: boolean;
    brokenLinks: number;
    cspStrict: boolean;
    sizeWithinBudget: boolean;
    qualified: boolean;
  };
  notes: string[];
}

export interface EvidenceInput {
  id: string;
  createdAt: string;
  brief: { id: string; locale: 'ar' | 'en'; text: string };
  model: { id: string; provider: string; simulated: boolean };
  approvalRef?: string | null;
  run: WebsiteEvidence['run'];
  qa: QaReport;
  /** the caller's own claim; downgraded when the facts do not support it */
  claim?: EvidenceLabel;
  notes?: string[];
}

const errorsOf = (r: QaReport, gate: string, filePrefix?: string): number =>
  r.gates
    .filter((g) => g.gate === gate)
    .flatMap((g) => g.findings)
    .filter((f) => f.severity === 'error' && (!filePrefix || f.file?.startsWith(filePrefix)))
    .length;

export function buildWebsiteEvidence(i: EvidenceInput): WebsiteEvidence {
  const r = i.qa;
  const pagesPerLocale: Record<string, number> = {};
  const completeness = r.gates.find((g) => g.gate === 'completeness')?.metrics.pagesPerLocale;
  if (typeof completeness === 'string')
    for (const kv of completeness.split(',')) {
      const [l, n] = kv.split('=');
      if (l && n) pagesPerLocale[l] = Number(n);
    }
  const axe = r.gates.find((g) => g.gate === 'a11y-axe');
  const axeViolations: Record<string, number> = {};
  for (const l of r.locales) axeViolations[l] = errorsOf(r, 'a11y-axe', `${l}/`);
  const acceptance: WebsiteEvidence['acceptance'] = {
    minFivePagesPerLocale:
      r.locales.length > 0 && r.locales.every((l) => (pagesPerLocale[l] ?? 0) >= 5),
    axeViolations,
    axeRan: axe?.status === 'pass' || axe?.status === 'fail',
    brokenLinks: errorsOf(r, 'links'),
    cspStrict: errorsOf(r, 'csp') === 0,
    sizeWithinBudget: errorsOf(r, 'size') === 0,
    qualified: r.qualified,
  };
  const everything =
    acceptance.minFivePagesPerLocale &&
    acceptance.axeRan &&
    Object.values(axeViolations).every((n) => n === 0) &&
    acceptance.brokenLinks === 0 &&
    acceptance.cspStrict &&
    acceptance.sizeWithinBudget &&
    acceptance.qualified;
  const notes = [...(i.notes ?? [])];
  let label: EvidenceLabel = i.claim ?? 'SIMULATED';
  if (i.model.simulated && label === 'LIVE-VERIFIED') {
    label = 'SIMULATED';
    notes.push('downgraded: a simulated model cannot back LIVE-VERIFIED');
  }
  if (label === 'LIVE-VERIFIED' && !i.approvalRef) {
    label = 'NOT VERIFIED';
    notes.push('downgraded: no recorded owner approval for a live provider call');
  }
  if (label === 'LIVE-VERIFIED' && !everything) {
    label = 'NOT VERIFIED';
    notes.push('downgraded: the acceptance gates are not all green and qualified');
  }
  return {
    schema: 'nuzm.evidence.website/1',
    id: i.id,
    createdAt: i.createdAt,
    label,
    brief: {
      id: i.brief.id,
      locale: i.brief.locale,
      sha256: createHash('sha256').update(i.brief.text).digest('hex'),
      synthetic: true,
    },
    model: i.model,
    approvalRef: i.approvalRef ?? null,
    run: i.run,
    artifact: { rootHash: r.rootHash, files: r.fileCount, bytes: r.totalBytes, pagesPerLocale },
    qa: r,
    acceptance,
    notes,
  };
}

/** Problems that make a record untrustworthy (empty = consistent). A record that claims LIVE-VERIFIED must satisfy every condition `buildWebsiteEvidence` downgrades on. */
export function validateWebsiteEvidence(e: WebsiteEvidence): string[] {
  const out: string[] = [];
  if (e.schema !== 'nuzm.evidence.website/1') out.push('unknown schema');
  if (!/^[0-9a-f]{64}$/.test(e.artifact.rootHash)) out.push('artifact.rootHash is not a sha256');
  if (e.qa.rootHash !== e.artifact.rootHash)
    out.push('the QA report is not bound to the artifact hash');
  if (!Number.isInteger(e.run.costMinor) || e.run.costMinor < 0)
    out.push('run.costMinor must be a non-negative integer (minor units)');
  if (!Number.isInteger(e.run.tokensIn) || !Number.isInteger(e.run.tokensOut))
    out.push('token counts must be integers');
  if (e.label === 'LIVE-VERIFIED') {
    if (e.model.simulated) out.push('LIVE-VERIFIED with a simulated model');
    if (!e.approvalRef) out.push('LIVE-VERIFIED without an owner approval reference');
    if (!e.qa.qualified) out.push('LIVE-VERIFIED without a qualified QA report');
    if (!e.acceptance.minFivePagesPerLocale)
      out.push('LIVE-VERIFIED with fewer than five pages in a locale');
    if (Object.values(e.acceptance.axeViolations).some((n) => n > 0))
      out.push('LIVE-VERIFIED with axe violations');
  }
  if (e.model.simulated && e.label !== 'SIMULATED')
    out.push(`a simulated model's record is labelled ${e.label}`);
  if (JSON.stringify(e).match(/sk-[A-Za-z0-9]{10,}|api[_-]?key|bearer\s+[A-Za-z0-9._-]{12,}/i))
    out.push('the record looks like it contains a secret');
  return out;
}
