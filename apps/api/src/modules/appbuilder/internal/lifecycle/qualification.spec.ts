import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { builderTools } from '@nuzm/domain';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, runQualification, type QualificationRun } from './qualification';

const T = builderTools;
const OUT = resolve(
  __dirname,
  '../../../../../../../docs/parallel/sessions/PHASE2-05-qualification-evidence.md',
);

/** The runner and the tables live in `qualification.ts` (also used by `pnpm --filter @nuzm/api qualification:builder`); this spec asserts them. S05_QUALIFICATION_WRITE=1 regenerates the document. */
let runs: QualificationRun[] = [];
describe('synthetic project qualification (SIMULATED end to end)', () => {
  it('drives five briefs from prompt to a deployment-approval request', async () => {
    runs = await runQualification();
    expect(runs).toHaveLength(5);
    for (const { brief: b, artifacts: a, host, env, status, state } of runs) {
      expect(
        b.types as readonly string[],
        `${b.id}: detected ${a.analysis?.productType}`,
      ).toContain(a.analysis!.productType);
      expect(status).toBe('waiting_approval');
      expect(host.steps).toHaveLength(14);
      expect(host.steps.every((s) => s.status === 'succeeded')).toBe(true);
      expect(state.repairRound).toBe(0);
      expect(env.applied).toHaveLength(1);
      expect(env.applied[0]!.ops.length).toBe(a.plan!.fileCount + 1); // the plan's files + the project memory file
      expect(env.applied[0]!.ops.map((o) => o.path)).toContain('nuzm.memory.json');
      expect(a.generator).toBe('skeleton');
      expect(a.review!.errors).toBe(0);
      expect(a.executionOrigin).toBe('MOCK');
      expect(env.budget.metered.map((m) => m.profile)).toEqual([
        'typecheck',
        'build',
        'unit-tests',
      ]);
      expect(env.budget.metered.every((m) => m.origin === 'MOCK')).toBe(true);
      expect(a.deployment!.readiness).toBe('needs_attention');
      expect(a.deployment!.blockers).toContain('simulated_evidence');
      expect(env.approvalsRequested).toHaveLength(1);
      expect(env.approvalsRequested[0]).toMatchObject({
        kind: 'builder_lifecycle_deployment',
        readiness: 'needs_attention',
      });
      expect(state.tokensIn + state.tokensOut).toBe(0);
      expect(T.lifecycle.progress(state).total).toBe(14);
    }
  });
  it('regenerates the evidence document on request', () => {
    if (process.env.S05_QUALIFICATION_WRITE !== '1') return;
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, renderMarkdown(runs.map((r) => r.row)));
  });
});
