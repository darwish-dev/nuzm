import { builderTools } from '@nuzm/domain';
import { ProblemException } from '../../../../common/errors';
import {
  StepFailure,
  type FileOp,
  type LifecycleArtifacts,
  type LifecycleEnv,
  type LifecycleHost,
  type LifecycleState,
  type StepId,
} from './lifecycle.types';

const T = builderTools;
const P = builderTools.planning;

/** What a step reports. `passed` is only for the execution steps whose RESULT (build or tests) decides the route. */
export interface StepResult {
  summary: string;
  passed?: boolean;
}
export interface StepCtx {
  host: LifecycleHost;
  env: LifecycleEnv;
  /** the state when the step began (read only: the machine owns it) */
  state: LifecycleState;
  art: LifecycleArtifacts;
  step: StepId;
  /** every tool use goes through the registry: authorized, validated, recorded; a denial is a failed step with the registry's code */
  invoke<R>(tool: string, args: unknown, fn: () => Promise<R> | R): Promise<R>;
  signal?: AbortSignal;
}
export type StepFn = (c: StepCtx) => Promise<StepResult>;

const MAX_PROMPT = 4000;
const PROFILES_BUILD: builderTools.BuildProfile[] = ['typecheck', 'build'];
const PROFILES_TESTS: builderTools.BuildProfile[] = ['unit-tests'];
const need = <X>(v: X | undefined, what: string): X => {
  if (v === undefined) throw new StepFailure('missing_input', `${what} is missing`);
  return v;
};
const blockingRisks = new Set([
  'edits_applied_migration',
  'touches_ci_config',
  'changes_deploy_manifest',
]);

/** the previewed change must be safe AND not need a person: only an all-additions change (a new project) may be large; anything riskier stops for a human */
function gate(files: ReadonlyMap<string, string>, ops: FileOp[], hasHead: boolean) {
  const prev = T.previewChangeSet(files, ops, { hasHead });
  if (!prev.ok)
    throw new StepFailure(
      'change_rejected',
      prev.errors
        .slice(0, 3)
        .map((e) => `${e.code}@${e.at.slice(0, 80)}`)
        .join(','),
    );
  const additionsOnly = ops.every((o) => o.op === 'add');
  const blocked = additionsOnly
    ? prev.risks.filter((r) => blockingRisks.has(r.code))
    : prev.approval.required
      ? prev.risks.length > 0
        ? prev.risks
        : [{ code: 'large_change', message: '' }]
      : [];
  if (blocked.length > 0)
    throw new StepFailure('needs_approval', blocked.map((r) => r.code).join(','));
  return prev;
}

/** runs the profiles in order and stops at the first one that is not a plain pass */
async function runProfiles(
  c: StepCtx,
  profiles: builderTools.BuildProfile[],
  phase: 'build' | 'rebuild' | 'tests',
): Promise<StepResult> {
  const build = c.env.build;
  if (!build) throw new StepFailure('build_unavailable');
  const versionId = need(c.art.appliedVersionId ?? c.art.baseVersionId ?? undefined, 'the version');
  const runs: NonNullable<LifecycleArtifacts['lastBuild']>['runs'] = [];
  let failedLogs = '';
  let passed = true;
  for (const profile of profiles) {
    const res = await c.invoke('request_execution', { profile }, () =>
      build.build({
        projectId: c.host.projectId,
        versionId,
        profile,
        orgId: c.host.orgId,
        runId: c.host.runId,
      }),
    );
    runs.push({ profile, status: res.status, durationMs: res.durationMs });
    // every execution is metered, whatever its outcome (idempotent per run, phase, round and profile)
    await c.env.budget.meter(c.host.orgId, c.host.projectId, {
      eventKey: `${c.host.runId}:${phase}:${c.state.repairRound}:${profile}`,
      profile,
      durationMs: res.durationMs,
      origin: build.origin,
      at: c.state.steps[c.step].startedAt ?? c.host.now(),
    });
    if (res.status === 'timeout') throw new StepFailure('build_timeout');
    if (res.status === 'terminated') throw new StepFailure('build_terminated');
    if (res.status === 'refused') throw new StepFailure('build_refused', res.logs.slice(0, 120));
    if (res.status === 'failed') {
      passed = false;
      failedLogs = res.logs;
      break;
    }
  }
  c.art.executionOrigin = build.origin;
  c.art.lastBuild = {
    phase,
    passed,
    runs,
    diagnostics: passed
      ? []
      : T.diagnoseBuildLog(failedLogs).slice(0, T.REPAIR_LIMITS.maxDiagnosticsKept),
  };
  return {
    passed,
    summary: `${runs.map((r) => `${r.profile}:${r.status}`).join(', ')}${build.origin === 'MOCK' ? ' (simulated)' : ''}`,
  };
}

