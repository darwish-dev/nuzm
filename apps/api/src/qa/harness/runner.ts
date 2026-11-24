import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadApprovals, type ApprovalRegistry } from '../evidence/approvals';
import { EXTERNAL_BLOCKERS } from '../evidence/matrix';
import {
  loadSchemas,
  repoRoot,
  seal,
  verifyRecord,
  type EvidenceRecord,
  type Label,
} from '../evidence/verify';
import { SIMULATED_DRIVERS, LIVE_DRIVERS, type DriverMap, type DriverOutput } from './drivers';
import { SCENARIOS, isOfflineOnly, type Scenario } from './scenarios';

/**
 * P3-S08 qualification harness runner.
 *   mode `simulated` (default): runs EVERY scenario through its simulated driver. Nothing real is touched; every record is labelled SIMULATED (or NOT VERIFIED where no offline entry
 *     point exists) and is verified by the evidence verifier before it is kept. This is the plumbing check, never a measurement.
 *   mode `live`: walks the scenarios in order and STOPS AT THE FIRST ONE whose approvals are not recorded, whose external facts are not cleared, whose predecessors have no LIVE-VERIFIED
 *     evidence, or that has no live driver registered, and reports the exact blocker. No driver is called for that scenario or any later one. It never falls back to a simulated result.
 * Resumable: `<out>/state.json` remembers finished scenarios (with the record's content hash); a re-run skips a scenario whose record still verifies and whose hash is unchanged.
 * Records go to `<out>/<track>/<date>-<id>.json`, by default OUTSIDE `docs/phase3/EVIDENCE` so a simulated run never changes the acceptance matrix.
 */
export type Mode = 'simulated' | 'live';
export interface StateEntry {
  status: 'done' | 'stopped';
  recordId?: string;
  contentHash?: string;
  label?: Label;
  result?: string;
  blocker?: string;
}
export interface HarnessState {
  schema: 'nuzm.qualification-state/1';
  mode: Mode;
  scenarios: Record<string, StateEntry>;
}
export interface HarnessOptions {
  mode: Mode;
  outDir: string;
  root?: string;
  approvals?: ApprovalRegistry;
  simulated?: DriverMap;
  live?: DriverMap;
  scenarios?: readonly Scenario[];
  now?: () => Date;
  commit?: string;
  /** restrict to these scenario ids (still in order) */
  only?: string[];
}
export interface ScenarioOutcome {
  id: string;
  status: 'ran' | 'resumed' | 'skipped-offline-only' | 'stopped';
  label?: Label;
  result?: string;
  recordFile?: string;
  blocker?: string;
  problems?: string[];
}
export interface HarnessReport {
  mode: Mode;
  outcomes: ScenarioOutcome[];
  /** live mode: the first scenario that could not run and why; null if all ran */
  stoppedAt: { id: string; blocker: string } | null;
  exitCode: 0 | 1 | 3;
}

/** the exact blockers of one scenario in live mode (empty = may run); also used by `--plan` */
export function blockersOf(
  s: Scenario,
  approvals: ApprovalRegistry,
  liveDone: ReadonlySet<string>,
  live: DriverMap,
): string[] {
  const out: string[] = [];
  const missing = approvals.missing(s.approvals);
  if (missing.length > 0)
    out.push(
      `approvals not recorded: ${missing.join(', ')} (docs/parallel/OWNER-APPROVAL-PACK.md section 6)`,
    );
  for (const k of s.external) if (EXTERNAL_BLOCKERS[k]) out.push(EXTERNAL_BLOCKERS[k]!);
  const pre = s.after.filter((a) => !liveDone.has(a));
  if (pre.length > 0) out.push(`needs LIVE-VERIFIED evidence first from: ${pre.join(', ')}`);
  if (!live[s.id])
    out.push(
      `no live driver is registered for ${s.id} (${s.owner}: ${s.entry}); add it to qa/harness/drivers.ts when the entry point lands`,
    );
  return out;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
function head(root: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown000';
  }
}

