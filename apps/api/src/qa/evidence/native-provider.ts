import { createHash } from 'node:crypto';
import { scanForSecrets } from '@nuzm/domain';
import type { ApprovalRegistry } from './approvals';
import { computeContentHash, type EvidenceRecord, type Problem } from './verify';

/**
 * P3-S08: verifier for the NATIVE evidence envelope of P3-S01's live executor (`nuzm.p3-provider-evidence`, schemaVersion 1, written to `docs/phase3/EVIDENCE/provider/`).
 * It is written independently of the producer (no import of its code): the rules below are what an independent verifier must check, not what the producer promises.
 *
 * The envelope labels each CLAIM separately and, by design, a LIVE envelope also carries claims that are SIMULATED or NOT VERIFIED (a real provider cannot be made to fail on demand,
 * so retry and fallback stay simulated). That is honest per claim, and it is why the canonical rule "no record mixes SIMULATED with LIVE-VERIFIED" is applied to the DERIVED records:
 * `deriveProviderRecords` turns the envelope into canonical records (tracks A, B, C), a LIVE-VERIFIED one carries ONLY live claims and real components; the simulated and
 * not-verified claims are never counted for a real row. The matrix consumes the derived records only.
 */
export const PROVIDER_NATIVE_SCHEMA = 'nuzm.p3-provider-evidence';
export const REQUIRED_PROVIDER_DECISIONS = ['D2', 'D3', 'D4', 'D5', 'D6', 'D9'];
const TRACK_TO = {
  A: ['provider', ['T1', 'T3', 'T5']],
  B: ['tool-calling', ['T2']],
  C: ['codegen', ['T3']],
} as const;
const HEX64 = /^[0-9a-f]{64}$/;
const DEC = /^\d{1,30}$/;
const LABELS = ['LIVE-VERIFIED', 'SIMULATED', 'FAIL', 'NOT VERIFIED'];
const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export interface NativeResult {
  ok: boolean;
  problems: Problem[];
  derived: EvidenceRecord[];
}

