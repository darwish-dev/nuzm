import { scanForSecrets } from '@nuzm/domain';
import { emitUsage, usageEventId, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { MobileProjectService } from '../../../builder';
import type { ResidencyService } from '../../../compliance';
import { analyzeProject } from '../flutter/analysis';
import { evaluatePubLock, type PubAdvisoryPort } from '../policy/pub-policy';
import { isUuid, iso, newId, onlyKeys, type Row } from '../core';
import type { SigningService, SigningStagePort } from '../signing/signing.service';
import type { ArtifactBytesPort } from './blobs';
import { BuildFailure, type BuildRunnerPort, type Platform, type Profile } from './runner';

export interface BuildDto {
  id: string;
  projectId: string;
  versionId: string;
  platform: Platform;
  profile: Profile;
  status: string;
  runner: string | null;
  isolation: string | null;
  signed: boolean;
  signingCredentialId: string | null;
  minutesBilled: number;
  toolchain: Record<string, unknown>;
  errorCode: string | null;
  log: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  operationId: string | null;
  /** plain statement of what this build is: unsigned/dev, isolation, iOS availability */
  notices: string[];
}
export interface ArtifactDto {
  id: string;
  buildId: string;
  kind: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  signed: boolean;
  retentionUntil: string;
  createdAt: string;
}
export interface BuildConfig {
  region: string;
  /** D-34 PROPOSAL: debug artifacts 30 days, release artifacts 12 months */
  retentionDays: { debug: number; release: number };
  /** hosts a resolved lockfile may point at (the scanning mirror in production, pub.dev for the dev runner) */
  lockHosts: string[];
  logCap: number;
}
export const DEFAULT_BUILD_CONFIG: BuildConfig = {
  region: process.env.AI_DATA_REGION ?? 'sa-central',
  retentionDays: { debug: 30, release: 365 },
  lockHosts: (process.env.MOBILE_PUB_HOSTS ?? 'pub.dev').split(',').map((s) => s.trim()),
  logCap: 20_000,
};
const BODY = ['projectId', 'versionId', 'platform', 'profile'] as const;

/** a log line that could carry a secret is dropped whole (never partially redacted: a partial match can leave the secret's neighbours) */
export function redactLog(lines: string[], extra: string[] = []): string {
  return lines
    .map((l) => {
      if (scanForSecrets(l, extra).length > 0) return '[line removed: possible secret]';
      return l.length > 600 ? `${l.slice(0, 600)}…` : l;
    })
    .join('\n');
}

const dto = (r: Row, canIos: boolean): BuildDto => {
  const notices: string[] = [];
  if (!r.signed) notices.push('unsigned');
  if (r.isolation === 'none' || r.runner_kind === 'local-android')
    notices.push('not isolated: a local development runner is never isolation evidence');
  if (r.runner_kind === 'mock') notices.push('mock runner: not a real build');
  if (r.platform === 'ios' && !canIos) notices.push('iOS builds need macOS capacity (D-22 / HG-10-01)');
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    versionId: r.version_id as string,
    platform: r.platform as Platform,
    profile: r.profile as Profile,
    status: r.status as string,
    runner: (r.runner_kind as string | null) ?? null,
    isolation: (r.isolation as string | null) ?? null,
    signed: r.signed as boolean,
    signingCredentialId: (r.signing_credential_id as string | null) ?? null,
    minutesBilled: Number(r.minutes_billed),
    toolchain: r.toolchain as Record<string, unknown>,
    errorCode: (r.error_code as string | null) ?? null,
    log: (r.log_excerpt as string | null) ?? null,
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    operationId: (r.operation_id as string | null) ?? null,
    notices,
  };
};
const adto = (r: Row): ArtifactDto => ({
  id: r.id as string,
  buildId: r.build_id as string,
  kind: r.kind as string,
  fileName: r.file_name as string,
  sha256: r.sha256 as string,
  sizeBytes: Number(r.size_bytes),
  signed: r.signed as boolean,
  retentionUntil: iso(r.retention_until)!,
  createdAt: iso(r.created_at)!,
});

/**
 * Mobile builds (`POST/GET /v1/mobile/builds`, S49). Request rules: iOS = 503 `no_macos_capacity` (no macOS worker exists: BLOCKED, never simulated); a `release` profile needs a credential
 * REFERENCE authorized by an owner/admin (422 `signing_not_authorized`) AND a connected signing stage (503 `signing_unavailable`); a debug Android build needs a runner (503
 * `build_runner_unavailable`). Execution claims the queued row atomically, re-runs the static analysis gate, builds in the runner, verifies the resolved lockfile BEFORE compiling, stores
 * artifacts with sha256 and a retention date, redacts the log, meters `mobile.build_minutes` once (deterministic event id) and audits the result.
 */
