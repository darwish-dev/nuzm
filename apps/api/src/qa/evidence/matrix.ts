import type { ApprovalRegistry } from './approvals';
import type { EvidenceRecord, Track, Verified } from './verify';

/**
 * P3-S08: the Phase 3 acceptance matrix. Rows are the components each target (T1..T6) needs, taken from `docs/phase3/PHASE-3-PLAN.md` section 1. Every cell is computed
 * from VERIFIED evidence only (a record that fails the verifier counts for nothing and is listed as REJECTED). The columns are kept apart on purpose and are never added:
 *   LIVE-VERIFIED = a verified record, label LIVE-VERIFIED, result PASS, matching the row;
 *   SIMULATED     = verified records labelled SIMULATED (a pipeline exercise: "nothing simulated appears in a real column");
 *   status        = PASS (live evidence) | FAIL (a live record says FAIL and no live PASS exists) | BLOCKED (exact blocker named) | NOT VERIFIED (nothing, and no blocker known).
 * A target is PASS only when every one of its rows is PASS.
 */
export type CellStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT VERIFIED';
export interface Requirement {
  /** stable id, e.g. T1.deploy */
  id: string;
  target: string;
  description: string;
  track: Track;
  /** extra condition on the record's details (e.g. platform = ios) */
  match?: (r: EvidenceRecord) => boolean;
  matchText?: string;
  /** owner approval ids that must be recorded before this row can run for real */
  approvals: string[];
  /** external blockers (keys of EXTERNAL_BLOCKERS) independent of approvals */
  external: string[];
  /** the session that produces the evidence */
  owner: string;
}

/** Blockers that are facts about the world, not approvals. Text is an exact statement; update it when the fact changes. */
export const EXTERNAL_BLOCKERS: Record<string, string> = {
  'B-iOS-XCODE':
    'B-iOS: no macOS host with full Xcode (the owner Mac has macOS 13.7.8 and only Command Line Tools, no xcodebuild); T4 cannot be built or run.',
  'LINUX-NODE':
    'No dedicated non-production Linux node exists (D-21/HG-10-02): nothing can execute generated code in an isolating runtime.',
  'HOST-TRANSPORT-BUILD':
    'HOST-TRANSPORT is not scheduled: no artifact upload path exists on the hosting line, so a real artifact deployment cannot be made (staging stays SIMULATED).',
  'NO-HOSTING-NODE': 'No real, throw-away hosting node (HG-05) and no panel access (HG-06) exist.',
};

const PROVIDER = ['D2', 'D5', 'D6', 'D4', 'D3', 'D9'];
const RUNTIME = ['D-21', 'HG-10-02', 'ADR-067'];
const DEPLOY = ['HG-05', 'HG-06', 'HOST-TRANSPORT', 'B-DOMAIN', 'HOST-JOIN'];

const req = (
  id: string,
  target: string,
  description: string,
  track: Track,
  owner: string,
  approvals: string[],
  external: string[] = [],
  match?: Requirement['match'],
  matchText?: string,
): Requirement => ({
  id,
  target,
  description,
  track,
  owner,
  approvals,
  external,
  ...(match ? { match } : {}),
  ...(matchText ? { matchText } : {}),
});
const platform =
  (p: string): Requirement['match'] =>
  (r) =>
    (r.details as { platform?: string }).platform === p;