export function verifyProviderEnvelope(
  raw: unknown,
  opts: { fileName: string | null; approvals: ApprovalRegistry; text?: string },
): NativeResult {
  const problems: Problem[] = [];
  const add = (rule: string, where: string, message: string) =>
    problems.push({ rule, where, message });
  if (!isObj(raw) || raw.schema !== PROVIDER_NATIVE_SCHEMA || raw.schemaVersion !== 1) {
    add('schema', '/', `not a ${PROVIDER_NATIVE_SCHEMA} v1 envelope`);
    return { ok: false, problems, derived: [] };
  }
  const e = raw;
  // ---- structure
  for (const k of ['id', 'createdAt', 'provider', 'model', 'contractVersion'] as const)
    if (!str(e[k])) add('schema', `/${k}`, 'must be a non-empty string');
  if (e.mode !== 'live' && e.mode !== 'mock') add('schema', '/mode', 'must be live or mock');
  if (!LABELS.includes(String(e.verdict)))
    add('schema', '/verdict', `must be one of ${LABELS.join(', ')}`);
  if (!HEX64.test(String(e.inputsSha256))) add('schema', '/inputsSha256', 'must be a sha256');
  if (!HEX64.test(String(e.outputsSha256))) add('schema', '/outputsSha256', 'must be a sha256');
  const cap = isObj(e.cap) ? e.cap : null;
  if (
    !cap ||
    !DEC.test(String(cap.hardMaxNano)) ||
    !DEC.test(String(cap.spentNano)) ||
    typeof cap.overran !== 'boolean'
  )
    add('schema', '/cap', 'needs decimal hardMaxNano and spentNano and a boolean overran');
  const approvals = isObj(e.approvals) ? e.approvals : null;
  if (
    !approvals ||
    !str(approvals.ref) ||
    !str(approvals.approvedBy) ||
    !Array.isArray(approvals.decisions)
  )
    add('schema', '/approvals', 'needs ref, approvedBy and decisions[]');
  const leak = isObj(e.leakCheck) ? e.leakCheck : null;
  if (!leak || leak.performed !== true || leak.findings !== 0)
    add(
      'leak-check',
      '/leakCheck',
      'the live-run leak check must have been performed with 0 findings',
    );
  const tracks = Array.isArray(e.tracks) ? (e.tracks as Obj[]) : null;
  const claims = Array.isArray(e.claims) ? (e.claims as Obj[]) : null;
  const records = Array.isArray(e.records) ? (e.records as Obj[]) : null;
  if (!tracks || !claims || !records)
    add('schema', '/', 'tracks, claims and records must be arrays');
  if (problems.length > 0 || !tracks || !claims || !records || !cap || !approvals)
    return { ok: false, problems, derived: [] };
  for (const [i, c] of claims.entries())
    if (!str(c.claim) || !LABELS.includes(String(c.label)))
      add('schema', `/claims/${i}`, 'needs a claim text and a known label');

  const mode = e.mode as 'live' | 'mock';
  const verdict = e.verdict as string;
  // ---- file name: <date>-[sim-]<id>.json, 'sim-' exactly when the run was not live
  if (opts.fileName !== null) {
    const m = /^(\d{4}-\d{2}-\d{2})-(sim-)?(.+)\.json$/.exec(opts.fileName);
    if (!m)
      add(
        'placement',
        '/',
        `the file name must be <YYYY-MM-DD>-[sim-]<id>.json, got ${opts.fileName}`,
      );
    else {
      if (m[3] !== e.id)
        add('placement', '/id', `the file name says id ${m[3]}, the envelope says ${String(e.id)}`);
      if (!String(e.createdAt).startsWith(m[1]!))
        add('placement', '/createdAt', 'the file name date differs from createdAt');
      if ((mode === 'live') === Boolean(m[2]))
        add(
          'placement',
          '/mode',
          mode === 'live'
            ? 'a live envelope must not carry the sim- prefix'
            : 'a mock envelope must carry the sim- prefix',
        );
    }
  }
  // ---- label consistency (the mixed-label rule, applied where it can be applied honestly)
  const live = mode === 'live';
  if (!live && verdict === 'LIVE-VERIFIED')
    add('mixed-labels', '/verdict', 'a mock run cannot be LIVE-VERIFIED');
  for (const [i, c] of claims.entries()) {
    if (!live && c.label === 'LIVE-VERIFIED')
      add('mixed-labels', `/claims/${i}`, 'a mock envelope claims a LIVE-VERIFIED result');
    if (live && verdict === 'LIVE-VERIFIED' && c.label === 'FAIL')
      add('mixed-labels', `/claims/${i}`, 'a LIVE-VERIFIED envelope contains a FAIL claim');
  }
  for (const [i, r] of records.entries()) {
    if (r.mode !== mode)
      add(
        'mixed-labels',
        `/records/${i}/mode`,
        `a ${mode} envelope contains a ${String(r.mode)} record`,
      );
    if (live && r.verdict === 'SIMULATED')
      add('mixed-labels', `/records/${i}/verdict`, 'a live envelope contains a SIMULATED record');
  }
  if (isObj(e.suite) && e.suite.mode !== undefined && e.suite.mode !== mode)
    add('mixed-labels', '/suite/mode', 'the suite report and the envelope disagree on live/mock');
  // ---- hashes
  if (sha({ records, suite: e.suite ?? null }) !== e.outputsSha256)
    add('content-hash', '/outputsSha256', 'does not equal the sha256 of {records, suite}');
  let spent = 0n;
  for (const [i, t] of tracks.entries()) {
    if (t.status === 'ran') {
      const rec = t.track === 'S' ? e.suite : records.find((r) => r.track === t.track);
      if (rec === undefined)
        add(
          'content-hash',
          `/tracks/${i}`,
          `track ${String(t.track)} ran but its record is absent`,
        );
      else if (sha(rec) !== t.recordSha256)
        add('content-hash', `/tracks/${i}/recordSha256`, 'does not equal the sha256 of the record');
      if (typeof t.costNano === 'string' && DEC.test(t.costNano)) spent += BigInt(t.costNano);
    }
  }
  if (DEC.test(String(cap.spentNano)) && spent !== BigInt(String(cap.spentNano)))
    add('cost', '/cap/spentNano', 'does not equal the sum of the track costs');
  if (BigInt(String(cap.spentNano)) > BigInt(String(cap.hardMaxNano)) && cap.overran !== true)
    add('cost', '/cap', 'spent exceeds the hard maximum but overran is false');
  // ---- live requirements
  const decisions = (approvals.decisions as Obj[]).filter(isObj);
  if (verdict === 'LIVE-VERIFIED') {
    if (!live) add('live', '/mode', 'LIVE-VERIFIED needs a live run');
    if (cap.overran === true)
      add('live', '/cap/overran', 'a run that overran its cap is not LIVE-VERIFIED');
    if (approvals.ref === 'twin-synthetic' || approvals.approvedBy === 'twin')
      add('live', '/approvals', 'the approval is the twin synthetic one');
    if (tracks.some((t) => t.status !== 'ran'))
      add(
        'live',
        '/tracks',
        'a track that was not run can never be part of a LIVE-VERIFIED verdict',
      );
    for (const id of REQUIRED_PROVIDER_DECISIONS) {
      const d = decisions.find((x) => x.decision === id);
      if (!d || !str(d.ref) || d.ref === 'n/a')
        add('live', '/approvals/decisions', `decision ${id} has no reference in the envelope`);
      else if (!opts.approvals.has(id))
        add(
          'live',
          '/approvals/decisions',
          `decision ${id} is not recorded in the owner's decision log (OWNER-APPROVAL-PACK.md section 6)`,
        );
    }
    if (FAKE.test(String(e.model)) || FAKE.test(String(e.provider)))
      add('live', '/model', 'the model or provider name looks like a stand-in');
  }
  // ---- secrets (the envelope must not carry a key, prompt or personal data)
  for (const f of scanForSecrets(opts.text ?? JSON.stringify(raw)))
    add('secret', '/', `the secret scanner found a ${f.kind} (value not shown)`);
  if (problems.length > 0) return { ok: false, problems, derived: [] };
  return {
    ok: true,
    problems,
    derived: deriveProviderRecords(e, tracks, claims, records, decisions, opts.approvals),
  };
}
const FAKE = /\b(mock|twin|scripted|fake|stub|simulat\w*)\b/i;

