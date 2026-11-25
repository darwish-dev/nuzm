import { builderTools } from '@nuzm/domain';
import { ModelFileGenerator } from './file-generators';
import { LifecycleRunner } from './lifecycle.runner';
import { MemoryEnv, MemoryHost } from './lifecycle.testing';
import type { LifecycleState } from './lifecycle.types';

/**
 * Tracks C (real model code generation) and E (real build + automated repair): runnable, SIMULATED today, REFUSING a live run without recorded approval evidence. This module holds
 * what both scripts share: the approval evidence check, the evidence record of a run, and the simulated runs. It contains NO provider or runtime code: a live run goes only through
 * the metered model gateway (S02) and S04's `ExecutionPort`/`BuildPort`, inside an environment where the owner approved them; nothing here can reach either.
 */
import {
  checkApprovalEvidence,
  REQUIRED_APPROVALS,
  type EvidenceCheck,
  type Track,
} from './approval-evidence';
export { checkApprovalEvidence, REQUIRED_APPROVALS, type EvidenceCheck, type Track };

/** The exact record a run (simulated or live) must leave. */
export interface EvidenceRecord {
  track: Track;
  /** SIMULATED: scripted model / mock execution. LIVE: only ever written by an owner-approved environment. */
  mode: 'SIMULATED' | 'LIVE';
  startedAt: string;
  model: { id: string; provider: string } | null;
  tokens: { in: number; out: number };
  /** integer minor units of the credit ledger, a decimal string */
  credits: string;
  /** provider cost in minor units when the rate card is known, else null (never guessed) */
  costMinor: string | null;
  filesGenerated: number;
  toolInvocations: { tool: string; step: string; caller: string; status: string }[];
  build: { profile: string; status: string; durationMs: number; origin: 'MOCK' | 'REAL' }[];
  repairRounds: number;
  durations: { totalMs: number; byStep: Record<string, number> };
  lifecycleStatus: string;
  label: string;
}

const SIM_LABEL =
  'SIMULATED: scripted model and mock execution; proves plumbing, accounting and limits, not model quality or that code builds';

function recordOf(
  track: Track,
  state: LifecycleState,
  host: MemoryHost,
  env: MemoryEnv,
  files: number,
  model: EvidenceRecord['model'],
  startedMs: number,
  builds: EvidenceRecord['build'],
): EvidenceRecord {
  const byStep: Record<string, number> = {};
  for (const s of Object.values(state.steps))
    if (s.startedAt && s.finishedAt)
      byStep[`${s.id}#r${s.round}`] = Math.max(
        0,
        Date.parse(s.finishedAt) - Date.parse(s.startedAt),
      );
  void env;
  return {
    track,
    mode: 'SIMULATED',
    startedAt: new Date(startedMs).toISOString(),
    model,
    tokens: { in: state.tokensIn, out: state.tokensOut },
    credits: state.credits,
    costMinor: null,
    filesGenerated: files,
    toolInvocations: state.invocations.map((i) => ({
      tool: i.tool,
      step: i.step,
      caller: i.caller,
      status: i.status,
    })),
    build: builds,
    repairRounds: state.repairRound,
    durations: { totalMs: Date.now() - startedMs, byStep },
    lifecycleStatus:
      state.status === 'running' ? (host.saved?.state.status ?? 'running') : state.status,
    label: SIM_LABEL,
  };
}

/** records every build the lifecycle requests (profile, status, duration, origin) around the env's build port */
function recordBuilds(env: MemoryEnv): EvidenceRecord['build'] {
  const builds: EvidenceRecord['build'] = [];
  const real = env.build!;
  env.build = {
    origin: real.origin,
    ...(real.preflight ? { preflight: real.preflight.bind(real) } : {}),
    async build(req) {
      const r = await real.build(req);
      builds.push({
        profile: req.profile,
        status: r.status,
        durationMs: r.durationMs,
        origin: real.origin,
      });
      return r;
    },
  };
  return builds;
}

/** Track C, simulated: the model-backed generator (the SAME class a live run uses) with a scripted completion that returns exactly the files of each task. */
export async function simulateTrackC(): Promise<EvidenceRecord> {
  const started = Date.now();
  const host = new MemoryHost();
  const env = new MemoryEnv();
  let calls = 0;
  env.modelBacked.file_generation = true;
  env.generator = new ModelFileGenerator(
    'SIMULATED-FENCE',
    async (message) => {
      calls += 1;
      const files = (/Write ONLY these files: (.*)\.\n/.exec(message)?.[1] ?? '')
        .split(', ')
        .filter(Boolean);
      const body = (p: string) =>
        p === 'package.json'
          ? '{"name":"app","version":"0.0.0"}\n'
          : p.endsWith('.json')
            ? '{}\n'
            : p.endsWith('.sql')
              ? '-- scripted\n'
              : p.endsWith('.md')
                ? '# scripted\n'
                : 'export {};\n';
      return {
        text: JSON.stringify({
          summary: 'scripted',
          patches: files.map((path) => ({ op: 'add', path, content: body(path) })),
        }),
        usage: { tokensIn: 700, tokensOut: 300, credits: '9' },
      };
    },
    (u) => {
      env.usage = {
        tokensIn: (env.usage.tokensIn ?? 0) + (u.tokensIn ?? 0),
        tokensOut: (env.usage.tokensOut ?? 0) + (u.tokensOut ?? 0),
        credits: String(BigInt(env.usage.credits ?? '0') + BigInt(u.credits ?? '0')),
      };
    },
  );
  const builds = recordBuilds(env);
  const out = await new LifecycleRunner().run(host, env);
  void calls;
  return recordOf(
    'C',
    out.state,
    host,
    env,
    out.artifacts.generatedFiles ?? 0,
    { id: 'scripted-simulated', provider: 'none' },
    started,
    builds,
  );
}

/** Track E, simulated: a project with a broken config, a mock build that fails once, the rule-based automated repair, a rebuild that passes. */
export async function simulateTrackE(): Promise<EvidenceRecord> {
  const started = Date.now();
  const host = new MemoryHost();
  const env = new MemoryEnv();
  env.files = new Map([
    ['tsconfig.json', '{"compilerOptions":{},}\n'],
    ['src/index.ts', 'export {};\n'],
  ]);
  env.versionId = '0198a3c0-aaaa-7000-8000-000000000000';
  const port = env.build as builderTools.ScriptedBuildPort;
  port.script(
    'typecheck',
    {
      status: 'failed',
      logs: 'tsconfig.json(1,1): error TS5083: cannot read file\n',
      durationMs: 1200,
    },
    { status: 'completed', durationMs: 900 },
  );
  const builds = recordBuilds(env);
  const out = await new LifecycleRunner().run(host, env);
  return recordOf(
    'E',
    out.state,
    host,
    env,
    out.artifacts.generatedFiles ?? 0,
    null,
    started,
    builds,
  );
}

export const LIVE_REFUSAL = (track: Track, check: EvidenceCheck): string =>
  check.ok
    ? `Track ${track} LIVE: approval evidence is complete, but this repository has NO live adapter wired into the script (no provider client, no runtime). A live run happens only inside the API of an environment where the owner approved the provider/runtime, with the flags on; it writes the same evidence record. Nothing was called.`
    : `Track ${track} LIVE REFUSED: missing approval evidence for ${check.missing.join(', ')}${check.reason ? ` (${check.reason})` : ''}. Required: ${REQUIRED_APPROVALS[track].map((a) => `${a.id} (${a.what})`).join('; ')}. Nothing was called.`;
