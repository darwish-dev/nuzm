import { emitUsage, usageEventId, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { ResidencyService } from '../../../compliance';
import type { ApprovalService, ApprovalDto } from '../approvals/approval.service';
import { iso, isUuid, newId, type ApprovalType, type Row } from '../core';
import { detectDestructive } from '../gen/sql';
import { evaluateDependencies, StaticAdvisoryDb, type AdvisoryDbPort, type Lockfile, type PackageManifest } from '../policy/dependencies';
import type { ProjectRecord, ProjectsPort } from '../ports/m09';
import type { CanaryRegistry } from '../sandbox/canary';
import { scanSecrets } from '../sandbox/paths';
import type { SandboxService } from '../sandbox/sandbox.service';
import { archiveSha256, tarGz } from './archive';
import type { DeployTarget, DeployTargetPort, HealthProbePort, ReleaseStorePort } from './ports';

export type Environment = 'production' | 'staging';
export interface DeploymentDto {
  id: string;
  projectId: string;
  versionId: string;
  environment: Environment;
  target: { type: 'site' | 'instance'; id: string };
  state: string;
  failureCode: string | null;
  url: string | null;
  artifactSha256: string | null;
  healthCheck: Record<string, unknown>;
  migrations: { version: number; destructive: boolean }[];
  previousDeploymentId: string | null;
  rollbackOf: string | null;
  approvalIds: string[];
  dataRegion: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  operationId: string | null;
}
export interface DeployConfig {
  healthAttempts: number;
  healthDelayMs: number;
  maxArtifactBytes: number;
}
export const DEFAULT_DEPLOY_CONFIG: DeployConfig = { healthAttempts: 3, healthDelayMs: 2000, maxArtifactBytes: 50 * 1024 * 1024 };
/** `db/migrations/NNNN_name.sql` files of a release (the `.down.sql` reversal files are not applied on deploy). */
export function migrationsOf(files: ReadonlyMap<string, string>): { version: number; up: string }[] {
  return [...files.entries()]
    .filter(([p]) => /^db\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(p))
    .map(([p, up]) => ({ version: Number(p.slice(14, 18)), up }))
    .sort((a, b) => a.version - b.version);
}

/**
 * Deployments of generated web apps (`POST /v1/deployments`, `GET`, logs, rollback; S47.1): approvals first (production, paid resource, destructive migration), dependency
 * policy (lockfile mandatory, no high advisory), build in a sandbox, a content-addressed release artifact, deploy to the target (hosting site / compute instance, per M06/M05:
 * ports), a HEALTH GATE (a failed gate restores the previous release automatically), and rollback (idempotent; production rollback and the rollback of data-affecting migrations need approvals).
 */
export class AppDeploymentService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly approvals: ApprovalService,
    private readonly targets: DeployTargetPort,
    private readonly releases: ReleaseStorePort,
    private readonly health: HealthProbePort,
    private readonly sandboxes: SandboxService,
    private readonly projects: ProjectsPort,
    private readonly canaries: CanaryRegistry,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
    private readonly advisories: AdvisoryDbPort = new StaticAdvisoryDb(),
    private readonly cfg: DeployConfig = DEFAULT_DEPLOY_CONFIG,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  dto(r: Row): DeploymentDto {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      versionId: r.version_id as string,
      environment: r.environment as Environment,
      target: { type: r.target_type as 'site' | 'instance', id: r.target_id as string },
      state: r.state as string,
      failureCode: (r.failure_code as string | null) ?? null,
      url: (r.url as string | null) ?? null,
      artifactSha256: (r.artifact_sha256 as string | null) ?? null,
      healthCheck: r.health_check as Record<string, unknown>,
      migrations: r.migrations as DeploymentDto['migrations'],
      previousDeploymentId: (r.previous_deployment_id as string | null) ?? null,
      rollbackOf: (r.rollback_of as string | null) ?? null,
      approvalIds: (r.approval_ids as string[]) ?? [],
      dataRegion: r.data_region as string,
      createdAt: iso(r.created_at)!,
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
      durationMs: (r.duration_ms as number | null) ?? null,
      operationId: (r.operation_id as string | null) ?? null,
    };
  }

  private async load(orgId: string, id: string): Promise<Row> {
    const r = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM deploy.app_deployments WHERE id = $1 AND org_id = $2`, [id, orgId])).rows[0] as Row | undefined);
    if (!r) throw new ProblemException('not_found', 'deployment not found');
    return r;
  }
  async get(orgId: string, id: string): Promise<DeploymentDto> {
    return this.dto(await this.load(orgId, id));
  }
  async list(orgId: string, f: { projectId?: string; limit?: number } = {}): Promise<DeploymentDto[]> {
    const rows = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM deploy.app_deployments WHERE org_id = $1 AND ($2::uuid IS NULL OR project_id = $2) ORDER BY created_at DESC, id LIMIT $3`, [orgId, f.projectId ?? null, Math.min(f.limit ?? 50, 200)])).rows as Row[]);
    return rows.map((r) => this.dto(r));
  }
  async logs(orgId: string, id: string): Promise<{ seq: number; level: string; message: string; at: string }[]> {
    await this.load(orgId, id);
    const rows = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT seq, level, message, at FROM deploy.app_deployment_logs WHERE deployment_id = $1 AND org_id = $2 ORDER BY seq LIMIT 1000`, [id, orgId])).rows as Row[]);
    return rows.map((r) => ({ seq: r.seq as number, level: r.level as string, message: r.message as string, at: iso(r.at)! }));
  }
  private async log(orgId: string, id: string, region: string, level: 'info' | 'warn' | 'error', message: string) {
    const text = this.canaries.redact(message).slice(0, 2000);
    for (let i = 0; i < 5; i++) {
      try {
        await this.db.withOrg(orgId, (c) => c.query(`INSERT INTO deploy.app_deployment_logs (id, org_id, deployment_id, seq, level, message, data_region) VALUES ($1,$2,$3,(SELECT coalesce(max(seq)+1,0) FROM deploy.app_deployment_logs WHERE deployment_id = $3),$4,$5,$6)`, [newId(), orgId, id, level, text, region]));
        return;
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
      }
    }
  }

  /** The approvals this deployment needs, with the exact action each is bound to. */
  private gates(project: ProjectRecord, versionId: string, target: DeployTarget, env: Environment, pending: { version: number; up: string }[]): { type: ApprovalType; action: Record<string, unknown> }[] {
    const g: { type: ApprovalType; action: Record<string, unknown> }[] = [];
    if (env === 'production') g.push({ type: 'production_deploy', action: { projectId: project.id, versionId, target: { type: target.type, id: target.id }, env } });
    if (target.newPaidResource) g.push({ type: 'paid_resource', action: { projectId: project.id, target: { type: target.type, id: target.id }, reason: 'a new paid resource would be created' } });
    const destructive = pending.flatMap((m) => detectDestructive(m.up).map((s) => `${m.version}: ${s}`));
    if (destructive.length) g.push({ type: 'destructive_migration', action: { projectId: project.id, versionId, target: { type: target.type, id: target.id }, statements: destructive } });
    return g;
  }

  async create(orgId: string, actor: string, project: ProjectRecord, body: { versionId?: unknown; target?: unknown; env?: unknown; environment?: unknown }): Promise<{ deployment: DeploymentDto; created: boolean }> {
    if (project.type !== 'webapp') throw new ProblemException('unsupported_capability', 'this endpoint deploys web-app projects here; website projects are published by M09');
    const t = body.target as { type?: unknown; id?: unknown } | undefined;
    if (!t || (t.type !== 'site' && t.type !== 'instance') || !isUuid(t.id)) throw new ProblemException('validation_failed', 'target must be {type: site|instance, id}');
    const env = (body.env ?? body.environment ?? 'staging') as Environment;
    if (env !== 'production' && env !== 'staging') throw new ProblemException('validation_failed', 'env must be production or staging');
    const versionId = (body.versionId ?? project.headVersionId) as string | null;
    if (!isUuid(versionId)) throw new ProblemException('validation_failed', 'versionId is required (the project has no version yet)');
    const files = await this.projects.readFiles(orgId, project.id, versionId);
    if (!files) throw new ProblemException('not_found', 'project version not found');
    const target = await this.targets.resolve(orgId, { type: t.type, id: t.id as string });
    if (!target) throw new ProblemException('not_found', 'deployment target not found');
    if (target.status !== 'active') throw new ProblemException('invalid_state', 'the target is not active');
    const res = await this.residency.evaluate({ orgId, dataClass: 'customer-content', targetRegion: target.region, purpose: 'app_deployment', operation: 'write' });
    if (res.decision !== 'allow') throw new ProblemException('residency_denied', res.reasons.map((r) => r.message.en).join('; ') || 'deployment to this region is not allowed by the residency policy');
    // a duplicate request for the same release on the same target is the same deployment
    const existing = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM deploy.app_deployments WHERE org_id = $1 AND project_id = $2 AND version_id = $3 AND target_id = $4 AND environment = $5 AND rollback_of IS NULL AND state IN ('queued','building','deploying','verifying') ORDER BY created_at DESC LIMIT 1`, [orgId, project.id, versionId, t.id, env])).rows[0] as Row | undefined);
    if (existing) return { deployment: this.dto(existing), created: false };
    // supply chain first: lockfile mandatory, policy must pass (no high advisory, no typosquat, nothing outside the mirror)
    const lock = files.get('package-lock.json');
    const policy = await evaluateDependencies({ manifest: JSON.parse(files.get('package.json') ?? '{}') as PackageManifest, lockfile: lock ? (JSON.parse(lock) as Lockfile) : null, advisories: this.advisories });
    if (policy.findings.some((f) => f.level === 'block')) throw new ProblemException('dependency_blocked', policy.findings.filter((f) => f.level === 'block').map((f) => f.message).slice(0, 5).join('; '));
    if (!policy.ok && policy.approvalAction) {
      // install scripts / unknown licences / growth: an approval of the exact dependency list
      const a = await this.approvals.approvedFor(orgId, { type: 'project', id: project.id }, 'egress_or_dependency', policy.approvalAction);
      if (!a) {
        const r = await this.approvals.request(orgId, { subject: { type: 'project', id: project.id }, type: 'egress_or_dependency', action: policy.approvalAction, requestedBy: { kind: 'user', userId: actor }, dataRegion: project.dataRegion });
        throw new ProblemException('approval_required', 'dependencies outside the policy need approval', undefined, { approvals: [{ id: r.id, type: r.type, scopeHash: r.scopeHash }] });
      }
    }
    const applied = new Set(await this.targets.appliedMigrations(orgId, target.id));
    const all = migrationsOf(files);
    const pending = all.filter((m) => !applied.has(m.version));
    // secrets in the release are a block, not an approval
    for (const [p, c] of files) if (scanSecrets(c).length || c.includes('NZCANARY-')) throw new ProblemException('change_rejected', `${p} contains a secret pattern: remove it before deploying`);
    const missing: ApprovalDto[] = [];
    const approvalIds: string[] = [];
    for (const g of this.gates(project, versionId, target, env, pending)) {
      const subject = { type: 'project' as const, id: project.id };
      const ok = await this.approvals.approvedFor(orgId, subject, g.type, g.action);
      if (ok) approvalIds.push(ok.id);
      else missing.push(await this.approvals.request(orgId, { subject, type: g.type, action: g.action, requestedBy: { kind: 'user', userId: actor }, dataRegion: project.dataRegion }));
    }
    if (missing.length) throw new ProblemException('approval_required', 'a human approval is required before this deployment runs', undefined, { approvals: missing.map((a) => ({ id: a.id, type: a.type, scopeHash: a.scopeHash })) });
    const previous = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT id FROM deploy.app_deployments WHERE org_id = $1 AND target_id = $2 AND environment = $3 AND state = 'live'`, [orgId, t.id, env])).rows[0] as Row | undefined);
    // the duplicate check and the insert are one serialised step per release+target: two simultaneous requests create ONE deployment
    const made = await this.db.withOrg(orgId, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`deploy:${orgId}:${project.id}:${versionId}:${t.id as string}:${env}`]);
      const dup = (await c.query(`SELECT * FROM deploy.app_deployments WHERE org_id = $1 AND project_id = $2 AND version_id = $3 AND target_id = $4 AND environment = $5 AND rollback_of IS NULL AND state IN ('queued','building','deploying','verifying') ORDER BY created_at DESC LIMIT 1`, [orgId, project.id, versionId, t.id, env])).rows[0] as Row | undefined;
      if (dup) return { row: dup, created: false };
      const ins = (
        await c.query(
          `INSERT INTO deploy.app_deployments (id, org_id, project_id, version_id, environment, target_type, target_id, state, migrations, previous_deployment_id, approval_ids, data_region, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,$11,$12) RETURNING *`,
          [newId(), orgId, project.id, versionId, env, t.type, t.id, JSON.stringify(pending.map((m) => ({ version: m.version, destructive: detectDestructive(m.up).length > 0 }))), previous?.id ?? null, approvalIds, project.dataRegion, actor],
        )
      ).rows[0] as Row;
      return { row: ins, created: true };
    });
    if (!made.created) return { deployment: this.dto(made.row), created: false };
    const row = made.row;
    await this.audit.record({ action: 'deploy.deployment.created', orgId, actorUserId: actor, resource: { type: 'deployment', id: row.id as string }, outcome: 'success', after: { projectId: project.id, versionId, env, target: { type: t.type, id: t.id }, approvals: approvalIds } });
    return { deployment: this.dto(row), created: true };
  }

  private async setState(orgId: string, id: string, state: string, patch: Record<string, unknown> = {}): Promise<Row> {
    const cols = Object.keys(patch);
    return this.db.withOrg(orgId, async (c) => (await c.query(`UPDATE deploy.app_deployments SET state = $2${cols.map((k, i) => `, ${k} = $${i + 3}`).join('')} WHERE id = $1 RETURNING *`, [id, state, ...cols.map((k) => patch[k])])).rows[0] as Row);
  }

  /** Runs a queued deployment through build -> deploy -> health gate -> live (the worker job of the operation). */
  async execute(orgId: string, actor: string, project: ProjectRecord, deploymentId: string): Promise<DeploymentDto> {
    const dep = await this.load(orgId, deploymentId);
    if (dep.state !== 'queued') return this.dto(dep);
    const region = dep.data_region as string;
    const started = this.now();
    await this.setState(orgId, deploymentId, 'building', { started_at: started });
    const fail = async (code: string, message: string, extra: Record<string, unknown> = {}) => {
      await this.log(orgId, deploymentId, region, 'error', message);
      const done = await this.setState(orgId, deploymentId, 'failed', { failure_code: code, finished_at: this.now(), duration_ms: this.now().getTime() - started.getTime(), ...extra });
      await this.audit.record({ action: 'deploy.deployment.failed', orgId, actorUserId: actor, resource: { type: 'deployment', id: deploymentId }, outcome: 'failure', detail: { code } });
      return this.dto(done);
    };
    const files = (await this.projects.readFiles(orgId, project.id, dep.version_id as string))!;
    const manifest = (() => {
      try {
        return JSON.parse(files.get('nuzm.app.json') ?? '{}') as { commands?: Record<string, string[]>; deploy?: { healthPath?: string } };
      } catch {
        return {};
      }
    })();
    // 1. build in a sandbox (never on the control plane)
    await this.log(orgId, deploymentId, region, 'info', 'building in a sandbox');
    let release = new Map(files);
    let sandboxId: string | null = null;
    let buildMs = 0;
    try {
      const sb = await this.sandboxes.create(orgId, actor, project, {});
      sandboxId = sb.id;
      await this.sandboxes.writeFiles(orgId, project.id, sb.id, files);
      const cmds = manifest.commands ?? {};
      if (cmds['install'] && files.has('package-lock.json')) {
        const i = await this.sandboxes.exec(orgId, actor, project.id, sb.id, cmds['install']);
        buildMs += i.durationMs;
        if (i.exitCode !== 0) return await fail('build_failed', 'the dependency install failed');
      }
      if (cmds['build']) {
        const b = await this.sandboxes.exec(orgId, actor, project.id, sb.id, cmds['build']);
        buildMs += b.durationMs;
        await this.log(orgId, deploymentId, region, b.exitCode === 0 ? 'info' : 'error', `build exited with ${String(b.exitCode)}${b.timedOut ? ' (timed out)' : ''}`);
        if (b.exitCode !== 0) return await fail('build_failed', 'the build failed');
        const built = await this.sandboxes.readFiles(orgId, project.id, sb.id).catch(() => new Map<string, string>());
        for (const [p, c] of built) if (p.startsWith('dist/')) release.set(p, c);
      }
    } catch (e) {
      return await fail('build_failed', `the build could not run: ${(e as Error).message.slice(0, 200)}`);
    } finally {
      if (sandboxId) await this.sandboxes.terminate(orgId, actor, project.id, sandboxId, 'deployment_build_done').catch(() => undefined);
    }
    release = new Map([...release].filter(([p]) => !p.startsWith('node_modules/')));
    const archive = tarGz(release);
    if (archive.length > this.cfg.maxArtifactBytes) return await fail('artifact_too_large', 'the release artifact is too large');
    const sha = archiveSha256(archive);
    const artifactRef = await this.releases.put(orgId, sha, archive);
    await this.log(orgId, deploymentId, region, 'info', `release artifact ${sha.slice(0, 12)} (${archive.length} bytes)`);
    const finishedBuild = this.now();
    await this.db.withOrg(orgId, (c) =>
      emitUsage(c, { eventId: usageEventId({ orgId, meterId: 'builder.build_minutes', resourceId: deploymentId, windowStart: started.toISOString() }), orgId, meterId: 'builder.build_minutes', quantity: (Math.max(buildMs, finishedBuild.getTime() - started.getTime()) / 60_000).toFixed(3), unit: 'minute', resourceId: deploymentId, projectId: project.id, windowStart: started.toISOString(), windowEnd: finishedBuild.toISOString(), occurredAt: finishedBuild.toISOString(), dimensions: { project_type: 'webapp' }, dataRegion: region, source: 'builder@M10' }),
    );
    await this.setState(orgId, deploymentId, 'deploying', { artifact_sha256: sha, artifact_ref: artifactRef });
    // 2. deploy to the target
    const wanted = new Set((dep.migrations as { version: number }[]).map((m) => m.version));
    const pending = migrationsOf(files).filter((m) => wanted.has(m.version));
    let out: { url: string; releaseRef: string };
    try {
      out = await this.targets.deploy(orgId, dep.target_id as string, { artifactRef, sha256: sha, deploymentId, environment: dep.environment as string, migrations: pending });
    } catch (e) {
      return await fail('deploy_failed', `the target refused the release: ${(e as Error).message.slice(0, 200)}`);
    }
    await this.log(orgId, deploymentId, region, 'info', `deployed to ${dep.target_type as string} ${(dep.target_id as string).slice(0, 8)}`);
    await this.setState(orgId, deploymentId, 'verifying', { url: out.url, release_ref: out.releaseRef });
    // 3. health gate: every attempt must answer 200; otherwise restore the previous release at once
    const healthUrl = new URL(manifest.deploy?.healthPath ?? '/health', out.url).toString();
    const attempts: { ok: boolean; status: number | null; detail: string }[] = [];
    for (let i = 0; i < this.cfg.healthAttempts; i++) {
      const r = await this.health.check(healthUrl);
      attempts.push(r);
      await this.log(orgId, deploymentId, region, r.ok ? 'info' : 'warn', `health check ${i + 1}/${this.cfg.healthAttempts}: ${r.detail}`);
      if (r.ok) break;
      if (i + 1 < this.cfg.healthAttempts) await this.sleep(this.cfg.healthDelayMs);
    }
    if (!attempts.at(-1)!.ok) {
      const prev = dep.previous_deployment_id ? await this.load(orgId, dep.previous_deployment_id as string).catch(() => null) : null;
      let restored: string | null = null;
      if (prev?.release_ref) {
        await this.targets.activate(orgId, dep.target_id as string, prev.release_ref as string);
        restored = prev.id as string;
        await this.log(orgId, deploymentId, region, 'warn', `health gate failed: the previous release ${(prev.id as string).slice(0, 8)} was restored automatically`);
      }
      await this.audit.record({ action: 'deploy.deployment.rolled_back', orgId, actorType: 'system', resource: { type: 'deployment', id: deploymentId }, outcome: 'success', detail: { automatic: true, restoredDeploymentId: restored } });
      const f = await fail('health_gate_failed', 'the health gate failed', { health_check: JSON.stringify({ attempts, autoRolledBack: restored !== null, restoredDeploymentId: restored }) });
      return f;
    }
    // 4. live: the previous live deployment of this target and environment becomes `superseded`
    const live = await this.db.withOrg(orgId, async (c) => {
      await c.query(`UPDATE deploy.app_deployments SET state = 'superseded' WHERE org_id = $1 AND target_id = $2 AND environment = $3 AND state = 'live' AND id <> $4`, [orgId, dep.target_id, dep.environment, deploymentId]);
      return (await c.query(`UPDATE deploy.app_deployments SET state = 'live', health_check = $2, finished_at = $3, duration_ms = $4 WHERE id = $1 RETURNING *`, [deploymentId, JSON.stringify({ attempts, autoRolledBack: false }), this.now(), this.now().getTime() - started.getTime()])).rows[0] as Row;
    });
    await this.log(orgId, deploymentId, region, 'info', 'live');
    await this.audit.record({ action: 'deploy.deployment.succeeded', orgId, actorUserId: actor, resource: { type: 'deployment', id: deploymentId }, outcome: 'success', after: { sha256: sha, url: out.url } });
    return this.dto(live);
  }

  /** Rollback of a LIVE deployment to the release that was live before it. Idempotent. A production rollback and the rollback of data-affecting migrations need approvals. */
  async rollback(orgId: string, actor: string, project: ProjectRecord, deploymentId: string): Promise<{ deployment: DeploymentDto; replayed: boolean }> {
    const dep = await this.load(orgId, deploymentId);
    if (dep.state === 'rolled_back') {
      const rec = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM deploy.app_deployments WHERE org_id = $1 AND rollback_of = $2 ORDER BY created_at LIMIT 1`, [orgId, deploymentId])).rows[0] as Row | undefined);
      if (rec) return { deployment: this.dto(rec), replayed: true };
    }
    if (dep.state !== 'live') throw new ProblemException('invalid_state', `only a live deployment can be rolled back (this one is ${dep.state as string})`);
    if (!dep.previous_deployment_id) throw new ProblemException('invalid_state', 'there is no earlier release to roll back to');
    const prev = await this.load(orgId, dep.previous_deployment_id as string);
    if (!prev.release_ref) throw new ProblemException('invalid_state', 'the earlier release is not available');
    const subject = { type: 'project' as const, id: project.id };
    const need: { type: ApprovalType; action: Record<string, unknown> }[] = [];
    if (dep.environment === 'production') need.push({ type: 'production_rollback', action: { projectId: project.id, deploymentId, restoreDeploymentId: prev.id } });
    const dataAffecting = (dep.migrations as { version: number; destructive: boolean }[]).filter((m) => m.destructive);
    if (dataAffecting.length) need.push({ type: 'data_migration_rollback', action: { projectId: project.id, deploymentId, migrations: dataAffecting.map((m) => m.version) } });
    const missing: ApprovalDto[] = [];
    for (const g of need) if (!(await this.approvals.approvedFor(orgId, subject, g.type, g.action))) missing.push(await this.approvals.request(orgId, { subject, type: g.type, action: g.action, requestedBy: { kind: 'user', userId: actor }, dataRegion: project.dataRegion }));
    if (missing.length) throw new ProblemException('approval_required', 'a human approval is required before this rollback runs', undefined, { approvals: missing.map((a) => ({ id: a.id, type: a.type, scopeHash: a.scopeHash })) });
    const started = this.now();
    await this.targets.activate(orgId, dep.target_id as string, prev.release_ref as string);
    const probe = await this.health.check(new URL('/health', (prev.url as string) ?? (dep.url as string)).toString());
    const rec = await this.db.withOrg(orgId, async (c) => {
      await c.query(`UPDATE deploy.app_deployments SET state = 'rolled_back', finished_at = coalesce(finished_at, $2) WHERE id = $1 AND state = 'live'`, [deploymentId, started]);
      return (
        await c.query(
          `INSERT INTO deploy.app_deployments (id, org_id, project_id, version_id, environment, target_type, target_id, state, artifact_sha256, artifact_ref, release_ref, url, health_check, migrations, previous_deployment_id, rollback_of, approval_ids, data_region, created_by, started_at, finished_at, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'live',$8,$9,$10,$11,$12,'[]'::jsonb,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
          [newId(), orgId, project.id, prev.version_id, dep.environment, dep.target_type, dep.target_id, prev.artifact_sha256, prev.artifact_ref, prev.release_ref, prev.url, JSON.stringify({ attempts: [probe], rollback: true }), deploymentId, deploymentId, [], dep.data_region, actor, started, this.now(), this.now().getTime() - started.getTime()],
        )
      ).rows[0] as Row;
    });
    await this.log(orgId, deploymentId, dep.data_region as string, 'warn', `rolled back to the release of deployment ${(prev.id as string).slice(0, 8)}`);
    await this.audit.record({ action: 'deploy.deployment.rolled_back', orgId, actorUserId: actor, resource: { type: 'deployment', id: deploymentId }, outcome: 'success', after: { restoredDeploymentId: prev.id, recordId: rec.id, healthy: probe.ok } });
    return { deployment: this.dto(rec), replayed: false };
  }
}
