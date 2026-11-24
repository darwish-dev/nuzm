import {
  AnthropicModelAdapter,
  CLAUDE_MODEL_ID,
  ModelAdapterError,
  CLAUDE_PROVIDER_ID,
  QUALIFICATION_TRACKS,
  evidenceFileName,
  runQualification,
  trackWorstCase,
  twinTarget,
  validateEvidence,
  tokenCostNano,
  type LiveSuiteApproval,
  type LiveTarget,
  type ModelAdapter,
  type QualificationEvidence,
  type QualificationTrack,
} from '@nuzm/adapter-model';
import { loadAiConfig } from './model';
import { evaluateSmokeGates, type SmokeArgs, type SmokeDeps } from './live-smoke';

/**
 * Qualification tracks A (provider connection), B (tool calling) and C (code generation) as an operator command. The track logic and the evidence record are in
 * `@nuzm/adapter-model` (`qualification.ts`); this file adds the SAME gates as the smoke runner, before the key is read:
 *   no flag      → refuses unless every gate holds (D2, D3, D4, D5, D6, D9 evidence, live gate, recorded approval, vault reference), then prints a DRY RUN plan; nothing is sent;
 *   `--twin`     → runs the track against the MOCK TWIN (no key, no network, no evidence needed): the verdict is `SIMULATED`;
 *   `--execute`  → with every gate: reads the sealed key, runs the track against the real adapter, returns the evidence record (verdict `LIVE-VERIFIED` only when every check passed).
 * The evidence record holds ids, tokens, cost, latency, outcomes and fixed sentences: no prompt, no completion, no key (checked before it is returned).
 */
export interface QualifyArgs extends Omit<SmokeArgs, 'vendorUsage' | 'usageToleranceTokens'> {
  track: QualificationTrack;
  twin: boolean;
}
export type QualifyResult =
  | { kind: 'refused'; problems: string[] }
  | {
      kind: 'dry_run';
      plan: {
        track: QualificationTrack;
        trackName: string;
        provider: string;
        model: string;
        worstCase: ReturnType<typeof trackWorstCase>;
        maxCostNano: string;
        decisionsStanding: string[];
        evidenceFile: string;
        message: string;
      };
    }
  | { kind: 'ran'; evidence: QualificationEvidence; fileName: string };

export const isTrack = (x: unknown): x is QualificationTrack =>
  x === 'A' || x === 'B' || x === 'C' || x === 'D' || x === 'E';

export async function runQualificationCommand(
  a: QualifyArgs,
  d: SmokeDeps,
): Promise<QualifyResult> {
  if (!isTrack(a.track))
    return { kind: 'refused', problems: ['the track must be A, B, C, D or E'] };
  const w = trackWorstCase(a.track);
  // ---- the mock twin: nothing leaves the process, no gate applies; the approval is a synthetic one that covers exactly the track's worst case
  if (a.twin) {
    const { target, primary } = twinTarget();
    // track D needs a refusal to map: the twin stands in for the vendor's 400 (SIMULATED: nothing real is verified)
    if (a.track === 'D')
      primary.failNext(
        new ModelAdapterError('invalid_request', 'the twin refused the oversized ceiling', false),
        1,
      );
    const approval: LiveSuiteApproval = {
      ref: 'twin-synthetic',
      approvedBy: 'twin',
      environment: 'non-production',
      maxRequests: w.requests,
      maxTotalTokens: w.totalTokens,
      maxCostNano: tokenCostNano(w.inputTokens, w.outputTokens, target.adapter.pricing).toString(),
    };
    const evidence = await runQualification(a.track, target, approval, {
      ...(d.now ? { now: d.now } : {}),
    });
    return finish(evidence, null);
  }
  const make =
    d.makeAdapter ??
    ((getApiKey) =>
      new AnthropicModelAdapter({
        getApiKey,
        contract: '1.1',
        liveEnabled: () => loadAiConfig(d.env).liveProviders.includes(CLAUDE_PROVIDER_ID),
      }) as ModelAdapter);
  const probe = make(async () => null);
  const g = evaluateSmokeGates(a, d.env, probe, d.now?.(), w);
  if (g.problems.length > 0 || !g.approval) return { kind: 'refused', problems: g.problems };
  const proto = {
    track: a.track,
    provider: a.provider,
    startedAt: (d.now?.() ?? new Date()).toISOString(),
    mode: 'live' as const,
  };
  if (!a.execute)
    return {
      kind: 'dry_run',
      plan: {
        track: a.track,
        trackName: QUALIFICATION_TRACKS[a.track].name,
        provider: a.provider,
        model: d.model ?? CLAUDE_MODEL_ID,
        worstCase: w,
        maxCostNano: tokenCostNano(w.inputTokens, w.outputTokens, probe.pricing).toString(),
        decisionsStanding: g.standing,
        evidenceFile: evidenceFileName(proto),
        message:
          'dry run: every gate holds and nothing was sent. Run again with --execute to make real requests.',
      },
    };
  let key: string | null = null;
  const adapter = make(async () => {
    key ??= await d.readKey(a.vaultRef as string);
    return key;
  });
  const target: LiveTarget = { adapter, model: d.model ?? CLAUDE_MODEL_ID, mode: 'live' };
  const evidence = await runQualification(a.track, target, g.approval, {
    liveProviders: loadAiConfig(d.env).liveProviders,
    evidence: a.evidence,
    ...(d.now ? { now: d.now } : {}),
  });
  return finish(evidence, key);
}

/** The record is checked before it is returned: well-formed, and free of the credential. */
function finish(evidence: QualificationEvidence, key: string | null): QualifyResult {
  const problems = validateEvidence(evidence);
  if (problems.length > 0)
    return {
      kind: 'refused',
      problems: ['the evidence record was not valid and was discarded', ...problems],
    };
  if (key && JSON.stringify(evidence).includes(key))
    return {
      kind: 'refused',
      problems: ['the evidence record contained the credential and was discarded'],
    };
  return { kind: 'ran', evidence, fileName: evidenceFileName(evidence) };
}