export class BuildService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly projects: MobileProjectService,
    private readonly signing: SigningService,
    private readonly stage: SigningStagePort,
    private readonly runner: BuildRunnerPort,
    private readonly bytes: ArtifactBytesPort,
    private readonly advisories: PubAdvisoryPort,
    private readonly residency: ResidencyService,
    private readonly cfg: BuildConfig = DEFAULT_BUILD_CONFIG,
  ) {}

  async create(orgId: string, userId: string, b: Record<string, unknown>): Promise<BuildDto> {
    const extra = onlyKeys(b, BODY);
    if (extra.length) throw new ProblemException('validation_failed', `unknown member(s): ${extra.slice(0, 5).join(', ')}`);
    if (b.platform !== 'android' && b.platform !== 'ios')
      throw new ProblemException('validation_failed', 'platform must be android or ios');
    if (b.profile !== 'debug' && b.profile !== 'release')
      throw new ProblemException('validation_failed', 'profile must be debug or release');
    if (!isUuid(b.projectId)) throw new ProblemException('validation_failed', 'projectId must be a uuid');
    if (b.versionId !== undefined && !isUuid(b.versionId))
      throw new ProblemException('validation_failed', 'versionId must be a uuid');
    const platform = b.platform as Platform;
    const profile = b.profile as Profile;
    const project = await this.projects.project(orgId, b.projectId);
    if (!project) throw new ProblemException('not_found', 'project not found');
    const versionId = (b.versionId as string | undefined)?.toLowerCase() ?? project.headVersionId;
    const src = versionId ? await this.projects.sourceOf(orgId, project.id, versionId) : null;
    if (!src) throw new ProblemException('not_found', 'project version not found');
    if (Object.keys(src.files).length < 2 || !src.manifest.spec)
      throw new ProblemException('validation_failed', 'the version has no generated Flutter project yet (run kind=mobile first)');

    if (platform === 'ios') throw new ProblemException('no_macos_capacity', 'iOS builds need macOS capacity (D-22 / HG-10-01); none is connected');
    let credentialId: string | null = null;
    if (profile === 'release') {
      const cred = await this.signing.activeFor(orgId, platform);
      if (!cred)
        throw new ProblemException('signing_not_authorized', 'no signing credential reference authorized by an owner or admin exists for this platform');
      if (!this.stage.available())
        throw new ProblemException('signing_unavailable', 'no signing stage is connected (HG-10-01 pending): a release build cannot be signed');
      credentialId = cred.id;
    }
    if (!this.runner.supports(platform, profile))
      throw new ProblemException('build_runner_unavailable', `no build worker is available for ${platform}/${profile}`);

    const id = newId();
    const row = await this.db.withOrg(orgId, async (c) =>
      (
        await c.query(
          `INSERT INTO mobile.builds (id, org_id, project_id, version_id, platform, profile, runner_kind, isolation, signing_credential_id, data_region, requested_by, operation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$1) RETURNING *`,
          [id, orgId, project.id, versionId, platform, profile, this.runner.kind, this.runner.isolation, credentialId, this.cfg.region, userId],
        )
      ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'mobile.build.requested',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'mobile_build', id },
      outcome: 'success',
      detail: { platform, profile, runner: this.runner.kind },
    });
    return dto(row, false);
  }

  /** Run a queued build to its end. Safe to call twice: only one caller wins the claim. */
  async execute(orgId: string, buildId: string): Promise<BuildDto | null> {
    const claimed = await this.db.withOrg(orgId, async (c) =>
      (
        await c.query(
          `UPDATE mobile.builds SET status='building', started_at=now(), worker_ref=$2 WHERE id=$1 AND status='queued' RETURNING *`,
          [buildId, `${this.runner.kind}:${process.pid}`],
        )
      ).rows[0] as Row | undefined,
    );
    if (!claimed) return null;
    const started = Date.now();
    const lines: string[] = [];
    const log = (l: string) => {
      if (lines.length < 4000) lines.push(l);
    };
    let outcome: { ok: true; out: Awaited<ReturnType<BuildRunnerPort['run']>> } | { ok: false; code: string };
    try {
      const src = await this.projects.sourceOf(orgId, claimed.project_id as string, claimed.version_id as string);
      if (!src) throw new BuildFailure('source_missing', 'the project version is gone');
      const issues = analyzeProject(src.files);
      if (issues.length) {
        for (const i of issues.slice(0, 20)) log(`analysis: ${i.rule} ${i.path ?? ''} ${i.detail}`);
        throw new BuildFailure('analysis_failed', `${issues.length} analysis issue(s)`);
      }
      const res = await this.residency.evaluate({
        orgId,
        dataClass: 'customer-content',
        targetRegion: claimed.data_region as string,
        purpose: 'mobile_artifact_storage',
        operation: 'write',
      });
      if (res.decision !== 'allow') throw new BuildFailure('residency_denied', 'artifact storage is not allowed in this region');
      const out = await this.runner.run(
        {
          buildId,
          platform: claimed.platform as Platform,
          profile: claimed.profile as Profile,
          files: src.files,
          verifyLock: async (lock) => {
            const r = await evaluatePubLock(lock, { allowedHosts: this.cfg.lockHosts, advisories: this.advisories });
            if (r.issues.length) {
              for (const i of r.issues.slice(0, 20)) log(`supply-chain: ${i.rule} ${i.package ?? ''} ${i.detail}`);
              throw new BuildFailure('dependency_blocked', `${r.issues.length} supply-chain issue(s) in the resolved lockfile`);
            }
            log(`lockfile ok: ${r.packages.length} packages`);
          },
        },
        log,
      );
      outcome = { ok: true, out };
    } catch (e) {
      const code = e instanceof BuildFailure ? e.code : 'build_error';
      log(`build failed: ${code}`);
      outcome = { ok: false, code };
    }
    // artifact bytes are stored BEFORE the result transaction: a storage failure becomes a failed build, never a build stuck in `building`
    const stored: { kind: string; fileName: string; storageRef: string; sha256: string; size: number }[] = [];
    if (outcome.ok) {
      try {
        for (const a of outcome.out.artifacts) {
          const r = await this.bytes.put(orgId, buildId, a.fileName, a.bytes);
          stored.push({ kind: a.kind, fileName: a.fileName, storageRef: r.storageRef, sha256: r.sha256, size: a.bytes.length });
        }
      } catch {
        log('build failed: storage_unavailable');
        outcome = { ok: false, code: 'storage_unavailable' };
      }
    }
    const finished = Date.now();
    const minutes = Math.max(0.000001, (finished - started) / 60000);
    const logText = redactLog(lines, (process.env.AI_SECRET_CANARIES ?? '').split(',').filter((x) => x.length >= 8)).slice(-this.cfg.logCap);
    const done = await this.db.withOrg(orgId, async (c) => {
      let toolchain: Record<string, unknown> = {};
      let signed = false;
      if (outcome.ok) {
        toolchain = outcome.out.toolchain;
        signed = outcome.out.signed;
        const days = this.cfg.retentionDays[claimed.profile as Profile];
        for (const a of stored)
          await c.query(
            `INSERT INTO mobile.artifacts (id, org_id, build_id, kind, file_name, storage_ref, sha256, size_bytes, signed, retention_until, data_region)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(days => $10), $11)`,
            [newId(), orgId, buildId, a.kind, a.fileName, a.storageRef, a.sha256, a.size, signed, days, claimed.data_region],
          );
      }
      const r = (
        await c.query(
          `UPDATE mobile.builds SET status=$2, error_code=$3, log_excerpt=$4, minutes_billed=$5, toolchain=$6, signed=$7, finished_at=now() WHERE id=$1 RETURNING *`,
          [buildId, outcome.ok ? 'succeeded' : 'failed', outcome.ok ? null : outcome.code, logText, minutes.toFixed(6), JSON.stringify(toolchain), signed],
        )
      ).rows[0] as Row;
      // one metering event per build, deterministic id, same transaction as the result (macOS minutes are flagged by the platform dimension)
      await emitUsage(c, {
        eventId: usageEventId({ orgId, meterId: 'mobile.build_minutes', resourceId: buildId, windowStart: new Date(started).toISOString() }),
        orgId,
        meterId: 'mobile.build_minutes',
        quantity: minutes.toFixed(6),
        unit: 'minute',
        resourceId: buildId,
        projectId: claimed.project_id as string,
        windowStart: new Date(started).toISOString(),
        windowEnd: new Date(finished).toISOString(),
        occurredAt: new Date(finished).toISOString(),
        dimensions: { platform: claimed.platform as string },
        dataRegion: claimed.data_region as string,
        source: 'mobile@M10B',
      });
      return r;
    });
    await this.audit.record({
      action: 'mobile.build.finished',
      actorType: 'system',
      orgId,
      resource: { type: 'mobile_build', id: buildId },
      outcome: outcome.ok ? 'success' : 'failure',
      detail: { platform: claimed.platform, profile: claimed.profile, runner: this.runner.kind, code: outcome.ok ? null : outcome.code },
    });
    return dto(done, false);
  }

  async list(orgId: string, o: { projectId?: string } = {}): Promise<BuildDto[]> {
    return this.db.withOrg(orgId, async (c) =>
      (
        await c.query(
          `SELECT * FROM mobile.builds WHERE ($1::uuid IS NULL OR project_id = $1) ORDER BY created_at DESC, id DESC LIMIT 100`,
          [o.projectId && isUuid(o.projectId) ? o.projectId.toLowerCase() : null],
        )
      ).rows.map((r) => dto(r as Row, false)),
    );
  }
  async get(orgId: string, id: string): Promise<BuildDto> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const r = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM mobile.builds WHERE id=$1`, [id.toLowerCase()])).rows[0] as Row | undefined);
    if (!r) throw new ProblemException('not_found');
    return dto(r, false);
  }
  async artifacts(orgId: string, buildId: string): Promise<ArtifactDto[]> {
    await this.get(orgId, buildId);
    return this.db.withOrg(orgId, async (c) =>
      (await c.query(`SELECT * FROM mobile.artifacts WHERE build_id=$1 ORDER BY created_at, id`, [buildId.toLowerCase()])).rows.map((r) => adto(r as Row)),
    );
  }
}
