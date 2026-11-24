import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { builderTools } from '@nuzm/domain';
import { describe, expect, it } from 'vitest';
import { LifecycleRunner } from './lifecycle.runner';
import { MemoryEnv, MemoryHost } from './lifecycle.testing';

const T = builderTools;
const OUT = resolve(
  __dirname,
  '../../../../../../../docs/parallel/sessions/PHASE2-05-qualification-evidence.md',
);

/**
 * PHASE-2 S05 synthetic project qualification (offline). Five synthetic briefs are driven through the real lifecycle runner: prompt → analysis → plan → files → validated change →
 * review → build/test → preview → deployment preparation → deployment-approval request. Components: the model is ABSENT (deterministic placeholders), execution is the Execution
 * Gateway's MOCK port wrapped as a build port, deployment is NOT PERFORMED, persistence is in memory (the real DB, run engine and approvals are proved in
 * `builder-lifecycle.int.spec.ts` and `builder-lifecycle-engine.int.spec.ts`). Every row below is therefore SIMULATED evidence of plumbing and policy, never evidence that code builds.
 * Set S05_QUALIFICATION_WRITE=1 to regenerate the evidence document.
 */
const BRIEFS = [
  {
    id: 'business-website',
    title: 'Business website',
    prompt:
      'A website for my dental clinic with services, team, opening hours, a contact form, in Arabic and English',
    types: ['website', 'landing'],
  },
  {
    id: 'ecommerce-frontend',
    title: 'E-commerce frontend',
    prompt:
      'An online store frontend with products, a cart and checkout, sign in, and an admin dashboard',
    types: ['ecommerce'],
  },
  {
    id: 'full-stack-app',
    title: 'Full-stack app',
    prompt:
      'A full-stack task management app with a NestJS backend, Next.js frontend, PostgreSQL, user accounts and notifications',
    types: ['fullstack', 'saas', 'webapp'],
  },
  {
    id: 'erp-crm-module',
    title: 'ERP/CRM module',
    prompt:
      'A CRM module for a sales team with leads, customers, a deals pipeline, invoices and reports',
    types: ['crm', 'erp'],
  },
  {
    id: 'flutter-app',
    title: 'Flutter app',
    prompt:
      'A Flutter mobile app for booking barber appointments with push notifications and sign in',
    types: ['flutter', 'mobile'],
  },
] as const;

interface Row {
  id: string;
  title: string;
  productType: string;
  stack: string;
  tasks: number;
  files: number;
  steps: string[];
  status: string;
  review: string;
  executions: string;
  preview: string;
  deployment: string;
  approval: string;
  tokens: number;
}
const rows: Row[] = [];

describe.each(BRIEFS)('synthetic project: $title', (b) => {
  it('goes from the brief to a deployment-approval request, SIMULATED end to end', async () => {
    const host = new MemoryHost();
    host.input.prompt = b.prompt;
    const env = new MemoryEnv();
    const out = await new LifecycleRunner().run(host, env);
    const a = out.artifacts;
    expect(b.types as readonly string[], `detected ${a.analysis?.productType}`).toContain(
      a.analysis!.productType,
    );
    expect(out.status).toBe('waiting_approval');
    expect(host.steps.map((s) => s.step)).toHaveLength(14);
    expect(host.steps.every((s) => s.status === 'succeeded')).toBe(true);
    expect(out.state.repairRound).toBe(0);
    // one validated change with every planned file, nothing outside the plan
    expect(env.applied).toHaveLength(1);
    expect(env.applied[0]!.ops.length).toBe(a.plan!.fileCount);
    expect(a.generator).toBe('skeleton');
    expect(a.review!.errors).toBe(0);
    // three executions, all through the mock port, all labelled MOCK, none billed
    expect(a.executionOrigin).toBe('MOCK');
    expect(env.budget.metered.map((m) => m.profile)).toEqual(['typecheck', 'build', 'unit-tests']);
    expect(env.budget.metered.every((m) => m.origin === 'MOCK')).toBe(true);
    // the approval request says it is simulated, and nothing was deployed
    expect(a.deployment!.readiness).toBe('needs_attention');
    expect(a.deployment!.blockers).toContain('simulated_evidence');
    expect(env.approvalsRequested).toHaveLength(1);
    expect(env.approvalsRequested[0]).toMatchObject({
      kind: 'builder_lifecycle_deployment',
      readiness: 'needs_attention',
    });
    expect(out.state.tokensIn + out.state.tokensOut).toBe(0);
    expect(T.lifecycle.progress(out.state).total).toBe(14);

    rows.push({
      id: b.id,
      title: b.title,
      productType: a.analysis!.productType,
      stack: `${a.architecture!.stackId} (${a.architecture!.reason})`,
      tasks: a.plan!.tasks.length,
      files: a.generatedFiles ?? 0,
      steps: host.steps.map((s) => s.step),
      status: out.status,
      review: `${a.review!.errors} errors, ${a.review!.warnings} warnings`,
      executions: env.budget.metered.map((m) => `${m.profile} (${m.origin})`).join(', '),
      preview: `${a.preview!.files} files, entry ${a.preview!.entry ?? 'none'}`,
      deployment: `${a.deployment!.target}, ${a.deployment!.readiness} (${a.deployment!.blockers.join(', ')}), env names: ${a.deployment!.envVars.join(', ') || 'none'}`,
      approval: 'requested (production_deploy), not decided',
      tokens: out.state.tokensIn + out.state.tokensOut,
    });
  });
});

