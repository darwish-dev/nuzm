import { createEnv, ORG_A, ORG_B, SEED_USER, type TestEnv } from '@nuzm/platform/testing';
import { ChangeService } from '../changes/change.service';
import { GitStore } from '../git/git.store';
import { MemoryArtifactStore, MemoryProjects, MemoryRunStore, ScriptedModelGateway, StaticOrgBudget } from '../ports/m09-mock';
import { CanaryRegistry, MemorySecurityAlerts } from '../sandbox/canary';
import { MockSandboxRuntime } from '../sandbox/mock-runtime';
import type { SandboxRuntime } from '../sandbox/runtime';
import { DEFAULT_SANDBOX_CONFIG, SandboxService } from '../sandbox/sandbox.service';
import { TestFixService } from '../tests/test-fix.service';
import { TestRunService } from '../tests/test-run.service';
import { RecordingSink } from './engine-harness';

export { ORG_A, ORG_B, SEED_USER };
const ALLOW = { evaluate: async () => ({ decision: 'allow' as const, reasons: [] }) } as never;

/** Everything S45-S47 needs on a real database with the in-memory M09 stand-ins and the mock (or a supplied) sandbox runtime. */
export interface BuildEnv {
  env: TestEnv;
  sink: RecordingSink;
  runtime: SandboxRuntime;
  mock: MockSandboxRuntime;
  alerts: MemorySecurityAlerts;
  canaries: CanaryRegistry;
  sandboxes: SandboxService;
  projects: MemoryProjects;
  artifacts: MemoryArtifactStore;
  runs: MemoryRunStore;
  model: ScriptedModelGateway;
  orgBudget: StaticOrgBudget;
  git: GitStore;
  changes: ChangeService;
  tests: TestRunService;
  testFix: TestFixService;
  clock: { now: Date };
  newProject: (files?: Record<string, string>, org?: string) => Promise<{ project: Awaited<ReturnType<MemoryProjects['create']>>; versionId: string | null }>;
  close: () => Promise<void>;
}

export async function setupBuildEnv(o: { runtime?: SandboxRuntime } = {}): Promise<BuildEnv> {
  const env = await createEnv();
  const sink = new RecordingSink();
  const mock = new MockSandboxRuntime(100);
  const runtime = o.runtime ?? mock;
  const alerts = new MemorySecurityAlerts();
  const canaries = new CanaryRegistry(alerts);
  const projects = new MemoryProjects();
  const artifacts = new MemoryArtifactStore();
  const runs = new MemoryRunStore();
  const model = new ScriptedModelGateway({});
  const orgBudget = new StaticOrgBudget();
  const git = GitStore.temp();
  const clock = { now: new Date('2026-11-18T10:00:00Z') };
  const sandboxes = new SandboxService(env.app, sink, runtime, ALLOW, orgBudget, canaries, DEFAULT_SANDBOX_CONFIG, () => clock.now);
  const changes = new ChangeService(env.app, sink, projects, git.store, canaries);
  const tests = new TestRunService(env.app, sink, sandboxes, projects, artifacts, canaries, undefined, () => clock.now);
  const testFix = new TestFixService(sink, runs, model, orgBudget, tests, changes, projects);
  return {
    env, sink, runtime, mock, alerts, canaries, sandboxes, projects, artifacts, runs, model, orgBudget, git: git.store, changes, tests, testFix, clock,
    newProject: async (files = {}, org = ORG_A) => {
      const project = await projects.create(org, { type: 'webapp', name: 'p', dataRegion: 'sa-central', createdBy: SEED_USER });
      if (!Object.keys(files).length) return { project, versionId: null };
      const v = await projects.commit(org, project.id, { baseVersionId: null, files: new Map(Object.entries(files)), source: 'system', createdBy: SEED_USER });
      return { project: (await projects.get(org, project.id))!, versionId: v.id };
    },
    close: async () => {
      git.cleanup();
      await env.close();
    },
  };
}
