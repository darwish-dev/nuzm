import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { ResidencyService } from '../../../compliance';
import type { ApprovalService } from '../approvals/approval.service';
import { iso, isUuid, newId, sha256, canonicalJson, type Row } from '../core';
import { archiveSha256, tarGz } from '../deploy/archive';
import type { ReleaseStorePort } from '../deploy/ports';
import { evaluateDependencies, generateSbom, StaticAdvisoryDb, type AdvisoryDbPort, type Lockfile, type PackageManifest } from '../policy/dependencies';
import type { ArtifactStorePort, ProjectRecord, ProjectsPort } from '../ports/m09';
import type { CanaryRegistry } from '../sandbox/canary';
import { checkPath, scanSecrets } from '../sandbox/paths';

export interface ExportDto {
  id: string;
  projectId: string;
  versionId: string;
  status: string;
  sha256: string | null;
  sbomRef: string | null;
  sizeBytes: number | null;
  fileCount: number | null;
  blockedReasons: { rule: string; path: string; line?: number }[];
  flags: string[];
  /** Signed download URL (valid at most 15 minutes), present only for a `ready`, unexpired export; issued fresh on every read and never stored. */
  downloadUrl: string | null;
  downloadUrlExpiresAt: string | null;
  expiresAt: string;
  dataRegion: string;
  createdAt: string;
  finishedAt: string | null;
  operationId: string | null;
}
export const EXPORT_URL_TTL_SECONDS = 900;
export const EXPORT_RETENTION_DAYS = 7;
const NOT_EXPORTED = new Set(['nuzm.app.json']);
const THIRD_PARTY = /^(vendor|third_party|thirdparty|third-party)\//i;

/**
 * Source export (`POST/GET /v1/builder/projects/{id}/exports`, S47.2): every file is scanned BEFORE the archive exists (a secret or canary blocks the export; only the rule and
 * the path are recorded), the lockfile is mandatory and must pass the supply-chain policy, a residency rule applies to the export destination, vendored third-party code needs
 * the `export_third_party` approval, and the archive is deterministic (same files => same bytes and sha256) with an SBOM, the migrations, the OpenAPI document and a README.
 */