export const REQUIREMENTS: Requirement[] = [
  // T1: real business website
  req('T1.model', 'T1', 'real model connection and tool calling', 'provider', 'P3-S01', PROVIDER),
  req(
    'T1.website',
    'T1',
    'website generated from a synthetic Arabic and English brief, QA gates green',
    'website',
    'P3-S04',
    PROVIDER,
  ),
  req(
    'T1.preview',
    'T1',
    'real preview on an isolated origin with TLS and health',
    'preview',
    'P3-S07',
    DEPLOY,
    ['NO-HOSTING-NODE'],
  ),
  req(
    'T1.deploy',
    'T1',
    'real release served by the hosting target (content hash equals artifact)',
    'deploy',
    'P3-S07',
    DEPLOY,
    ['NO-HOSTING-NODE', 'HOST-TRANSPORT-BUILD'],
  ),
  // T2: full-stack app
  req(
    'T2.runtime',
    'T2',
    'isolating runtime qualified (escape suite, signed attestation)',
    'runtime',
    'P3-S02',
    RUNTIME,
    ['LINUX-NODE'],
  ),
  req(
    'T2.fullstack',
    'T2',
    'full-stack app builds, migrates PostgreSQL, authenticates, isolates users',
    'fullstack',
    'P3-S05',
    [...PROVIDER, ...RUNTIME, 'B-DB'],
    ['LINUX-NODE'],
  ),
  req(
    'T2.deploy',
    'T2',
    'server code deployed to a real target',
    'deploy',
    'P3-S07',
    [...DEPLOY, 'B-DB'],
    ['NO-HOSTING-NODE', 'HOST-TRANSPORT-BUILD'],
  ),
  // T3: Flutter APK
  req(
    'T3.codegen',
    'T3',
    'real model generates the Flutter project',
    'codegen',
    'P3-S01',
    PROVIDER,
  ),
  req(
    'T3.android',
    'T3',
    'installable debug APK built in the isolated Android environment (test key only)',
    'mobile',
    'P3-S06',
    [...PROVIDER, 'B-Android', 'B-SIGN'],
    [],
    platform('android'),
    'details.platform = android',
  ),
  // T4: iOS
  req(
    'T4.ios',
    'T4',
    'iOS build without code signing on macOS with full Xcode',
    'mobile',
    'P3-S06',
    ['B-iOS'],
    ['B-iOS-XCODE'],
    platform('ios'),
    'details.platform = ios',
  ),
  // T5: automatic repair
  req(
    'T5.repair',
    'T5',
    'build error detected, repaired by the real model, rebuilt green (>= 3 error classes)',
    'build-repair',
    'P3-S03',
    [...PROVIDER, ...RUNTIME],
    ['LINUX-NODE'],
  ),
  // T6: preview, deployment, versioning, rollback
  req(
    'T6.deploy',
    'T6',
    'two real releases and a rollback verified by content hash',
    'deploy',
    'P3-S07',
    DEPLOY,
    ['NO-HOSTING-NODE', 'HOST-TRANSPORT-BUILD'],
  ),
  req(
    'T6.preview',
    'T6',
    'preview isolation and TLS on the real target',
    'preview',
    'P3-S07',
    DEPLOY,
    ['NO-HOSTING-NODE'],
  ),
  // cross-cutting qualification gates (Track H and security), not a target
  req(
    'X.benchmark',
    'X',
    'benchmark stage on the verified model with accepted thresholds (Track H)',
    'benchmark',
    'P3-S08',
    [...PROVIDER, 'AC-AG-10', 'BUD', 'REV', 'SEC-AG'],
  ),
  req(
    'X.leak',
    'X',
    'live-run credential leak scan finds nothing',
    'security',
    'P3-S08',
    PROVIDER,
    [],
    (r) => (r.details as { kind?: string }).kind === 'credential-leak-scan',
    'details.kind = credential-leak-scan',
  ),
  req(
    'X.reconcile',
    'X',
    'wallet, ledger and usage reconcile to the cent after a real paid run',
    'security',
    'P3-S08',
    PROVIDER,
    [],
    (r) => (r.details as { kind?: string }).kind === 'ledger-wallet-reconciliation',
    'details.kind = ledger-wallet-reconciliation',
  ),
  req(
    'X.escape',
    'X',
    'independent runtime-escape re-run by a reviewer who did not build it',
    'security',
    'P3-S08',
    RUNTIME,
    ['LINUX-NODE'],
    (r) => (r.details as { kind?: string }).kind === 'runtime-escape-independent',
    'details.kind = runtime-escape-independent',
  ),
];
export const TARGET_IDS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'X'] as const;

export interface Cell {
  req: Requirement;
  status: CellStatus;
  live: string[];
  simulated: string[];
  notVerified: string[];
  failed: string[];
  blockers: string[];
}
export interface Matrix {
  cells: Cell[];
  targets: { id: string; status: CellStatus; rows: number; pass: number }[];
  rejected: { file: string; rules: string[] }[];
}

