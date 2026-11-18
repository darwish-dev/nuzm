import { emitUsage, usageEventId, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { iso, newId, type Row } from '../core';
import {
  evaluateDependencies,
  StaticAdvisoryDb,
  type AdvisoryDbPort,
  type Lockfile,
  type PackageManifest,
} from '../policy/dependencies';
import type { ArtifactStorePort, ProjectRecord, ProjectsPort } from '../ports/m09';
import type { CanaryRegistry } from '../sandbox/canary';
import type { SandboxService } from '../sandbox/sandbox.service';
import { parseBuild, parseJunit, parseTsc, type SuiteResult } from './parsers';

export type Suite = 'unit' | 'typecheck' | 'build' | 'e2e' | 'all';
export const SUITES: readonly Suite[] = ['unit', 'typecheck', 'build', 'e2e', 'all'];
export interface TestRunDto {
  id: string;
  projectId: string;
  versionId: string;
  suite: Suite;
  status: string;
  summary: Record<string, unknown>;
  logsRef: string | null;
  runtime: { kind: string | null };
  durationMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  operationId: string | null;
}
interface Manifest {
  commands?: Record<string, string[]>;
}
const LOG_CAP = 200_000;

/**
 * Test runner (`POST/GET /v1/builder/projects/{id}/test-runs`, S46.3): runs unit / typecheck / build / e2e of one project version INSIDE a sandbox, with the commands the
 * project declares in `nuzm.app.json` (argv arrays, no shell), parses the tools' output into structured results, stores the redacted log, meters `builder.build_minutes`.
 * The sandbox is the control plane's only way to execute generated code; the runtime that executed it is recorded on the row (a mock/local-dev result is never isolation evidence).
 */
export class TestRunService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly sandboxes: SandboxService,
    private readonly projects: ProjectsPort,
    private readonly artifacts: ArtifactStorePort,
    private readonly canaries: CanaryRegistry,
    private readonly advisories: AdvisoryDbPort = new StaticAdvisoryDb(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  dto(r: Row): TestRunDto {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      versionId: r.version_id as string,
      suite: r.suite as Suite,
      status: r.status as string,
      summary: r.summary as Record<string, unknown>,
      logsRef: (r.logs_ref as string | null) ?? null,
      runtime: { kind: (r.runtime_kind as string | null) ?? null },
      durationMs: (r.duration_ms as number | null) ?? null,
      createdAt: iso(r.created_at)!,
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
      operationId: (r.operation_id as string | null) ?? null,
    };
  }

  /** Creates the run (`queued`). 422 `test_suite_unavailable` when the project declares no command for the suite. */
  async create(
    orgId: string,
    actor: string,
    project: ProjectRecord,
    body: { suite?: unknown; versionId?: unknown },
    o: { runId?: string | null } = {},
  ): Promise<TestRunDto> {
    const suite = (body.suite ?? 'all') as Suite;
    if (!SUITES.includes(suite))
      throw new ProblemException('validation_failed', `suite must be one of ${SUITES.join(', ')}`);
    const versionId = (body.versionId ?? project.headVersionId) as string | null;
    if (!versionId) throw new ProblemException('conflict', 'the project has no version yet');
    const files = await this.projects.readFiles(orgId, project.id, versionId);
    if (!files) throw new ProblemException('not_found', 'project version not found');
    const manifest = this.manifestOf(files);
    if (suite !== 'all' && !manifest.commands?.[suite])
      throw new ProblemException(
        'test_suite_unavailable',
        `the project declares no "${suite}" command in nuzm.app.json`,
      );
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `INSERT INTO builder.test_runs (id, org_id, project_id, version_id, suite, status, data_region, requested_by, run_id) VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8) RETURNING *`,
            [
              newId(),
              orgId,
              project.id,
              versionId,
              suite,
              project.dataRegion,
              actor,
              o.runId ?? null,
            ],
          )
        ).rows[0] as Row,
    );
    return this.dto(row);
  }

  private manifestOf(files: ReadonlyMap<string, string>): Manifest {
    try {
      return JSON.parse(files.get('nuzm.app.json') ?? '{}') as Manifest;
    } catch {
      return {};
    }
  }

  async get(orgId: string, projectId: string, id: string): Promise<TestRunDto> {
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM builder.test_runs WHERE id = $1 AND org_id = $2 AND project_id = $3`,
            [id, orgId, projectId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!r) throw new ProblemException('not_found', 'test run not found');
    return this.dto(r);
  }
  async list(orgId: string, projectId: string, limit = 50): Promise<TestRunDto[]> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM builder.test_runs WHERE org_id = $1 AND project_id = $2 ORDER BY created_at DESC, id LIMIT $3`,
            [orgId, projectId, Math.min(limit, 200)],
          )
        ).rows as Row[],
    );
    return rows.map((r) => this.dto(r));
  }

  /** Runs a queued test run to completion in a fresh sandbox (terminated afterwards). Returns the finished run. */
  async execute(
    orgId: string,
    actor: string,
    project: ProjectRecord,
    testRunId: string,
  ): Promise<TestRunDto> {
    const run = await this.get(orgId, project.id, testRunId);
    if (run.status !== 'queued') return run;
    const started = this.now();
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE builder.test_runs SET status = 'running', started_at = $2 WHERE id = $1 AND status = 'queued'`,
        [testRunId, started],
      ),
    );
    const files = (await this.projects.readFiles(orgId, project.id, run.versionId))!;
    const manifest = this.manifestOf(files);
    const results: SuiteResult[] = [];
    const logs: string[] = [];
    let sandboxId: string | null = null;
    let runtimeKind: string | null = null;
    let status: 'passed' | 'failed' | 'errored' = 'errored';
    let note: string | null = null;
    let totalMs = 0;
    try {
      const sb = await this.sandboxes.create(orgId, actor, project, {});
      sandboxId = sb.id;
      runtimeKind = sb.runtime.kind;
      await this.sandboxes.writeFiles(orgId, project.id, sb.id, files);
      const wanted: Exclude<Suite, 'all'>[] =
        run.suite === 'all'
          ? (['typecheck', 'unit', 'build'] as const).filter((s) => manifest.commands?.[s])
          : [run.suite];
      const needsInstall = wanted.some((s) => s === 'typecheck' || s === 'build');
      if (needsInstall) {
        const lock = files.get('package-lock.json');
        if (!lock)
          note =
            'no lockfile: typecheck and build need the dependencies; create the lockfile through the package mirror (npm install --package-lock-only --ignore-scripts)';
        else {
          const policy = await evaluateDependencies({
            manifest: JSON.parse(files.get('package.json') ?? '{}') as PackageManifest,
            lockfile: JSON.parse(lock) as Lockfile,
            advisories: this.advisories,
          });
          if (!policy.ok) {
            note =
              'dependency policy blocked the install: ' +
              policy.findings
                .filter((f) => f.level !== 'warn')
                .map((f) => f.message)
                .slice(0, 5)
                .join('; ');
          } else {
            const inst = await this.sandboxes.exec(
              orgId,
              actor,
              project.id,
              sb.id,
              manifest.commands?.['install'] ?? ['npm', 'ci', '--ignore-scripts'],
            );
            totalMs += inst.durationMs;
            logs.push(`$ install\n${inst.stdout}${inst.stderr}`);
            if (inst.exitCode !== 0) note = 'the dependency install failed';
          }
        }
      }
      for (const s of wanted) {
        const argv = manifest.commands?.[s];
        if (!argv) continue;
        if (note && (s === 'typecheck' || s === 'build')) {
          results.push({
            suite: s,
            status: 'errored',
            tests: 1,
            failures: 0,
            skipped: 0,
            durationMs: 0,
            cases: [{ suite: s, name: s, status: 'failed', durationMs: 0, failure: note }],
            signature: null,
          });
          continue;
        }
        const r = await this.sandboxes.exec(orgId, actor, project.id, sb.id, argv);
        totalMs += r.durationMs;
        logs.push(`$ ${s}: ${argv.join(' ')}\n${r.stdout}${r.stderr}`);
        const parsed =
          s === 'unit' || s === 'e2e'
            ? parseJunit(r.stdout, s)
            : s === 'typecheck'
              ? parseTsc(r.stdout + r.stderr, r.exitCode)
              : parseBuild(r.stdout + r.stderr, r.exitCode, r.timedOut);
        parsed.durationMs ||= r.durationMs;
        results.push(parsed);
      }
      status = results.some((x) => x.status === 'errored')
        ? 'errored'
        : results.some((x) => x.status === 'failed')
          ? 'failed'
          : results.length
            ? 'passed'
            : 'errored';
    } catch (e) {
      note = (e as Error).message.slice(0, 300);
      status = 'errored';
    } finally {
      if (sandboxId)
        await this.sandboxes
          .terminate(orgId, actor, project.id, sandboxId, 'test_run_done')
          .catch(() => undefined);
    }
    const finished = this.now();
    const duration = totalMs || Math.max(0, finished.getTime() - started.getTime());
    const logText = this.canaries.redact(logs.join('\n')).slice(0, LOG_CAP);
    const logsRef = await this.artifacts.put(orgId, null, 'test_report', {
      testRunId,
      log: logText,
    });
    const failures = results.reduce((n, r) => n + r.failures, 0);
    const summary = {
      totals: {
        suites: results.length,
        tests: results.reduce((n, r) => n + r.tests, 0),
        failures,
        skipped: results.reduce((n, r) => n + r.skipped, 0),
      },
      suites: results.map((r) => ({
        ...r,
        cases: r.cases
          .filter((c) => c.status === 'failed')
          .concat(r.cases.filter((c) => c.status !== 'failed').slice(0, 20))
          .slice(0, 200),
      })),
      ...(note ? { note } : {}),
    };
    const row = await this.db.withOrg(orgId, async (c) => {
      const out = (
        await c.query(
          `UPDATE builder.test_runs SET status = $2, summary = $3, logs_ref = $4, sandbox_id = $5, runtime_kind = $6, duration_ms = $7, finished_at = $8 WHERE id = $1 RETURNING *`,
          [
            testRunId,
            status,
            JSON.stringify(summary),
            logsRef,
            sandboxId,
            runtimeKind,
            Math.round(duration),
            finished,
          ],
        )
      ).rows[0] as Row;
      // builder.build_minutes: one event per test run (deterministic id), emitted in the same transaction as the result
      await emitUsage(c, {
        eventId: usageEventId({
          orgId,
          meterId: 'builder.build_minutes',
          resourceId: testRunId,
          windowStart: started.toISOString(),
        }),
        orgId,
        meterId: 'builder.build_minutes',
        quantity: (duration / 60_000).toFixed(3),
        unit: 'minute',
        resourceId: testRunId,
        projectId: project.id,
        windowStart: started.toISOString(),
        windowEnd: finished.toISOString(),
        occurredAt: finished.toISOString(),
        dimensions: { project_type: 'webapp' },
        dataRegion: project.dataRegion,
        source: 'builder@M10',
      });
      return out;
    });
    await this.audit.record({
      action: 'builder.test_run.finished',
      orgId,
      actorUserId: actor,
      resource: { type: 'test_run', id: testRunId },
      outcome: status === 'passed' ? 'success' : 'failure',
      after: { suite: run.suite, status, failures, runtime: runtimeKind },
    });
    return this.dto(row);
  }
}