export class ExportService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly projects: ProjectsPort,
    private readonly releases: ReleaseStorePort,
    private readonly artifacts: ArtifactStorePort,
    private readonly approvals: ApprovalService,
    private readonly canaries: CanaryRegistry,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
    private readonly advisories: AdvisoryDbPort = new StaticAdvisoryDb(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  dto(r: Row, orgId: string): ExportDto {
    const ready = r.status === 'ready' && (r.expires_at as Date).getTime() > this.now().getTime();
    const exp = new Date(this.now().getTime() + EXPORT_URL_TTL_SECONDS * 1000);
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      versionId: r.version_id as string,
      status: r.status === 'ready' && !ready ? 'expired' : (r.status as string),
      sha256: (r.sha256 as string | null) ?? null,
      sbomRef: (r.sbom_ref as string | null) ?? null,
      sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
      fileCount: (r.file_count as number | null) ?? null,
      blockedReasons: r.blocked_reasons as ExportDto['blockedReasons'],
      flags: r.flags as string[],
      downloadUrl: ready ? this.releases.signedUrl(orgId, r.archive_ref as string, EXPORT_URL_TTL_SECONDS, this.now()) : null,
      downloadUrlExpiresAt: ready ? exp.toISOString() : null,
      expiresAt: iso(r.expires_at)!,
      dataRegion: r.data_region as string,
      createdAt: iso(r.created_at)!,
      finishedAt: iso(r.finished_at),
      operationId: (r.operation_id as string | null) ?? null,
    };
  }

  async get(orgId: string, projectId: string, id: string): Promise<ExportDto> {
    const r = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM builder.exports WHERE id = $1 AND org_id = $2 AND project_id = $3`, [id, orgId, projectId])).rows[0] as Row | undefined);
    if (!r) throw new ProblemException('not_found', 'export not found');
    if (r.status === 'ready') await this.audit.record({ action: 'builder.export.downloaded', orgId, resource: { type: 'export', id }, outcome: 'success', detail: { urlIssued: true } });
    return this.dto(r, orgId);
  }
  async list(orgId: string, projectId: string): Promise<ExportDto[]> {
    const rows = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM builder.exports WHERE org_id = $1 AND project_id = $2 ORDER BY created_at DESC, id LIMIT 50`, [orgId, projectId])).rows as Row[]);
    return rows.map((r) => this.dto(r, orgId));
  }

  readme(project: ProjectRecord, hasOpenApi: boolean): string {
    return `# ${project.name} (source export)

This archive was exported from the Nuzm app builder. It is plain source: it needs no Nuzm service, key or dependency to build and run.

## Build and test

\`\`\`bash
npm ci --ignore-scripts
npm run typecheck
npm test
\`\`\`

## Contents

- \`package.json\` and \`package-lock.json\` (the lockfile pins every dependency; install scripts are disabled)
- \`db/migrations/\` versioned SQL, every migration with a reversal
${hasOpenApi ? '- `openapi.json` the REST contract\n' : ''}- \`SBOM.cdx.json\` CycloneDX software bill of materials
- \`EXPORT-MANIFEST.json\` sha256 of every file
`;
  }

  /** Creates the export synchronously (the archive is small); a blocked export is a finished record with `status=blocked` and a 422. */
  async create(orgId: string, actor: string, project: ProjectRecord, body: { versionId?: unknown }): Promise<ExportDto> {
    const versionId = (body.versionId ?? project.headVersionId) as string | null;
    if (!isUuid(versionId)) throw new ProblemException('validation_failed', 'versionId is required (the project has no version yet)');
    const files = await this.projects.readFiles(orgId, project.id, versionId);
    if (!files) throw new ProblemException('not_found', 'project version not found');
    const res = await this.residency.evaluate({ orgId, dataClass: 'customer-content', targetRegion: project.dataRegion, purpose: 'source_export', operation: 'read' });
    if (res.decision !== 'allow') throw new ProblemException('residency_denied', res.reasons.map((r) => r.message.en).join('; ') || 'exporting this project is not allowed by the residency policy');
    const row0 = await this.db.withOrg(orgId, async (c) => (await c.query(`INSERT INTO builder.exports (id, org_id, project_id, version_id, status, expires_at, data_region, requested_by) VALUES ($1,$2,$3,$4,'building',$5,$6,$7) RETURNING *`, [newId(), orgId, project.id, versionId, new Date(this.now().getTime() + EXPORT_RETENTION_DAYS * 86_400_000), project.dataRegion, actor])).rows[0] as Row);
    const blocked: ExportDto['blockedReasons'] = [];
    const flags: string[] = [];
    for (const [p, c] of files) {
      const pe = checkPath(p);
      if (pe) blocked.push({ rule: 'unsafe_path', path: p });
      for (const f of scanSecrets(c)) blocked.push({ rule: f.rule, path: p, line: f.line });
      for (const k of await this.canaries.scan(c, { sandboxId: null, source: 'export' })) blocked.push({ rule: `canary:${k.location}`, path: p });
    }
    const lock = files.get('package-lock.json');
    const manifest = JSON.parse(files.get('package.json') ?? '{}') as PackageManifest;
    if (!lock) blocked.push({ rule: 'lockfile_missing', path: 'package-lock.json' });
    else {
      const policy = await evaluateDependencies({ manifest, lockfile: JSON.parse(lock) as Lockfile, advisories: this.advisories });
      for (const f of policy.findings.filter((x) => x.level === 'block')) blocked.push({ rule: `dependency:${f.code}`, path: f.pkg ?? 'package-lock.json' });
    }
    const vendored = [...files.keys()].filter((p) => THIRD_PARTY.test(p));
    if (vendored.length) flags.push('vendored_third_party_code');
    const pendingApproval = vendored.length > 0 && !(await this.approvals.approvedFor(orgId, { type: 'project', id: project.id }, 'export_third_party', { projectId: project.id, versionId, paths: vendored.slice(0, 50), hash: sha256(canonicalJson(vendored)) }));
    if (blocked.length || pendingApproval) {
      let approvalInfo: { id: string; type: string; scopeHash: string }[] | undefined;
      if (!blocked.length && pendingApproval) {
        const a = await this.approvals.request(orgId, { subject: { type: 'project', id: project.id }, type: 'export_third_party', action: { projectId: project.id, versionId, paths: vendored.slice(0, 50), hash: sha256(canonicalJson(vendored)) }, requestedBy: { kind: 'user', userId: actor }, dataRegion: project.dataRegion });
        approvalInfo = [{ id: a.id, type: a.type, scopeHash: a.scopeHash }];
      }
      await this.db.withOrg(orgId, (c) => c.query(`UPDATE builder.exports SET status = 'blocked', blocked_reasons = $2, flags = $3, finished_at = $4 WHERE id = $1`, [row0.id, JSON.stringify(blocked.slice(0, 200)), JSON.stringify(flags), this.now()]));
      await this.audit.record({ action: 'builder.export.created', orgId, actorUserId: actor, resource: { type: 'export', id: row0.id as string }, outcome: 'failure', detail: { blocked: blocked.length, rules: [...new Set(blocked.map((b) => b.rule))].slice(0, 10) } });
      if (approvalInfo) throw new ProblemException('approval_required', 'vendored third-party code needs an approval before it can be exported', undefined, { approvals: approvalInfo, exportId: row0.id });
      throw new ProblemException('export_blocked', 'the export was blocked by the safety checks', blocked.slice(0, 50).map((b) => ({ field: b.path, message: `${b.rule}${b.line ? ` (line ${b.line})` : ''}` })), { exportId: row0.id });
    }
    const out = new Map([...files].filter(([p]) => !NOT_EXPORTED.has(p)));
    const sbom = generateSbom(manifest, JSON.parse(lock!) as Lockfile);
    out.set('SBOM.cdx.json', JSON.stringify(sbom, null, 2) + '\n');
    out.set('README.md', this.readme(project, out.has('openapi.json')));
    out.set('EXPORT-MANIFEST.json', JSON.stringify({ format: 'nuzm-export/1', files: Object.fromEntries([...out].filter(([p]) => p !== 'EXPORT-MANIFEST.json').sort(([a], [b]) => a.localeCompare(b)).map(([p, c]) => [p, sha256(c)])) }, null, 2) + '\n');
    const archive = tarGz(out);
    const sha = archiveSha256(archive);
    const archiveRef = await this.releases.put(orgId, sha, archive);
    const sbomRef = await this.artifacts.put(orgId, null, 'sbom', sbom);
    const done = await this.db.withOrg(orgId, async (c) => (await c.query(`UPDATE builder.exports SET status = 'ready', archive_ref = $2, sha256 = $3, sbom_ref = $4, size_bytes = $5, file_count = $6, flags = $7, finished_at = $8 WHERE id = $1 RETURNING *`, [row0.id, archiveRef, sha, sbomRef, archive.length, out.size, JSON.stringify(flags), this.now()])).rows[0] as Row);
    await this.audit.record({ action: 'builder.export.created', orgId, actorUserId: actor, resource: { type: 'export', id: row0.id as string }, outcome: 'success', after: { sha256: sha, files: out.size, versionId } });
    return this.dto(done, orgId);
  }
}