/** canonical records for tracks A, B, C of a VERIFIED native envelope (see the file comment: live claims only in a LIVE record) */
function deriveProviderRecords(
  e: Obj,
  tracks: Obj[],
  claims: Obj[],
  records: Obj[],
  decisions: Obj[],
  approvals: ApprovalRegistry,
): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  const live = e.mode === 'live';
  const reconciled = claims.some(
    (c) =>
      /reconciliation/i.test(String(c.claim)) &&
      c.label === 'LIVE-VERIFIED' &&
      /usage/i.test(String(c.claim)),
  );
  for (const rec of records) {
    const t = String(rec.track) as 'A' | 'B' | 'C';
    if (!(t in TRACK_TO)) continue;
    const [track, targets] = TRACK_TO[t];
    const totals = (isObj(rec.totals) ? rec.totals : {}) as Obj;
    const checks = (Array.isArray(rec.checks) ? rec.checks : []).filter(isObj);
    const allOk = checks.length > 0 && checks.every((c) => c.ran === true && c.ok === true);
    const anyFail = checks.some((c) => c.ran === true && c.ok !== true);
    const isLive =
      live &&
      e.verdict !== 'FAIL' &&
      rec.verdict === 'LIVE-VERIFIED' &&
      allOk &&
      (e.cap as Obj).overran === false;
    const label = isLive ? 'LIVE-VERIFIED' : live ? 'NOT VERIFIED' : 'SIMULATED';
    const result = isLive
      ? 'PASS'
      : anyFail
        ? 'FAIL'
        : live
          ? 'NOT_VERIFIED'
          : allOk
            ? 'PASS'
            : 'NOT_VERIFIED';
    const usage = {
      requests: Number(totals.requests ?? 0),
      tokensIn: Number(totals.tokensIn ?? 0),
      tokensOut: Number(totals.tokensOut ?? 0),
    };
    const passed = checks.filter((c) => c.ok === true && c.ran === true).map((c) => String(c.id));
    const details: Obj =
      t === 'A'
        ? {
            track: 'A',
            provider: e.provider,
            model: e.model,
            usage,
            usageReconciled: isLive && reconciled,
            keyLeakScan: 'clean',
          }
        : {
            track: t,
            model: e.model,
            usage,
            passedChecks: passed.length ? passed : ['none'],
            keyLeakScan: 'clean',
          };
    const started = String(rec.startedAt ?? e.createdAt);
    const finished = String(rec.finishedAt ?? e.createdAt);
    const trackRow = tracks.find((x) => x.track === t);
    const derived: Obj = {
      schema: 'nuzm.p3-evidence/1',
      id: `${track}-${String(e.id).toLowerCase()}`.slice(0, 80),
      track,
      targets: [...targets],
      component: `p3-s01-live-executor (native ${PROVIDER_NATIVE_SCHEMA})`,
      label,
      result,
      recordedAt: String(e.createdAt),
      startedAt: started,
      finishedAt: finished,
      durationMs: Math.max(0, Date.parse(finished) - Date.parse(started)),
      revision: { commit: `native:${sha(e).slice(0, 12)}` },
      components: [
        {
          name: String((e.components as Obj)?.adapterPackage ?? 'adapter'),
          version: String(e.contractVersion),
          origin: live ? 'real' : 'simulated',
          label: label === 'LIVE-VERIFIED' ? 'LIVE-VERIFIED' : label,
        },
      ],
      ...(isLive
        ? { identity: { model: { provider: String(e.provider), id: String(e.model) } } }
        : {}),
      approvals: isLive
        ? REQUIRED_PROVIDER_DECISIONS.map((id) => ({
            id,
            ref: `${String(decisions.find((d) => d.decision === id)?.ref).slice(0, 100)}`,
            recordedIn: approvals.has(id) ? 'docs/parallel/OWNER-APPROVAL-PACK.md#6' : 'unrecorded',
          }))
        : [],
      inputs: [{ name: 'envelope-inputs', sha256: String(e.inputsSha256) }],
      outputs: [{ name: `record-${t}`, sha256: String(trackRow?.recordSha256 ?? sha(rec)) }],
      cost: {
        currency: String((e.cap as Obj).currency ?? 'USD'),
        unit: 'nano',
        usedMinor: String(totals.costNano ?? '0'),
        maxMinor: String((e.cap as Obj).hardMaxNano),
      },
      checks: checks.map((c) => ({
        id: String(c.id),
        label: isLive ? 'LIVE-VERIFIED' : live ? 'NOT VERIFIED' : 'SIMULATED',
        result: c.ran !== true ? 'NOT_VERIFIED' : c.ok === true ? 'PASS' : 'FAIL',
      })),
      blockers:
        isLive || !live
          ? []
          : [
              {
                id: 'checks',
                text: `track ${t}: ${
                  checks
                    .filter((c) => !(c.ran === true && c.ok === true))
                    .map((c) => String(c.id))
                    .join(', ') || 'verdict ' + String(rec.verdict)
                } not passed in the live run`,
              },
            ],
      details,
    };
    out.push({
      ...(derived as unknown as EvidenceRecord),
      contentHash: computeContentHash(derived),
    });
  }
  return out;
}