export function buildMatrix(
  records: readonly EvidenceRecord[],
  approvals: ApprovalRegistry,
  rejected: readonly Verified[] = [],
): Matrix {
  const cells: Cell[] = REQUIREMENTS.map((rq) => {
    const mine = records.filter(
      (r) =>
        r.track === rq.track &&
        (rq.match ? rq.match(r) : true) &&
        (rq.target === 'X' || r.targets.includes(rq.target)),
    );
    const live = mine.filter((r) => r.label === 'LIVE-VERIFIED' && r.result === 'PASS');
    const failed = mine.filter((r) => r.label === 'LIVE-VERIFIED' && r.result === 'FAIL');
    const sim = mine.filter((r) => r.label === 'SIMULATED');
    const nv = mine.filter((r) => r.label === 'NOT VERIFIED');
    const blockers: string[] = [];
    const missing = approvals.missing(rq.approvals);
    if (missing.length > 0)
      blockers.push(
        `approvals not recorded: ${missing.join(', ')} (OWNER-APPROVAL-PACK.md section 6)`,
      );
    for (const k of rq.external) if (EXTERNAL_BLOCKERS[k]) blockers.push(EXTERNAL_BLOCKERS[k]!);
    for (const r of nv) for (const b of r.blockers) blockers.push(`${r.id}: ${b.text}`);
    const status: CellStatus =
      live.length > 0
        ? 'PASS'
        : failed.length > 0
          ? 'FAIL'
          : blockers.length > 0
            ? 'BLOCKED'
            : 'NOT VERIFIED';
    return {
      req: rq,
      status,
      live: live.map((r) => r.id),
      simulated: sim.map((r) => r.id),
      notVerified: nv.map((r) => r.id),
      failed: failed.map((r) => r.id),
      // a row with live evidence has no blocker to report
      blockers: status === 'PASS' ? [] : blockers,
    };
  });
  const targets = TARGET_IDS.map((id) => {
    const rows = cells.filter((c) => c.req.target === id);
    const pass = rows.filter((c) => c.status === 'PASS').length;
    const status: CellStatus =
      pass === rows.length
        ? 'PASS'
        : rows.some((c) => c.status === 'FAIL')
          ? 'FAIL'
          : rows.some((c) => c.status === 'BLOCKED')
            ? 'BLOCKED'
            : 'NOT VERIFIED';
    return { id, status, rows: rows.length, pass };
  });
  return {
    cells,
    targets,
    rejected: rejected.map((v) => ({
      file: v.file,
      rules: [...new Set(v.problems.map((p) => p.rule))],
    })),
  };
}

export function renderMatrixMarkdown(
  m: Matrix,
  meta: { commit: string; generatedAt: string },
): string {
  const L: string[] = [];
  L.push('# Phase 3 acceptance matrix');
  L.push('');
  L.push(
    `Generated by \`pnpm --filter @nuzm/api evidence:matrix\` (P3-S08) at ${meta.generatedAt} on \`${meta.commit}\`. Computed from verified evidence under \`docs/phase3/EVIDENCE/**\` only. The LIVE and SIMULATED columns are separate and are never added; a SIMULATED record never makes a row PASS.`,
  );
  L.push('');
  L.push('| Target | Status | Rows PASS |');
  L.push('|---|---|---|');
  for (const t of m.targets)
    L.push(
      `| ${t.id === 'X' ? 'X (cross-cutting gates)' : t.id} | **${t.status}** | ${t.pass}/${t.rows} |`,
    );
  L.push('');
  L.push('| Row | Needs | Status | LIVE-VERIFIED records | SIMULATED records | Exact blocker |');
  L.push('|---|---|---|---|---|---|');
  for (const c of m.cells) {
    const f = (a: string[]) => (a.length ? a.map((x) => `\`${x}\``).join(', ') : '-');
    L.push(
      `| ${c.req.id} | ${c.req.description} (${c.req.owner}, track \`${c.req.track}\`${c.req.matchText ? `, ${c.req.matchText}` : ''}) | **${c.status}** | ${f(c.live)} | ${f(c.simulated)} | ${c.blockers.length ? c.blockers.join('<br>') : c.status === 'PASS' ? '-' : 'none known: no evidence yet'} |`,
    );
  }
  if (m.rejected.length > 0) {
    L.push('');
    L.push('## Rejected evidence files (counted for nothing)');
    for (const r of m.rejected) L.push(`- \`${r.file}\`: ${r.rules.join(', ')}`);
  }
  L.push('');
  return L.join('\n');
}
