import { createHash } from 'node:crypto';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import {
  PLATFORMS,
  PROVENANCE_CLASSES,
  REUSE_SCOPES,
  RESOURCE_TYPES,
  SHA256_RE,
  UPLOAD_LIMITS,
  isUuid,
  newId,
  oneOf,
  slugify,
  stringList,
  text,
  validateFilename,
  toResource,
  type Row,
} from './model';
import type { KnowledgeObjectStore } from './object-store';

export const DEFAULT_DATA_REGION = 'sa-central';

export interface UploadDto {
  id: string;
  state: string;
  declaredBytes: number;
  receivedBytes: number;
  partSize: number;
  partsReceived: number[];
  expiresAt: string;
}
const toUpload = (r: Row): UploadDto => ({
  id: r.id as string,
  state: r.state as string,
  declaredBytes: Number(r.declared_bytes),
  receivedBytes: Number(r.received_bytes),
  partSize: Number(r.part_size),
  partsReceived: ((r.parts as { partNumber: number }[]) ?? [])
    .map((p) => p.partNumber)
    .sort((a, b) => a - b),
  expiresAt: (r.expires_at as Date).toISOString(),
});

interface PartRow {
  partNumber: number;
  sha256: string;
  bytes: number;
}

/**
 * Resumable, quarantined uploads of library packages (ADR-065, S-K1). An upload is a session of verified parts; completing it assembles a content-addressed archive,
 * checks the whole-object SHA-256 and creates the resource and its first (or next) immutable version in state QUARANTINED. The validation, extraction and analysis
 * stages arrive with S-K2: until then a completed upload stays QUARANTINED and nothing reads inside the archive. Nothing here executes or unpacks anything.
 */