function summarizeReview(
  files: ReadonlyMap<string, string>,
  plan: LifecycleArtifacts['plan'],
): NonNullable<LifecycleArtifacts['review']> {
  const r = T.reviewProject(files, plan ? { plan } : {});
  return {
    errors: r.summary.errors,
    warnings: r.summary.warnings,
    infos: r.summary.infos,
    top: r.findings
      .filter((f) => f.severity !== 'info')
      .slice(0, T.REPAIR_LIMITS.maxDiagnosticsKept),
  };
}

export const STEP_FNS: Record<StepId, StepFn> = {
  async requirements(c) {
    const prompt = c.host.input.prompt.trim();
    if (prompt.length === 0 || prompt.length > MAX_PROMPT)
      throw new StepFailure('invalid_input', `the brief needs 1..${MAX_PROMPT} characters`);
    const a = await c.invoke('analyze_requirements', { text: prompt }, () =>
      P.analyzeRequirements(prompt),
    );
    c.art.analysis = {
      productType: a.productType,
      locale: a.locale,
      confidence: a.confidence,
      features: a.features,
      impliedFeatures: a.impliedFeatures,
      questions: a.questions,
      ambiguities: a.ambiguities,
      notes: a.notes,
    };
    return {
      summary: `${a.productType}, ${a.features.length + a.impliedFeatures.length} features, ${a.questions.length} open questions`,
    };
  },

  async project_analysis(c) {
    const { files } = await c.env.head();
    const paths = await c.invoke('list_files', undefined, () => [...files.keys()]);
    let symbols = 0;
    let components = 0;
    let unresolved = 0;
    const codeFiles = paths.filter(T.isCodePath);
    if (codeFiles.length > 0) {
      await c.invoke('find_symbols', { query: '' }, () => {
        for (const p of codeFiles.slice(0, T.INTEL_LIMITS.maxFiles))
          symbols += T.extractSymbols(p, files.get(p) ?? '').length;
      });
      components = await c.invoke(
        'list_components',
        undefined,
        () => T.discoverComponents(files).length,
      );
      unresolved = await c.invoke(
        'analyze_imports',
        undefined,
        () => T.analyzeImports(files).unresolved.length,
      );
    }
    const mem = await c.invoke('read_memory', undefined, () => T.memoryFromFiles(files));
    const memoryEntries = mem.ok ? T.activeEntries(mem.value).length : 0;
    c.art.project = {
      files: paths.length,
      codeFiles: codeFiles.length,
      symbols,
      components,
      unresolvedImports: unresolved,
      memoryEntries,
      empty: paths.length === 0,
    };
    return {
      summary: paths.length === 0 ? 'empty project' : `${paths.length} files, ${symbols} symbols`,
    };
  },

  async architecture(c) {
    need(c.art.analysis, 'the analysis');
    const prompt = c.host.input.prompt;
    const plan = await c.invoke('choose_architecture', { analysis: c.art.analysis }, () =>
      P.buildPlan(P.analyzeRequirements(prompt), prompt),
    );
    c.art.architecture = {
      productType: plan.productType,
      stackId: plan.stack.id,
      parts: plan.stack.parts,
      reason: plan.stack.reason,
    };
    return { summary: `${plan.productType} on ${plan.stack.id} (${plan.stack.reason})` };
  },

  async plan(c) {
    const prompt = c.host.input.prompt;
    const plan = await c.invoke('build_plan', { analysis: c.art.analysis }, () =>
      P.planFromText(prompt),
    );
    const ok = P.validatePlan(plan);
    if (!ok.ok)
      throw new StepFailure(
        'plan_invalid',
        ok.problems
          .slice(0, 3)
          .map((p) => p.at)
          .join(','),
      );
    if (plan.fileCount > c.state.limits.maxGeneratedFiles)
      throw new StepFailure('plan_too_large', `${plan.fileCount} files`);
    c.art.plan = plan;
    return {
      summary: `${plan.tasks.length} tasks in ${plan.waves} waves, ${plan.fileCount} files`,
    };
  },

  async tasks(c) {
    const plan = need(c.art.plan, 'the plan');
    const ordered = await c.invoke('derive_tasks', { plan }, () =>
      [...plan.tasks].sort((a, b) => a.wave - b.wave),
    );
    // the order must respect dependencies: a task never comes before one it depends on
    const seen = new Set<string>();
    for (const t of ordered) {
      if (t.dependsOn.some((d) => !seen.has(d) && plan.tasks.some((x) => x.id === d)))
        throw new StepFailure('plan_invalid', 'task order');
      seen.add(t.id);
    }
    const approvals = plan.approvals.length;
    return {
      summary: `${ordered.length} tasks${approvals > 0 ? `, ${approvals} need approval when applied` : ''}`,
    };
  },

  async file_generation(c) {
    const plan = need(c.art.plan, 'the plan');
    const { files } = await c.env.head();
    const existing = new Set(files.keys());
    const mem = T.memoryFromFiles(files);
    const memory = mem.ok
      ? T.renderMemory(T.selectRelevant(mem.value, c.host.input.prompt), 600)
      : '';
    const produced = new Set<string>();
    const lists: FileOp[][] = [];
    const tasks = [...plan.tasks].sort((a, b) => a.wave - b.wave);
    for (const task of tasks) {
      if (await c.host.cancelled()) throw new StepFailure('cancelled');
      const todo = {
        ...task,
        files: task.files.filter((p) => !existing.has(p) && !produced.has(p)),
      };
      if (todo.files.length === 0) continue;
      const out = await c.invoke('propose_files', { tasks: [task.id] }, () =>
        c.env.generator.generate(
          {
            plan,
            task: todo,
            existingPaths: [...existing],
            excerpts: [],
            memory,
            requirement: c.host.input.prompt,
          },
          files,
          c.signal,
        ),
      );
      for (const o of out.ops) produced.add(o.path);
      lists.push(out.ops);
      if (produced.size > c.state.limits.maxGeneratedFiles)
        throw new StepFailure('too_many_files', `${produced.size}`);
    }
    const ops = T.lifecycle.mergeOps(...lists);
    c.art.generator = c.env.generator.kind;
    c.art.generatedFiles = ops.length;
    c.art.changeSetRef = await c.host.storeArtifact('change_set', ops);
    return {
      summary: `${ops.length} files (${c.env.generator.kind === 'skeleton' ? 'placeholders, simulated' : 'model'})`,
    };
  },

  async change_apply(c) {
    const ref = need(c.art.changeSetRef, 'the change set');
    const ops = (await c.host.loadArtifact(ref)) as FileOp[] | null;
    if (!Array.isArray(ops)) throw new StepFailure('checkpoint_missing');
    const head = await c.env.head();
    c.art.baseVersionId = head.versionId;
    if (ops.length === 0) {
      // nothing to add (every promised file already exists): the project stays at its head
      c.art.appliedVersionId = head.versionId ?? undefined;
      return { summary: 'no change needed' };
    }
    await c.invoke('preview_change', { ops }, () => gate(head.files, ops, head.versionId !== null));
    const v = await c.invoke('apply_change', { ops, label: 'builder' }, () =>
      c.env.apply(ops, `Builder lifecycle ${c.host.runId.slice(0, 8)}`),
    );
    c.art.appliedVersionId = v.versionId;
    return { summary: `${ops.length} files applied as version ${v.versionId.slice(0, 8)}` };
  },

  async review(c) {
    const { files } = await c.env.head();
    const plan = c.art.plan;
    const r = await c.invoke('review_project', undefined, () => summarizeReview(files, plan));
    c.art.review = r;
    return { summary: `${r.errors} errors, ${r.warnings} warnings` };
  },

  async execution_request(c) {
    const build = c.env.build;
    if (!build) throw new StepFailure('build_unavailable');
    const gates = await c.env.budget.assertStart(c.host.orgId, 'ai_run_build');
    const versionId = need(
      c.art.appliedVersionId ?? c.art.baseVersionId ?? undefined,
      'the version',
    );
    if (build.preflight)
      for (const profile of [...PROFILES_BUILD, ...PROFILES_TESTS]) {
        const d = await build.preflight({
          projectId: c.host.projectId,
          versionId,
          profile,
          orgId: c.host.orgId,
          runId: c.host.runId,
        });
        if (!d.allowed) throw new StepFailure('build_refused', d.reasons.slice(0, 3).join(','));
        if (d.requiresApproval) throw new StepFailure('approval_required', profile);
      }
    c.art.executionOrigin = build.origin;
    return {
      summary: `allowed (${gates.gates.join(', ')})${build.origin === 'MOCK' ? ', simulated' : ''}`,
    };
  },

  build: (c) => runProfiles(c, PROFILES_BUILD, 'build'),

  async error_analysis(c) {
    const b = need(c.art.lastBuild, 'the build result');
    const ds = b.diagnostics;
    const fp = T.fingerprint(ds);
    const seen = c.art.fingerprints ?? [];
    // the same failure after a repair means the repair did not help: stop instead of looping
    if (ds.length > 0 && seen[seen.length - 1] === fp) throw new StepFailure('no_progress');
    c.art.fingerprints = [...seen, fp].slice(-6);
    await c.invoke('diagnose_build', { logs: '' }, () => ds);
    return { summary: `${ds.length} diagnostics` };
  },

  async repair(c) {
    const head = await c.env.head();
    const b = need(c.art.lastBuild, 'the build result');
    const proposal = await c.invoke('propose_repair', { diagnostics: b.diagnostics }, () =>
      c.env.repair.propose({
        iteration: c.state.repairRound,
        files: head.files,
        findings: c.art.review?.top ?? [],
        diagnostics: b.diagnostics,
        rejected: [],
      }),
    );
    if (!proposal || proposal.ops.length === 0) throw new StepFailure('strategy_gave_up');
    c.art.repairRef = await c.host.storeArtifact('change_set', proposal.ops);
    c.art.repairNote = proposal.note?.slice(0, 200);
    return { summary: `${proposal.ops.length} operations proposed` };
  },

  async repair_apply(c) {
    const ref = need(c.art.repairRef, 'the repair');
    const ops = (await c.host.loadArtifact(ref)) as FileOp[] | null;
    if (!Array.isArray(ops)) throw new StepFailure('checkpoint_missing');
    const head = await c.env.head();
    await c.invoke('preview_change', { ops }, () => gate(head.files, ops, true));
    const v = await c.invoke('apply_change', { ops, label: 'repair' }, () =>
      c.env.apply(ops, `Repair round ${c.state.repairRound} (${c.host.runId.slice(0, 8)})`),
    );
    c.art.appliedVersionId = v.versionId;
    c.art.repairedVersions = [...(c.art.repairedVersions ?? []), v.versionId].slice(-5);
    // the findings the next round works from are those of the repaired project, not the old one
    const after = await c.env.head();
    c.art.review = summarizeReview(after.files, c.art.plan);
    return { summary: `${ops.length} operations applied as version ${v.versionId.slice(0, 8)}` };
  },

  rebuild: (c) => runProfiles(c, PROFILES_BUILD, 'rebuild'),

  tests: (c) => runProfiles(c, PROFILES_TESTS, 'tests'),

  async preview(c) {
    const { files } = await c.env.head();
    const bytes = [...files.values()].reduce((n, t) => n + t.length, 0);
    const entry =
      ['index.html', 'app/page.tsx', 'src/main.tsx', 'src/index.ts', 'lib/main.dart'].find((p) =>
        files.has(p),
      ) ?? null;
    await c.invoke('preview_change', { ops: [] }, () => undefined);
    // a live preview URL needs the preview origin (ADR-060/063) and is requested from the deployments screen: this step only describes what there is to preview
    c.art.preview = { files: files.size, bytes, entry, previewUrl: null };
    return { summary: `${files.size} files${entry ? `, entry ${entry}` : ''}` };
  },

  async deployment_preparation(c) {
    const { files } = await c.env.head();
    const plan = need(c.art.plan, 'the plan');
    const lb = c.art.lastBuild;
    const ev: builderTools.lifecycle.Evidence = {
      reviewErrors: c.art.review?.errors ?? 0,
      reviewWarnings: c.art.review?.warnings ?? 0,
      buildPassed: lb !== undefined && (lb.phase === 'tests' || lb.passed),
      testsPassed: lb?.phase === 'tests' && lb.passed,
      origin: c.art.executionOrigin ?? 'MOCK',
    };
    const d = await c.invoke('prepare_deployment', { plan }, () =>
      T.lifecycle.prepareDeployment(files, plan, ev),
    );
    c.art.deployment = d;
    return {
      summary: `${d.target}, ${d.readiness}${d.blockers.length ? ` (${d.blockers.join(', ')})` : ''}`,
    };
  },

  async deployment_approval(c) {
    const d = need(c.art.deployment, 'the deployment plan');
    const summary = {
      kind: 'builder_lifecycle_deployment',
      runId: c.host.runId,
      projectId: c.host.projectId,
      versionId: c.art.appliedVersionId ?? null,
      target: d.target,
      readiness: d.readiness,
      blockers: d.blockers,
      envVars: d.envVars,
      evidence: d.evidence,
    };
    try {
      const a = await c.invoke('request_deploy_approval', { summary }, () =>
        c.env.requestDeployApproval(summary),
      );
      c.art.approvalId = a.id;
    } catch (e) {
      if (e instanceof ProblemException && e.code === 'forbidden')
        throw new StepFailure('permission_denied');
      throw e;
    }
    // the runner parks here: the lifecycle never deploys, a person decides
    return { summary: 'approval requested' };
  },
};