export function toRecord(
  s: Scenario,
  o: DriverOutput,
  label: Label,
  ctx: { now: Date; commit: string; approvals: ApprovalRegistry },
): Record<string, unknown> {
  const ts = ctx.now.toISOString().replace(/\.\d+Z$/, 'Z');
  const notVerified = o.result === 'NOT_VERIFIED';
  const recLabel: Label =
    label === 'LIVE-VERIFIED'
      ? 'LIVE-VERIFIED'
      : notVerified && o.blockers?.length
        ? 'NOT VERIFIED'
        : 'SIMULATED';
  const compLabel = (origin: string) =>
    recLabel === 'LIVE-VERIFIED' ? 'LIVE-VERIFIED' : origin === 'offline' ? 'OFFLINE' : recLabel;
  return {
    schema: 'nuzm.p3-evidence/1',
    id: s.id.toLowerCase(),
    track: s.track,
    targets: s.targets,
    component: `harness:${s.id}`,
    label: recLabel,
    result: o.result,
    recordedAt: ts,
    startedAt: ts,
    finishedAt: new Date(ctx.now.getTime() + (o.durationMs ?? 0))
      .toISOString()
      .replace(/\.\d+Z$/, 'Z'),
    ...(o.durationMs !== undefined ? { durationMs: o.durationMs } : {}),
    revision: { commit: ctx.commit },
    components: o.components.map((c) => ({ ...c, label: compLabel(c.origin) })),
    ...(o.identity ? { identity: o.identity } : {}),
    approvals:
      recLabel === 'LIVE-VERIFIED'
        ? s.approvals.map((id) => ({
            id,
            ref: ctx.approvals.recorded.get(id.toUpperCase())?.reference ?? 'unrecorded',
            recordedIn: 'docs/parallel/OWNER-APPROVAL-PACK.md#6',
          }))
        : [],
    inputs: o.inputs ?? [],
    outputs: o.outputs ?? [],
    cost: {
      currency: 'USD',
      unit: 'micro',
      usedMinor: String(o.usedMicroUsd ?? 0),
      maxMinor: String(s.maxCostMicroUsd),
    },
    checks: o.checks.map((c) => ({
      ...c,
      label:
        recLabel === 'LIVE-VERIFIED'
          ? 'LIVE-VERIFIED'
          : recLabel === 'NOT VERIFIED'
            ? 'NOT VERIFIED'
            : 'SIMULATED',
      result: c.result,
    })),
    blockers: o.blockers ?? [],
    details: o.details,
  };
}

