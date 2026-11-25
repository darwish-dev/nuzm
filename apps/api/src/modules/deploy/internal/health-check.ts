/**
 * Health checks and failure recovery for a deployment (Phase 3, P3-S07). Pure with injected probe, sleep and clock: no network, no timers of its own, so the same code runs
 * against the SIMULATED node and, unchanged, against a real one. A result obtained over a stand-in probe is SIMULATED; this file never labels anything LIVE-VERIFIED.
 *
 *   waitUntilHealthy     the page must answer 200 on `requiredConsecutive` probes in a row within `attempts` (a freshly switched site may need a moment: one 200 is not stable)
 *   watchDuringSwitch    probe the live URL concurrently with the switch and count every non-200 (spec section 4.5 question 2: does any request see 404/502 while the root changes?)
 *   recoverToLastGood    after a failed release: make sure the PREVIOUS release serves again (verified by content hash), and say exactly what was done
 */
import type { Artifact, TargetSite } from './ports';
import type { HostingTargetPublisher } from './hosting-target';

export type ProbeFn = (path: string) => Promise<number>;
export interface HealthPolicy {
  /** pages that must answer 200 */
  paths: string[];
  attempts: number;
  /** wait between attempts (ms); injected `sleep` keeps tests instant */
  delayMs: number;
  /** consecutive all-200 rounds needed to call it stable */
  requiredConsecutive: number;
}
export const DEFAULT_HEALTH_POLICY: Omit<HealthPolicy, 'paths'> = {
  attempts: 6,
  delayMs: 2000,
  requiredConsecutive: 2,
};

export interface HealthVerdict {
  healthy: boolean;
  rounds: number;
  /** the last round's status per path (0 = a TLS or network failure, never a 200) */
  last: { path: string; status: number }[];
  /** how the verdict came about, in words, for the log and the evidence record */
  reason: string;
}

/** a probe that throws (even synchronously) or rejects is status 0, never a pass */
const safeStatus = (probe: ProbeFn, path: string): Promise<number> =>
  Promise.resolve()
    .then(() => probe(path))
    .catch(() => 0);

