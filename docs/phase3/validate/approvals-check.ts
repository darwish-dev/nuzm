/**
 * Reads docs/parallel/OWNER-APPROVAL-PACK.md section 6 (the decision log) and prints one TAB-separated line per approval id: STATUS, id, what, hint.
 * READ-ONLY: it only reads that file. An approval counts only when its row has a non-empty Reference (the pack's own rule); this script never records one.
 *   tsx approvals-check.ts [--target T1|T2|T3|T4|T5|T6|X]   (only the approvals the target's rows need; default: every approval the Phase 3 plan names)
 */
import { loadApprovals } from '../../../apps/api/src/qa/evidence/approvals';
import { REQUIREMENTS } from '../../../apps/api/src/qa/evidence/matrix';
import { repoRoot } from '../../../apps/api/src/qa/evidence/verify';

const WHAT: Record<string, string> = {
  D1: 'customer content may reach a model (only for customer data; not needed for synthetic runs)',
  D2: 'Claude agreement and data terms accepted',
  D3: 'live provider gate opened in one non-production environment',
  D4: 'dedicated non-production key with a vendor-side cap',
  D5: 'region statement and ROPA entry for the provider',
  D6: 'customer rate card, FX, VAT',
  D9: 'bounded live probe and suite approved',
  'AC-AG-10': 'benchmark acceptance thresholds accepted',
  BUD: 'benchmark budget per stage and vendor cap',
  REV: 'named human reviewers and acceptance bar',
  'SEC-AG': 'named agent security reviewer',
  'D-21': 'isolation technology and node pool decided',
  'HG-10-02': 'independent sandbox isolation review commissioned, reviewer named',
  'ADR-069': 'Execution Gateway ADR accepted as binding',
  'HG-05': 'real, non-production, throw-away hosting node approved',
  'HG-06': 'panel access on that node approved',
  'HOST-TRANSPORT': 'owner for the artifact upload path assigned',
  'B-DOMAIN': 'preview/staging domain and wildcard certificate',
  'HOST-JOIN': 'join of the AI-engine line with the hosting line authorised',
  'B-iOS': 'macOS build host with full Xcode',
  'B-Android': 'isolated Android build environment approved',
  'B-SIGN': 'Android test keystore custody policy (debug/test key only)',
  'B-DB': 'where PostgreSQL for generated full-stack apps runs in staging',
};
const arg = process.argv.indexOf('--target');
const target = arg >= 0 ? process.argv[arg + 1] : undefined;
const need = [...new Set(REQUIREMENTS.filter((r) => !target || r.target === target).flatMap((r) => r.approvals))];
const reg = loadApprovals(repoRoot());
const ids = target ? need : Object.keys(WHAT);
for (const id of ids) {
  const rec = reg.recorded.get(id.toUpperCase());
  const what = WHAT[id] ?? 'approval named by the Phase 3 plan';
  if (rec) process.stdout.write(['PASS', id, `${what}: recorded as ${rec.reference} (${rec.date || 'no date'}, ${rec.by || 'no name'})`, ''].join('\t') + '\n');
  else process.stdout.write(['FAIL', id, what, 'record it in docs/parallel/OWNER-APPROVAL-PACK.md section 6 with a reference (you do this; engineering never does)'].join('\t') + '\n');
}