export class UploadService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly store: KnowledgeObjectStore,
  ) {}

  async open(actor: string, body: Row) {
    const filename = validateFilename(body.filename);
    text(body.name, 'name', 200, false);
    oneOf(RESOURCE_TYPES, body.resourceType, 'resourceType');
    const declared = body.declaredBytes;
    if (!Number.isInteger(declared) || (declared as number) < 1)
      throw new ProblemException('validation_failed', 'declaredBytes must be a positive integer');
    if ((declared as number) > UPLOAD_LIMITS.maxBytes)
      throw new ProblemException(
        'payload_too_large',
        `an upload may not exceed ${UPLOAD_LIMITS.maxBytes} bytes`,
      );
    if (typeof body.sha256 !== 'string' || !SHA256_RE.test(body.sha256.toLowerCase()))
      throw new ProblemException('validation_failed', 'sha256 must be 64 hex characters');
    const resourceId = body.resourceId;
    if (resourceId !== undefined && !isUuid(resourceId))
      throw new ProblemException('validation_failed', 'resourceId must be a UUID');
    const partSize = UPLOAD_LIMITS.defaultPartSize;
    if (Math.ceil((declared as number) / partSize) > UPLOAD_LIMITS.maxParts)
      throw new ProblemException('payload_too_large', 'too many parts for this size');
    const row = await this.db.withPlatformScope(async (c) => {
      const open = Number(
        (
          await c.query(
            `SELECT count(*) AS n FROM knowledge.uploads WHERE org_id IS NULL AND created_by = $1 AND state = 'OPEN' AND expires_at > now()`,
            [actor],
          )
        ).rows[0]!.n,
      );
      if (open >= UPLOAD_LIMITS.maxOpenPerStaff)
        throw new ProblemException(
          'conflict',
          'too many uploads are open: complete or cancel one first',
        );
      if (resourceId) {
        const r = (
          await c.query(
            `SELECT id FROM knowledge.resources WHERE id = $1 AND org_id IS NULL AND deleted_at IS NULL`,
            [resourceId],
          )
        ).rows[0];
        if (!r) throw new ProblemException('not_found', 'resource not found');
      }
      return (
        await c.query(
          `INSERT INTO knowledge.uploads (id, org_id, resource_id, filename, declared_bytes, part_size, checksum_expected, expires_at, created_by)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, now() + ($7 || ' milliseconds')::interval, $8) RETURNING *`,
          [
            newId(),
            resourceId ?? null,
            filename,
            declared,
            partSize,
            (body.sha256 as string).toLowerCase(),
            String(UPLOAD_LIMITS.ttlMs),
            actor,
          ],
        )
      ).rows[0] as Row;
    });
    await this.audit.record({
      action: 'knowledge.upload.opened',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'knowledge_upload', id: row.id as string },
      outcome: 'success',
      detail: { declaredBytes: declared, resourceId: resourceId ?? null },
    });
    return toUpload(row);
  }

  async get(id: string) {
    const row = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM knowledge.uploads WHERE id = $1 AND org_id IS NULL`, [id]))
          .rows[0] as Row | undefined,
    );
    if (!row) throw new ProblemException('not_found', 'upload not found');
    return toUpload(await this.expireIfDue(row));
  }

  /** An upload past its time is EXPIRED the first time anyone looks at it; its parts are discarded (a sweep job takes over in S-K2). */
  private async expireIfDue(row: Row): Promise<Row> {
    if (row.state !== 'OPEN' || (row.expires_at as Date) > new Date()) return row;
    const upd = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE knowledge.uploads SET state = 'EXPIRED' WHERE id = $1 AND state = 'OPEN' RETURNING *`,
            [row.id],
          )
        ).rows[0] as Row | undefined,
    );
    await this.store.discardUpload(row.id as string);
    return upd ?? { ...row, state: 'EXPIRED' };
  }

  async putPart(
    actor: string,
    uploadId: string,
    partNumber: number,
    partSha: string | undefined,
    data: Buffer,
  ) {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > UPLOAD_LIMITS.maxParts)
      throw new ProblemException('validation_failed', 'partNumber is out of range');
    if (!Buffer.isBuffer(data) || data.length === 0)
      throw new ProblemException('validation_failed', 'the part is empty');
    const sha = createHash('sha256').update(data).digest('hex');
    if (!partSha || partSha.toLowerCase() !== sha)
      throw new ProblemException(
        'validation_failed',
        'X-Part-Sha256 does not match the part that was received',
      );
    const result = await this.db.withPlatformScope(async (c) => {
      const row = (
        await c.query(
          `SELECT * FROM knowledge.uploads WHERE id = $1 AND org_id IS NULL FOR UPDATE`,
          [uploadId],
        )
      ).rows[0] as Row | undefined;
      if (!row) throw new ProblemException('not_found', 'upload not found');
      if (row.state !== 'OPEN' || (row.expires_at as Date) <= new Date())
        throw new ProblemException('conflict', `the upload is ${String(row.state).toLowerCase()}`);
      if (data.length > Number(row.part_size))
        throw new ProblemException('payload_too_large', 'the part is larger than the part size');
      const parts = ((row.parts as PartRow[]) ?? []).filter((p) => p.partNumber !== partNumber);
      const total = parts.reduce((s, p) => s + p.bytes, 0) + data.length;
      if (total > Number(row.declared_bytes))
        throw new ProblemException(
          'knowledge_upload_incomplete',
          'the parts exceed the declared size',
        );
      await this.store.putPart(uploadId, partNumber, data);
      parts.push({ partNumber, sha256: sha, bytes: data.length });
      parts.sort((a, b) => a.partNumber - b.partNumber);
      return (
        await c.query(
          `UPDATE knowledge.uploads SET parts = $2::jsonb, received_bytes = $3 WHERE id = $1 RETURNING *`,
          [uploadId, JSON.stringify(parts), total],
        )
      ).rows[0] as Row;
    });
    void actor;
    return toUpload(result);
  }

  async cancel(actor: string, uploadId: string) {
    const state = await this.db.withPlatformScope(async (c) => {
      const row = (
        await c.query(
          `SELECT state FROM knowledge.uploads WHERE id = $1 AND org_id IS NULL FOR UPDATE`,
          [uploadId],
        )
      ).rows[0] as Row | undefined;
      if (!row) throw new ProblemException('not_found', 'upload not found');
      if (row.state === 'COMPLETED')
        throw new ProblemException(
          'conflict',
          'a completed upload cannot be cancelled: disable or archive the resource',
        );
      if (row.state === 'OPEN')
        await c.query(`UPDATE knowledge.uploads SET state = 'CANCELLED' WHERE id = $1`, [uploadId]);
      return row.state as string;
    });
    await this.store.discardUpload(uploadId);
    if (state === 'OPEN')
      await this.audit.record({
        action: 'knowledge.upload.cancelled',
        actorUserId: actor,
        actorType: 'user',
        resource: { type: 'knowledge_upload', id: uploadId },
        outcome: 'success',
      });
  }

  /**
   * Assembles the parts, verifies the whole-object checksum and creates the resource (or the next version of `resourceId`). `canPublish` is the caller's
   * `admin:ai_knowledge:publish`: switching AI processing on at upload needs it (D-49).
   */
  async complete(actor: string, canPublish: boolean, uploadId: string, body: Row) {
    const meta = (body.metadata ?? {}) as Row;
    const name = text(meta.name, 'metadata.name', 200, false)!;
    const type = oneOf(RESOURCE_TYPES, meta.resourceType, 'metadata.resourceType')!;
    const platform = oneOf(PLATFORMS, meta.platform, 'metadata.platform', true) ?? null;
    const perms = (meta.reusePermissions ?? {}) as Row;
    const reuse =
      oneOf(REUSE_SCOPES, perms.reuseScope, 'reusePermissions.reuseScope', true) ?? 'NONE';
    const aiProcessing = perms.aiProcessing === true;
    if (aiProcessing && !canPublish)
      throw new ProblemException(
        'forbidden',
        'allowing AI processing of a resource needs the publish permission',
      );
    // THIRD_PARTY (two approvers, neither the uploader) is the default; declaring our own work FIRST_PARTY is a publish-level decision
    const provenanceClass =
      meta.provenanceClass === undefined
        ? 'THIRD_PARTY'
        : oneOf(PROVENANCE_CLASSES, meta.provenanceClass, 'metadata.provenanceClass')!;
    if (provenanceClass === 'FIRST_PARTY' && !canPublish)
      throw new ProblemException(
        'forbidden',
        'declaring a resource first-party needs the publish permission',
      );
    if (meta.visibility !== undefined && meta.visibility !== 'PLATFORM_PRIVATE')
      throw new ProblemException(
        'validation_failed',
        'a resource is created private; it is published after review',
      );
    const claimed = body.parts;
    if (!Array.isArray(claimed) || claimed.length === 0)
      throw new ProblemException('validation_failed', 'parts is required');
    const fields = {
      description: text(meta.description, 'metadata.description', 4000),
      frameworks: stringList(meta.frameworks, 'metadata.frameworks'),
      languages: stringList(meta.languages, 'metadata.languages'),
      category: text(meta.category, 'metadata.category', 80),
      tags: stringList(meta.tags, 'metadata.tags'),
      license: text(meta.license, 'metadata.license', 120),
      source: text(meta.source, 'metadata.source', 300),
      region: text(meta.dataRegion, 'metadata.dataRegion', 40) ?? DEFAULT_DATA_REGION,
      defaultEligible: meta.defaultEligible === true,
    };

    // 1. lock the session and check it against what the client says it sent
    const upload = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM knowledge.uploads WHERE id = $1 AND org_id IS NULL FOR UPDATE`,
            [uploadId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!upload) throw new ProblemException('not_found', 'upload not found');
    if (upload.state !== 'OPEN' || (upload.expires_at as Date) <= new Date())
      throw new ProblemException('conflict', `the upload is ${String(upload.state).toLowerCase()}`);
    const have = ((upload.parts as PartRow[]) ?? [])
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber);
    const ok =
      have.length === claimed.length &&
      have.every((p, i) => {
        const c = claimed[i] as Row | undefined;
        return (
          p.partNumber === i + 1 &&
          c?.partNumber === p.partNumber &&
          typeof c.sha256 === 'string' &&
          c.sha256.toLowerCase() === p.sha256
        );
      });
    if (!ok)
      throw new ProblemException(
        'knowledge_upload_incomplete',
        'the part list does not match the parts received (parts must be contiguous from 1)',
      );
    if (have.reduce((s, p) => s + p.bytes, 0) !== Number(upload.declared_bytes))
      throw new ProblemException(
        'knowledge_upload_incomplete',
        'the received bytes differ from the declared size',
      );

    // 2. assemble and verify the whole object BEFORE anything is recorded
    const composed = await this.store.compose(
      uploadId,
      have.map((p) => p.partNumber),
      upload.checksum_expected as string,
    );
    if ('mismatch' in composed)
      throw new ProblemException(
        'knowledge_upload_incomplete',
        'the assembled package does not match the declared SHA-256',
      );

    // 3. record the resource and its immutable version in one transaction
    const created = await this.db.withPlatformScope(async (c) => {
      const locked = (
        await c.query(`SELECT state FROM knowledge.uploads WHERE id = $1 FOR UPDATE`, [uploadId])
      ).rows[0] as Row;
      if (locked.state !== 'OPEN')
        throw new ProblemException('conflict', 'the upload was completed or cancelled meanwhile');
      let resourceId = (upload.resource_id as string | null) ?? null;
      let seq = 1;
      let resource: Row;
      const provenance = {
        sourceKind: 'upload',
        filename: upload.filename,
        uploadId,
        uploadedBy: actor,
        uploadedAt: new Date().toISOString(),
        deduplicated: composed.deduplicated,
      };
      if (resourceId) {
        resource = (
          await c.query(
            `SELECT * FROM knowledge.resources WHERE id = $1 AND org_id IS NULL AND deleted_at IS NULL FOR UPDATE`,
            [resourceId],
          )
        ).rows[0] as Row;
        if (!resource) throw new ProblemException('not_found', 'resource not found');
        if (resource.status === 'ARCHIVED')
          throw new ProblemException('conflict', 'the resource is archived');
        seq =
          Number(
            (
              await c.query(
                `SELECT coalesce(max(seq), 0) AS m FROM knowledge.resource_versions WHERE resource_id = $1`,
                [resourceId],
              )
            ).rows[0]!.m,
          ) + 1;
      } else {
        resourceId = newId();
        let slug = slugify(name);
        const taken = await c.query(
          `SELECT 1 FROM knowledge.resources WHERE org_id IS NULL AND slug = $1 AND deleted_at IS NULL`,
          [slug],
        );
        if (taken.rowCount) slug = `${slug}-${newId().slice(-6)}`;
        resource = (
          await c.query(
            `INSERT INTO knowledge.resources (id, org_id, slug, name, description, resource_type, platform, frameworks, languages, category, tags, visibility,
                                              source_kind, source_ref, status, default_eligible, data_region, created_by, provenance_class)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PLATFORM_PRIVATE', 'upload', $11, 'QUARANTINED', $12, $13, $14, $15) RETURNING *`,
            [
              resourceId,
              slug,
              name,
              fields.description,
              type,
              platform,
              fields.frameworks,
              fields.languages,
              fields.category,
              fields.tags,
              fields.source,
              fields.defaultEligible,
              fields.region,
              actor,
              provenanceClass,
            ],
          )
        ).rows[0] as Row;
        await c.query(
          `INSERT INTO knowledge.resource_permissions (id, resource_id, org_id, reuse_scope, ai_processing, component_reuse, starter_eligible, architecture_reference,
                                                       license_spdx, license_verdict, updated_by)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, 'UNKNOWN', $9)`,
          [
            newId(),
            resourceId,
            reuse,
            aiProcessing,
            perms.componentReuse === true,
            perms.starterEligible === true,
            perms.architectureReference === true,
            fields.license,
            actor,
          ],
        );
      }
      const versionId = newId();
      await c.query(
        `INSERT INTO knowledge.resource_versions (id, resource_id, org_id, seq, semver, state, checksum_sha256, bytes, archive_key, provenance, license_verdict, parent_version_id, created_by)
         VALUES ($1, $2, NULL, $3, $4, 'QUARANTINED', $5, $6, $7, $8::jsonb, 'UNKNOWN', $9, $10)`,
        [
          versionId,
          resourceId,
          seq,
          typeof meta.version === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(meta.version)
            ? meta.version
            : null,
          composed.sha256,
          composed.bytes,
          composed.key,
          JSON.stringify(provenance),
          (resource.current_version_id as string | null) ?? null,
          actor,
        ],
      );
      resource = (
        await c.query(
          `UPDATE knowledge.resources SET current_version_id = $2 WHERE id = $1 RETURNING *`,
          [resourceId, versionId],
        )
      ).rows[0] as Row;
      // the ingestion pipeline (S-K2a): the worker claims this job, verifies the archive and queues extraction. Nothing is unpacked here.
      await c.query(
        `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind, created_by) VALUES ($1, $2, NULL, 'VALIDATE', $3)`,
        [newId(), versionId, actor],
      );
      await c.query(
        `UPDATE knowledge.uploads SET state = 'COMPLETED', resource_id = $2 WHERE id = $1`,
        [uploadId, resourceId],
      );
      return { resource, versionId, seq };
    });
    await this.store.discardUpload(uploadId);
    await this.audit.record({
      action: 'knowledge.upload.completed',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'knowledge_resource', id: created.resource.id as string },
      outcome: 'success',
      detail: {
        versionId: created.versionId,
        seq: created.seq,
        bytes: composed.bytes,
        sha256: composed.sha256,
        deduplicated: composed.deduplicated,
      },
    });
    return toResource(created.resource);
  }
}
