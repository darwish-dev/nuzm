import { LifecycleRunner } from './lifecycle.runner';
import { MemoryEnv, MemoryHost } from './lifecycle.testing';
import type { LifecycleArtifacts } from './lifecycle.types';

/**
 * PHASE-2 S05 synthetic project qualification (offline, no network, no database): five synthetic briefs are driven through the REAL lifecycle runner over in-memory ports. The model
 * is ABSENT (deterministic placeholders), execution is the Execution Gateway's MOCK port, deployment is NOT PERFORMED. Every result is SIMULATED evidence of plumbing and policy.
 */
export const BRIEFS = [
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

export interface QualificationRow {
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

export interface QualificationRun {
  brief: (typeof BRIEFS)[number];
  row: QualificationRow;
  artifacts: LifecycleArtifacts;
  host: MemoryHost;
  env: MemoryEnv;
  status: string;
  state: Awaited<ReturnType<LifecycleRunner['run']>>['state'];
}

export async function runQualification(): Promise<QualificationRun[]> {
  const out: QualificationRun[] = [];
  for (const b of BRIEFS) {
    const host = new MemoryHost();
    host.input.prompt = b.prompt;
    const env = new MemoryEnv();
    const res = await new LifecycleRunner().run(host, env);
    const a = res.artifacts;
    out.push({
      brief: b,
      artifacts: a,
      host,
      env,
      status: res.status,
      state: res.state,
      row: {
        id: b.id,
        title: b.title,
        productType: a.analysis?.productType ?? 'unknown',
        stack: a.architecture ? `${a.architecture.stackId} (${a.architecture.reason})` : 'none',
        tasks: a.plan?.tasks.length ?? 0,
        files: a.generatedFiles ?? 0,
        steps: host.steps.map((s) => s.step),
        status: res.status,
        review: a.review
          ? `${a.review.errors} errors, ${a.review.warnings} warnings`
          : 'not reached',
        executions:
          env.budget.metered.map((m) => `${m.profile} (${m.origin})`).join(', ') || 'none',
        preview: a.preview
          ? `${a.preview.files} files, entry ${a.preview.entry ?? 'none'}`
          : 'not reached',
        deployment: a.deployment
          ? `${a.deployment.target}, ${a.deployment.readiness} (${a.deployment.blockers.join(', ')}), env names: ${a.deployment.envVars.join(', ') || 'none'}`
          : 'not reached',
        approval: env.approvalsRequested.length
          ? 'requested (production_deploy), not decided'
          : 'not requested',
        tokens: res.state.tokensIn + res.state.tokensOut,
      },
    });
  }
  return out;
}

export const COMPONENTS: [string, string, string][] = [
  [
    'Requirement analysis, planning (14 product profiles), tasks',
    'real code, deterministic',
    'CODE (offline-verified)',
  ],
  [
    'File generation',
    'placeholders marked `SKELETON`, no model call, 0 tokens (the model-backed path is proved with a scripted provider in `builder-lifecycle.int.spec.ts`)',
    'SIMULATED (model: scripted/none)',
  ],
  [
    'Validated change apply, review',
    'real change checks (`previewChangeSet`, `reviewProject`) on an in-memory project; the real DB/Git pipeline is proved in the integration specs',
    'CODE (offline-verified)',
  ],
  [
    'Build, test',
    '`MockExecutionPort` behind `ExecutionBuildPort`: executes nothing, default scripted success',
    'SIMULATED (exec: mock)',
  ],
  [
    'Metering',
    'mock executions are audited as not billed; a real execution would emit `builder.build_minutes`',
    'SIMULATED',
  ],
  [
    'Preview',
    'a description of the project (file count, entry point); no preview URL requested',
    'CODE',
  ],
  [
    'Deployment preparation',
    'target, env var NAMES, readiness with blockers; readiness is `needs_attention` because the evidence is simulated',
    'SIMULATED',
  ],
  [
    'Deployment approval',
    'request created in memory here; the real approvals engine (owner/admin decides, developer refused) is proved in the integration spec',
    'SIMULATED here, CODE in the integration spec',
  ],
  ['Deployment', '**NOT PERFORMED**', 'NOT VERIFIED'],
];

const cell = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '');

/** the evidence tables as markdown (the document) */
export function renderMarkdown(rows: QualificationRow[]): string {
  return [
    '# PHASE2-05 — synthetic project qualification evidence (Session 05)',
    '',
    'Generated by `pnpm --filter @nuzm/api qualification:builder -- --write` (`apps/api/scripts/qualification-builder.ts`, runner in `internal/lifecycle/qualification.ts`). **Every row is SIMULATED**: the model is absent (deterministic placeholders), execution is the Execution Gateway mock port, deployment is NOT PERFORMED. This documents plumbing, limits and policy, never that generated code builds or that a model writes good code.',
    '',
    '## Components and their evidence label',
    '| Component | What ran | Label |',
    '|---|---|---|',
    ...COMPONENTS.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`),
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
}

/** the same evidence as plain text for a terminal */
export function renderText(rows: QualificationRow[]): string {
  const w = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  const line = (c: string[]) => c.join('  ');
  return [
    'Builder qualification (OFFLINE, no network): every row is SIMULATED. model: none/scripted · exec: mock · deploy: NOT PERFORMED',
    '',
    'COMPONENT EVIDENCE',
    ...COMPONENTS.map(([a, , c]) => line([w(cell(a), 58), cell(c)])),
    '',
    'PER PROJECT',
    line([
      w('project', 22),
      w('type', 10),
      w('files', 5),
      w('steps', 5),
      w('review', 20),
      w('executions', 44),
      w('deployment', 44),
    ]),
    ...rows.map((r) =>
      line([
        w(r.title, 22),
        w(r.productType, 10),
        w(String(r.files), 5),
        w(String(r.steps.length), 5),
        w(r.review, 20),
        w(r.executions, 44),
        w(r.deployment, 44),
      ]),
    ),
    '',
  ].join('\n');
}