describe('evidence document', () => {
  it('is regenerated on request and covers all five projects', () => {
    expect(rows).toHaveLength(5);
    if (process.env.S05_QUALIFICATION_WRITE !== '1') return;
    const md = [
      '# PHASE2-05 — synthetic project qualification evidence (Session 05)',
      '',
      'Generated by `apps/api/src/modules/appbuilder/internal/lifecycle/qualification.spec.ts` (`S05_QUALIFICATION_WRITE=1`). **Every row is SIMULATED**: the model is absent (deterministic placeholders), execution is the Execution Gateway mock port, deployment is NOT PERFORMED. This documents plumbing, limits and policy, never that generated code builds or that a model writes good code.',
      '',
      '## Components and their evidence label',
      '| Component | What ran | Label |',
      '|---|---|---|',
      '| Requirement analysis, planning (14 product profiles), tasks | real code, deterministic | CODE (offline-verified) |',
      '| File generation | placeholders marked `SKELETON`, no model call, 0 tokens (the model-backed path is proved with a scripted provider in `builder-lifecycle.int.spec.ts`) | SIMULATED (model: scripted/none) |',
      '| Validated change apply, review | real change checks (`previewChangeSet`, `reviewProject`) on an in-memory project; the real DB/Git pipeline is proved in the integration specs | CODE (offline-verified) |',
      '| Build, test | `MockExecutionPort` behind `ExecutionBuildPort`: executes nothing, default scripted success | SIMULATED (exec: mock) |',
      '| Metering | mock executions are audited as not billed; a real execution would emit `builder.build_minutes` | SIMULATED |',
      '| Preview | a description of the project (file count, entry point); no preview URL requested | CODE |',
      '| Deployment preparation | target, env var NAMES, readiness with blockers; readiness is `needs_attention` because the evidence is simulated | SIMULATED |',
      '| Deployment approval | request created in memory here; the real approvals engine (owner/admin decides, developer refused) is proved in the integration spec | SIMULATED here, CODE in the integration spec |',
      '| Deployment | **NOT PERFORMED** | NOT VERIFIED |',
      '',
      '## Per project',
      '| Project | Detected type | Stack | Tasks | Files | Steps | Review | Executions (mock) | Preview | Deployment preparation | Approval |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| ${r.title} | ${r.productType} | ${r.stack} | ${r.tasks} | ${r.files} | ${r.steps.length} (${r.status}) | ${r.review} | ${r.executions} | ${r.preview} | ${r.deployment} | ${r.approval} |`,
      ),
      '',
      '## Limits shown by the integration specs on the real run engine (not repeated here)',
      'Cancellation (queued, mid-build, parked), repair exhaustion, refused and timed-out builds, token budget → `budget_exceeded`, crash recovery after a finished step and inside a build: `builder-lifecycle-engine.int.spec.ts` (10 tests).',
      '',
    ].join('\n');
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, md);
  });
});