export async function runHarness(opts: HarnessOptions): Promise<HarnessReport> {
  const root = opts.root ?? repoRoot();
  const approvals = opts.approvals ?? loadApprovals(root);
  const sim = opts.simulated ?? SIMULATED_DRIVERS;
  const live = opts.live ?? LIVE_DRIVERS;
  const list = (opts.scenarios ?? SCENARIOS).filter((s) => !opts.only || opts.only.includes(s.id));
  const now = opts.now ?? (() => new Date());
  const commit = opts.commit ?? head(root);
  const schemas = loadSchemas(root);
  const stateFile = join(opts.outDir, 'state.json');
  const state: HarnessState =
    existsSync(stateFile) &&
    (JSON.parse(readFileSync(stateFile, 'utf8')) as HarnessState).mode === opts.mode
      ? (JSON.parse(readFileSync(stateFile, 'utf8')) as HarnessState)
      : { schema: 'nuzm.qualification-state/1', mode: opts.mode, scenarios: {} };
  const save = () => {
    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  };
  const outcomes: ScenarioOutcome[] = [];
  const liveDone = new Set<string>(
    Object.entries(state.scenarios)
      .filter(([, e]) => opts.mode === 'live' && e.status === 'done' && e.label === 'LIVE-VERIFIED')
      .map(([id]) => id),
  );
  let stoppedAt: HarnessReport['stoppedAt'] = null;
  let failed = false;

  for (const s of list) {
    if (opts.mode === 'live' && isOfflineOnly(s)) {
      outcomes.push({ id: s.id, status: 'skipped-offline-only' });
      continue;
    }
    // resume: a finished scenario whose record still verifies and is unchanged is not run again
    const prior = state.scenarios[s.id];
    if (prior?.status === 'done') {
      const file = recordPath(opts.outDir, s, prior);
      if (file && existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as EvidenceRecord;
        const v = verifyRecord(raw, { schemas, dir: dirname(file), placement: null }, file);
        if (v.ok && raw.contentHash === prior.contentHash) {
          outcomes.push({
            id: s.id,
            status: 'resumed',
            label: raw.label,
            result: raw.result,
            recordFile: file,
          });
          continue;
        }
      }
    }
    let driver;
    let label: Label;
    if (opts.mode === 'live') {
      const blockers = blockersOf(s, approvals, liveDone, live);
      if (blockers.length > 0) {
        const blocker = blockers.join(' | ');
        state.scenarios[s.id] = { status: 'stopped', blocker };
        save();
        outcomes.push({ id: s.id, status: 'stopped', blocker });
        stoppedAt = { id: s.id, blocker };
        break; // nothing after the first blocker runs
      }
      driver = live[s.id]!;
      label = 'LIVE-VERIFIED';
    } else {
      driver = sim[s.id];
      label = 'SIMULATED';
      if (!driver) {
        outcomes.push({ id: s.id, status: 'stopped', blocker: `no simulated driver for ${s.id}` });
        failed = true;
        continue;
      }
    }
    const started = now();
    const out = await driver.run(s);
    const rec = seal(toRecord(s, out, label, { now: started, commit, approvals }));
    const rel = `${s.track}/${day(started)}-${rec.id as string}.json`;
    const abs = join(opts.outDir, rel);
    const v = verifyRecord(
      rec,
      {
        schemas,
        dir: dirname(abs),
        placement: { trackDir: s.track, fileName: `${day(started)}-${rec.id as string}.json` },
      },
      rel,
    );
    if (!v.ok) {
      // a record that does not verify is never written as evidence: the problems are the outcome
      outcomes.push({
        id: s.id,
        status: 'ran',
        label: rec.label as Label,
        result: 'FAIL',
        problems: v.problems.map((p) => `[${p.rule}] ${p.where}: ${p.message}`),
      });
      failed = true;
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(rec, null, 2) + '\n');
    state.scenarios[s.id] = {
      status: 'done',
      recordId: rec.id as string,
      contentHash: rec.contentHash,
      label: rec.label as Label,
      result: rec.result as string,
    };
    if (rec.label === 'LIVE-VERIFIED' && rec.result === 'PASS') liveDone.add(s.id);
    save();
    outcomes.push({
      id: s.id,
      status: 'ran',
      label: rec.label as Label,
      result: rec.result as string,
      recordFile: abs,
    });
    if (out.result === 'FAIL') failed = true;
  }
  save();
  return { mode: opts.mode, outcomes, stoppedAt, exitCode: stoppedAt ? 3 : failed ? 1 : 0 };
}

/** where a finished scenario's record was written: the date is in the file name, so it is found by listing the track directory */
function recordPath(outDir: string, s: Scenario, e: StateEntry): string | null {
  if (!e.recordId) return null;
  const dir = join(outDir, s.track);
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir);
  const n = names.find((x) => x.endsWith(`-${e.recordId}.json`));
  return n ? join(dir, n) : null;
}

export function renderReport(r: HarnessReport): string {
  const L = [`mode: ${r.mode.toUpperCase()}`, ''];
  for (const o of r.outcomes)
    L.push(
      `${o.status === 'stopped' ? 'STOP ' : o.status === 'skipped-offline-only' ? 'skip ' : o.status === 'resumed' ? 'resum' : 'ran  '} ${o.id}${o.label ? `  [${o.label}, ${o.result}]` : ''}${o.blocker ? `\n      blocker: ${o.blocker}` : ''}${o.problems ? `\n      REJECTED: ${o.problems.join('; ')}` : ''}`,
    );
  if (r.stoppedAt) L.push('', `STOPPED at ${r.stoppedAt.id}: ${r.stoppedAt.blocker}`);
  return L.join('\n');
}