export async function waitUntilHealthy(
  probe: ProbeFn,
  policy: HealthPolicy,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<HealthVerdict> {
  if (policy.paths.length === 0) throw new Error('a health policy needs at least one path');
  if (policy.attempts < 1 || policy.requiredConsecutive < 1)
    throw new Error('attempts and requiredConsecutive must be at least 1');
  let streak = 0;
  let last: HealthVerdict['last'] = [];
  for (let round = 1; round <= policy.attempts; round++) {
    last = [];
    for (const path of policy.paths) {
      // a thrown probe is a failure (status 0), never a pass
      const status = await safeStatus(probe, path);
      last.push({ path, status });
    }
    streak = last.every((r) => r.status === 200) ? streak + 1 : 0;
    if (streak >= policy.requiredConsecutive)
      return {
        healthy: true,
        rounds: round,
        last,
        reason: `${streak} consecutive rounds with every page at 200`,
      };
    if (round < policy.attempts) await sleep(policy.delayMs);
  }
  const bad = last.filter((r) => r.status !== 200).map((r) => `${r.path}=${r.status}`);
  return {
    healthy: false,
    rounds: policy.attempts,
    last,
    reason: bad.length
      ? `not healthy after ${policy.attempts} rounds: ${bad.join(', ')}`
      : `answered 200 but never ${policy.requiredConsecutive} rounds in a row`,
  };
}

export interface SwitchWatch {
  samples: number;
  /** every sampled status in the order it was observed (bounded by workers x samples) */
  sequence: number[];
  /** every sample that was not 200 */
  bad: { sample: number; status: number }[];
  switched: boolean;
  /** a clean window is evidence for THIS run only: it never proves atomicity in general */
  clean: boolean;
}

/**
 * Run `doSwitch` while `parallel` workers keep probing `path`, `perWorker` times each. Resolves after both the switch and every probe finished. The probe sees the live URL, so a
 * missing document root shows up as a 404/502/0 sample. Concurrency is cooperative (a real probe awaits the network), which is what makes the window observable.
 */
export async function watchDuringSwitch(
  probe: ProbeFn,
  doSwitch: () => Promise<void>,
  opts: { path?: string; parallel?: number; perWorker?: number } = {},
): Promise<SwitchWatch> {
  const path = opts.path ?? '/';
  const parallel = Math.max(1, opts.parallel ?? 4);
  const perWorker = Math.max(1, opts.perWorker ?? 25);
  const bad: SwitchWatch['bad'] = [];
  const sequence: number[] = [];
  let samples = 0;
  let done = false;
  const worker = async () => {
    for (let i = 0; i < perWorker || !done; i++) {
      const status = await safeStatus(probe, path);
      const n = ++samples;
      sequence.push(status);
      if (status !== 200) bad.push({ sample: n, status });
      if (i >= perWorker * 4) break; // hard stop: the switch itself never finished
    }
  };
  const workers = Array.from({ length: parallel }, worker);
  let switched = false;
  const sw = (async () => {
    try {
      await doSwitch();
      switched = true;
    } finally {
      done = true;
    }
  })();
  await Promise.all([sw.catch(() => undefined), ...workers]);
  return { samples, sequence, bad, switched, clean: switched && bad.length === 0 };
}

/**
 * A HALF STATE is a request that failed although the site was already serving: any non-200 AFTER the first 200, or any 5xx / connection failure at all. A 404 BEFORE the first
 * 200 is not one (before the first switch nothing is live). Returns the offending samples (statuses, in order).
 */
export function halfStates(sequence: readonly number[]): number[] {
  const out: number[] = [];
  let seen200 = false;
  for (const s of sequence) {
    if (s === 200) seen200 = true;
    else if (seen200 || s >= 500 || s === 0) out.push(s);
  }
  return out;
}

export interface RecoveryReport {
  /** what was serving before recovery began (hash), `null` = nothing or unreadable */
  servedBefore: string | null;
  action: 'none_needed' | 'switched_back' | 'reuploaded' | 'failed';
  /** the hash served after recovery */
  servedAfter: string | null;
  /** the failed release was removed from the node (it never was live) */
  failedReleaseDiscarded: boolean;
  detail: string;
}

/**
 * After a failed release, the last good artifact must be the one served: read what the node serves (by hash, from the node), and only when that is not the last good one switch
 * back to a retained release or upload it again (`restore`). The failed release is discarded unless it is the live one. Never throws: a recovery that fails says so in the report.
 */
export async function recoverToLastGood(
  publisher: HostingTargetPublisher,
  site: TargetSite,
  lastGood: Artifact | null,
  failedReleaseId: string | null,
): Promise<RecoveryReport> {
  // unreadable is treated as "unknown": recovery then acts instead of assuming
  const servedBefore = await publisher.activeHash(site).catch(() => null);
  const rep: RecoveryReport = {
    servedBefore,
    action: 'none_needed',
    servedAfter: servedBefore,
    failedReleaseDiscarded: false,
    detail: '',
  };
  try {
    if (lastGood && servedBefore !== lastGood.hash) {
      const had = (await publisher.transport.listReleases(site)).length;
      await publisher.restore(site, lastGood);
      rep.action =
        (await publisher.transport.listReleases(site)).length > had
          ? 'reuploaded'
          : 'switched_back';
    }
    rep.servedAfter = await publisher.activeHash(site);
    if (lastGood && rep.servedAfter !== lastGood.hash) {
      rep.action = 'failed';
      rep.detail = 'the node does not serve the last good artifact after recovery';
    }
    if (failedReleaseId) {
      try {
        await publisher.discard(site, failedReleaseId);
        rep.failedReleaseDiscarded = !(await publisher.transport.hasRelease(site, failedReleaseId));
      } catch {
        rep.failedReleaseDiscarded = false;
      }
    }
    if (!rep.detail)
      rep.detail =
        rep.action === 'none_needed'
          ? 'the last good release was still serving'
          : `served again by ${rep.action === 'switched_back' ? 'switching to the retained release' : 'uploading it again'}`;
  } catch (e) {
    rep.action = 'failed';
    rep.servedAfter = null;
    rep.detail = `recovery failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  return rep;
}
