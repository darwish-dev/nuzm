import { createHash } from 'node:crypto';
import { uuidv7, type Db } from '@nuzm/platform';
import {
  ArchiveRejected,
  DEFAULT_LIMITS,
  detectFormat,
  ingestArchive,
  parseZipDirectory,
  type ArchiveSource,
  type ExtractLimits,
  type IngestResult,
  type SnapshotSink,
} from '@nuzm/domain';
import { KnowledgeObjectStore, ObjectStoreError } from '@nuzm/adapter-knowledge-store';

/**
 * Secure project ingestion worker (S-K2a, ADR-065). It claims platform-library jobs (VALIDATE, EXTRACT) from `knowledge.processing_jobs` and drives a version through
 * QUARANTINED -> VALIDATING -> ANALYZING -> AWAITING_REVIEW. It is a parser, not an executor: uploaded bytes are hashed, classified and pattern-scanned; nothing is
 * installed, imported, built or run. It runs under the `nuzm_worker` role in the `knowledge` worker scope, which the database restricts to platform rows and to the
 * columns this service writes: it cannot activate a version, set a licence verdict or write a review.
 *
 * Failure model: a hostile or malformed package is a permanent FAILED (a stable code, never file content); an infrastructure error is retried with back-off and then
 * dead-lettered; a lost lease or a cancellation stops the work and writes nothing. Every state change is also written to `knowledge.processing_logs`.
 */
type Tx = Parameters<Parameters<Db['withKnowledgeWorker']>[0]>[0];
export interface IngestJob {
  id: string;
  versionId: string;
  kind: 'VALIDATE' | 'EXTRACT';
  attempt: number;
  maxAttempts: number;
}
export interface IngestServiceOptions {
  workerId?: string;
  leaseSeconds?: number;
  limits?: Partial<ExtractLimits>;
  canaries?: readonly string[];
  denied?: (ecosystem: string, name: string) => boolean;
  now?: () => number;
  log?: (message: string, extra?: Record<string, unknown>) => void;
  /** How often a running job renews its lease and looks for a cancellation request. */
  heartbeatMs?: number;
}
const KINDS = ['VALIDATE', 'EXTRACT'];
const TRANSIENT_DELAY = (attempt: number) => Math.min(30 * 2 ** Math.max(0, attempt - 1), 600);
const MAX_LOGS_PER_JOB = 200;

class Stop extends Error {
  constructor(readonly why: 'cancelled' | 'lease_lost') {
    super(why);
  }
}

export class KnowledgeIngestService {
  private readonly workerId: string;
  private readonly lease: number;
  private readonly limits: Partial<ExtractLimits>;
  private readonly say: (message: string, extra?: Record<string, unknown>) => void;
  private logCount = new Map<string, number>();
  constructor(
    private readonly db: Db,
    private readonly store: KnowledgeObjectStore,
    private readonly opts: IngestServiceOptions = {},
  ) {
    this.workerId = opts.workerId ?? `kw-${process.pid}-${uuidv7().slice(-6)}`;
    this.lease = opts.leaseSeconds ?? 120;
    this.limits = opts.limits ?? {};
    this.say = opts.log ?? (() => undefined);
  }

  /** Claims and processes at most one job. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    await this.reap();
    const job = await this.claim();
    if (!job) return false;
    if (job === 'skipped') return true;
    const t0 = Date.now();
    try {
      if (job.kind === 'VALIDATE') await this.validate(job);
      else await this.extract(job);
      this.say('knowledge_job_done', { job: job.id, kind: job.kind, ms: Date.now() - t0 });
    } catch (e) {
      await this.settleFailure(job, e);
    }
    return true;
  }

  /** Processes jobs until the queue is empty or `max` jobs were handled. */
  async drain(max = 25): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n++;
    return n;
  }

  // ---- queue ----------------------------------------------------------------------------------------------------------------------
  /** Leases that expired (a worker died or hung) go back to the queue, or to the dead letter after the last attempt. */
  private async reap(): Promise<void> {
    await this.db.withKnowledgeWorker(async (c) => {
      await c.query(
        `UPDATE knowledge.processing_jobs SET state = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL, run_after = now(), error_code = 'lease_expired'
          WHERE state = 'RUNNING' AND org_id IS NULL AND lease_expires_at < now() AND attempt < max_attempts AND kind = ANY($1)`,
        [KINDS],
      );
      const dead = await c.query(
        `UPDATE knowledge.processing_jobs SET state = 'DEAD_LETTER', error_code = 'lease_expired', finished_at = now(),
                error_detail = 'the job exhausted its attempts without finishing'
          WHERE state = 'RUNNING' AND org_id IS NULL AND lease_expires_at < now() AND attempt >= max_attempts AND kind = ANY($1)
          RETURNING id, version_id`,
        [KINDS],
      );
      for (const r of dead.rows) {
        await this.setVersion(
          c,
          r.version_id,
          ['VALIDATING', 'ANALYZING'],
          'FAILED',
          'processing_failed',
        );
        await this.writeLog(
          c,
          r.id,
          r.version_id,
          'error',
          'QUEUE',
          'job.dead_letter',
          'the job exhausted its attempts and was dead-lettered',
        );
      }
    });
  }

  /** `skipped`: a job was taken off the queue without running (cancelled or retired resource); the queue is not empty. */
  private async claim(): Promise<IngestJob | 'skipped' | null> {
    return this.db.withKnowledgeWorker(async (c) => {
      const r = await c.query(
        `WITH next AS (
           SELECT id FROM knowledge.processing_jobs
            WHERE state = 'QUEUED' AND org_id IS NULL AND run_after <= now() AND kind = ANY($3)
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         UPDATE knowledge.processing_jobs j
            SET state = 'RUNNING', attempt = j.attempt + 1, lease_owner = $1, lease_expires_at = now() + make_interval(secs => $2),
                heartbeat_at = now(), started_at = coalesce(j.started_at, now()), error_code = NULL, error_detail = NULL
           FROM next WHERE j.id = next.id
         RETURNING j.id, j.version_id, j.kind, j.attempt, j.max_attempts, j.cancel_requested`,
        [this.workerId, this.lease, KINDS],
      );
      const row = r.rows[0];
      if (!row) return null;
      this.logCount.set(row.id, 0);
      const owner = await c.query(
        `SELECT r.status, r.deleted_at FROM knowledge.resources r JOIN knowledge.resource_versions v ON v.resource_id = r.id WHERE v.id = $1`,
        [row.version_id],
      );
      const retired =
        !owner.rows[0] ||
        owner.rows[0].deleted_at !== null ||
        ['ARCHIVED', 'DISABLED'].includes(owner.rows[0].status);
      if (retired) {
        await c.query(
          `UPDATE knowledge.processing_jobs SET state = 'CANCELLED', finished_at = now(), error_code = 'cancelled', error_detail = 'the resource was disabled or archived' WHERE id = $1`,
          [row.id],
        );
        await this.writeLog(
          c,
          row.id,
          row.version_id,
          'warn',
          row.kind,
          'job.skipped',
          'the resource was disabled or archived; the job was not run',
        );
        return 'skipped';
      }
      if (row.cancel_requested) {
        await c.query(
          `UPDATE knowledge.processing_jobs SET state = 'CANCELLED', finished_at = now(), error_code = 'cancelled' WHERE id = $1`,
          [row.id],
        );
        await this.setVersion(
          c,
          row.version_id,
          ['QUARANTINED', 'VALIDATING', 'ANALYZING'],
          'QUARANTINED',
          'cancelled',
        );
        await this.writeLog(
          c,
          row.id,
          row.version_id,
          'warn',
          row.kind,
          'job.cancelled',
          'the job was cancelled before it started',
        );
        return 'skipped';
      }
      // the version moves in the same transaction as the claim, so a dead worker can never leave a job running against a QUARANTINED version
      if (row.kind === 'VALIDATE')
        await this.setVersion(c, row.version_id, ['QUARANTINED'], 'VALIDATING', null);
      else await this.setVersion(c, row.version_id, ['VALIDATING'], 'ANALYZING', null);
      await this.writeLog(
        c,
        row.id,
        row.version_id,
        'info',
        row.kind,
        'job.started',
        `attempt ${row.attempt} of ${row.max_attempts} started`,
        { attempt: row.attempt, worker: this.workerId },
      );
      return {
        id: row.id,
        versionId: row.version_id,
        kind: row.kind,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
      };
    });
  }

  private async setVersion(
    c: Tx,
    versionId: string,
    from: string[],
    to: string,
    reason: string | null,
  ): Promise<number> {
    const r = await c.query(
      `UPDATE knowledge.resource_versions SET state = $3, state_reason = $4 WHERE id = $1 AND state = ANY($2)`,
      [versionId, from, to, reason],
    );
    if (r.rowCount) {
      // the resource row mirrors the state of its CURRENT version
      await c.query(
        `UPDATE knowledge.resources r SET status = $2 FROM knowledge.resource_versions v
          WHERE v.id = $1 AND r.id = v.resource_id AND r.current_version_id = v.id AND r.deleted_at IS NULL AND r.status NOT IN ('ARCHIVED','DISABLED')`,
        [versionId, to],
      );
    }
    return r.rowCount ?? 0;
  }

  private async writeLog(
    c: Tx,
    jobId: string,
    versionId: string,
    level: string,
    stage: string,
    code: string,
    message: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    const n = (this.logCount.get(jobId) ?? 0) + 1;
    this.logCount.set(jobId, n);
    if (n > MAX_LOGS_PER_JOB && level !== 'error') return;
    await c.query(
      `INSERT INTO knowledge.processing_logs (id, job_id, version_id, org_id, level, stage, code, message, data) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8::jsonb)`,
      [uuidv7(), jobId, versionId, level, stage, code, message.slice(0, 500), JSON.stringify(data)],
    );
  }
  private log(
    job: IngestJob,
    level: 'info' | 'warn' | 'error',
    code: string,
    message: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    return this.db.withKnowledgeWorker((c) =>
      this.writeLog(c, job.id, job.versionId, level, job.kind, code, message, data),
    );
  }

  // ---- shared -----------------------------------------------------------------------------------------------------------------------
  private async version(versionId: string) {
    return this.db.withKnowledgeWorker(async (c) => {
      const r = await c.query(
        `SELECT id, resource_id, checksum_sha256, bytes::text AS bytes, archive_key, state FROM knowledge.resource_versions WHERE id = $1`,
        [versionId],
      );
      const row = r.rows[0];
      if (!row) throw new ArchiveRejected('corrupt', 'the version no longer exists');
      return row as {
        id: string;
        resource_id: string;
        checksum_sha256: string;
        bytes: string;
        archive_key: string;
        state: string;
      };
    });
  }

  private source(key: string, size: number): ArchiveSource {
    return {
      size,
      readRange: (o, l) => this.store.readRange(key, o, l),
      openStream: () => this.store.open(key),
    };
  }
  private sink(): SnapshotSink {
    return {
      putSnapshot: async (sha, data) => {
        const key = `snapshots/${sha}`;
        await this.store.put(key, data, { ifAbsent: true });
        return key;
      },
    };
  }

  /** Keeps the lease alive and watches for a cancellation request while `fn` runs. */
  private async guarded<T>(
    job: IngestJob,
    fn: (stopped: () => 'cancelled' | 'lease_lost' | null) => Promise<T>,
  ): Promise<T> {
    let stop: 'cancelled' | 'lease_lost' | null = null;
    const beat = async () => {
      try {
        const r = await this.db.withKnowledgeWorker((c) =>
          c.query(
            `UPDATE knowledge.processing_jobs SET heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => $3)
              WHERE id = $1 AND lease_owner = $2 AND state = 'RUNNING' RETURNING cancel_requested`,
            [job.id, this.workerId, this.lease],
          ),
        );
        if (!r.rows[0]) stop = 'lease_lost';
        else if (r.rows[0].cancel_requested) stop = 'cancelled';
      } catch {
        // a missed heartbeat is not fatal by itself: the lease has headroom, and losing it is detected on the next beat or at the final write
      }
    };
    const timer = setInterval(
      () => void beat(),
      this.opts.heartbeatMs ?? Math.max(1000, Math.min(15_000, (this.lease * 1000) / 3)),
    );
    try {
      await beat();
      return await fn(() => stop);
    } finally {
      clearInterval(timer);
    }
  }

  private async finishJob(
    c: Tx,
    job: IngestJob,
    state: 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
    extra: { code?: string; detail?: string; result?: unknown } = {},
  ): Promise<void> {
    const r = await c.query(
      `UPDATE knowledge.processing_jobs SET state = $3, finished_at = now(), progress = CASE WHEN $3 = 'SUCCEEDED' THEN 100 ELSE progress END,
              error_code = $4, error_detail = $5, result = $6::jsonb, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND lease_owner = $2 AND state = 'RUNNING'`,
      [
        job.id,
        this.workerId,
        state,
        extra.code ?? null,
        extra.detail?.slice(0, 1000) ?? null,
        extra.result ? JSON.stringify(extra.result) : null,
      ],
    );
    if (r.rowCount !== 1) throw new Stop('lease_lost'); // the transaction rolls back: a reaped job writes nothing
  }

  // ---- VALIDATE ---------------------------------------------------------------------------------------------------------------------
  /** Cheap integrity and structure checks before any extraction work: object present, size and SHA-256 re-verified at rest, format sniffed, ZIP directory limits. */
  private async validate(job: IngestJob): Promise<void> {
    const v = await this.version(job.versionId);
    const size = await this.store.size(v.archive_key);
    if (size === null) throw new ObjectStoreError('not_found', 'the stored archive is missing');
    if (String(size) !== v.bytes)
      throw new ArchiveRejected(
        'size_mismatch',
        'the stored archive does not have the recorded size',
      );
    await this.guarded(job, async (stopped) => {
      const hash = createHash('sha256');
      for await (const chunk of await this.store.open(v.archive_key)) {
        hash.update(chunk as Buffer);
        const s = stopped();
        if (s) throw new Stop(s);
      }
      if (hash.digest('hex') !== v.checksum_sha256)
        throw new ArchiveRejected(
          'crc_mismatch',
          'the stored archive does not match its recorded SHA-256',
        );
      const src = this.source(v.archive_key, size);
      const format = await detectFormat(src);
      let entries: number | undefined;
      if (format === 'zip')
        entries = (await parseZipDirectory(src, { ...DEFAULT_LIMITS, ...this.limits })).length;
      await this.log(
        job,
        'info',
        'validate.ok',
        `archive verified (${format}${entries !== undefined ? `, ${entries} entries` : ''})`,
        { format, entries, bytes: size },
      );
    });
    await this.db.withKnowledgeWorker(async (c) => {
      // the next stage is queued in the same transaction that finishes this one; a duplicate (retry) is ignored by the one-active-job index
      await c.query(
        `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind) VALUES ($1,$2,NULL,'EXTRACT') ON CONFLICT DO NOTHING`,
        [uuidv7(), job.versionId],
      );
      await this.finishJob(c, job, 'SUCCEEDED', { result: { next: 'EXTRACT' } });
    });
  }

  // ---- EXTRACT ----------------------------------------------------------------------------------------------------------------------
  private async extract(job: IngestJob): Promise<void> {
    const v = await this.version(job.versionId);
    const size = Number(v.bytes);
    const result = await this.guarded(job, async (stopped) => {
      await this.log(
        job,
        'info',
        'extract.begin',
        'extraction and scans started; nothing from the package is executed',
      );
      const run = (dryRun: boolean) =>
        ingestArchive(this.source(v.archive_key, size), this.sink(), {
          limits: this.limits,
          canaries: this.opts.canaries,
          denied: this.opts.denied,
          now: this.opts.now,
          dryRun,
          shouldCancel: () => stopped() !== null,
        }).catch((e: unknown) => {
          if (e instanceof ArchiveRejected && e.code === 'cancelled')
            throw new Stop(stopped() ?? 'cancelled');
          throw e;
        });
      // Pass 1 proves the WHOLE package (every size, checksum, path, limit and scan) without writing a byte. Only a package that passes is stored, and a package with a
      // blocking finding is not stored at all: a rejected or quarantined upload leaves nothing but its original archive in the object store.
      const dry = await run(true);
      if (dry.blocked) return quarantineKeys(dry);
      await this.log(
        job,
        'info',
        'extract.verified',
        'the package passed every check; writing the snapshot',
        { files: dry.stats.files },
      );
      return run(false);
    });
    const next = result.blocked ? 'QUARANTINED' : 'AWAITING_REVIEW';
    const reason = result.blocked ? blockReason(result) : null;
    await this.db.withKnowledgeWorker(async (c) => {
      await this.insertFiles(c, job.versionId, result);
      await this.insertDependencies(c, job.versionId, result);
      await this.insertFindings(c, job, result);
      const summary = this.summary(result);
      const upd = await c.query(
        `UPDATE knowledge.resource_versions SET license_proposal = $2::jsonb, ingest_summary = $3::jsonb, analysis_job_id = $4 WHERE id = $1 AND state = 'ANALYZING'`,
        [job.versionId, JSON.stringify(result.license), JSON.stringify(summary), job.id],
      );
      if (upd.rowCount !== 1) throw new Stop('lease_lost');
      await this.finishJob(c, job, 'SUCCEEDED', { result: summary });
      await this.setVersion(c, job.versionId, ['ANALYZING'], next, reason);
      await this.writeLog(
        c,
        job.id,
        job.versionId,
        result.blocked ? 'warn' : 'info',
        'EXTRACT',
        result.blocked ? 'extract.quarantined' : 'extract.done',
        result.blocked
          ? `analysis finished; the package stays quarantined (${reason})`
          : 'analysis finished; the package awaits review',
        {
          files: result.stats.files,
          stored: result.stats.stored,
          findings: result.findings.length,
          license: result.license.verdict,
        },
      );
    });
  }

  private summary(r: IngestResult): Record<string, unknown> {
    const bySeverity = { info: 0, warn: 0, block: 0 };
    for (const f of r.findings) bySeverity[f.severity]++;
    const notStored: Record<string, number> = {};
    for (const f of r.files)
      if (f.notStoredReason) notStored[f.notStoredReason] = (notStored[f.notStoredReason] ?? 0) + 1;
    return {
      format: r.format,
      ...r.stats,
      findings: bySeverity,
      notStored,
      dependencies: r.dependencies.length,
      blocked: r.blocked,
      license: { spdx: r.license.spdx, verdict: r.license.verdict },
    };
  }

  private async insertFiles(c: Tx, versionId: string, r: IngestResult): Promise<void> {
    for (let i = 0; i < r.files.length; i += 1000) {
      const part = r.files.slice(i, i + 1000);
      await c.query(
        `INSERT INTO knowledge.resource_files (id, version_id, org_id, path, sha256, bytes, language, is_binary, is_executable, object_key, secret_findings)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::bigint[], $7::text[], $8::boolean[], $9::boolean[], $10::text[], $11::int[])`,
        [
          part.map(() => uuidv7()),
          part.map(() => versionId),
          part.map(() => null),
          part.map((f) => f.path),
          part.map((f) => f.sha256),
          part.map((f) => f.bytes),
          part.map((f) => f.language),
          part.map((f) => f.isBinary),
          part.map((f) => f.isExecutable),
          part.map((f) => f.objectKey),
          part.map((f) => f.secretFindings),
        ],
      );
    }
  }
  private async insertDependencies(c: Tx, versionId: string, r: IngestResult): Promise<void> {
    const seen = new Set<string>();
    const deps = r.dependencies.filter((d) => {
      const k = `${d.ecosystem}:${d.name}:${d.kind}:${d.path}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
    for (let i = 0; i < deps.length; i += 1000) {
      const part = deps.slice(i, i + 1000);
      await c.query(
        `INSERT INTO knowledge.resource_dependencies (id, version_id, org_id, ecosystem, name, range, kind, path, license, risk)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])`,
        [
          part.map(() => uuidv7()),
          part.map(() => versionId),
          part.map(() => null),
          part.map((d) => d.ecosystem),
          part.map((d) => d.name),
          part.map((d) => d.range),
          part.map((d) => d.kind),
          part.map((d) => d.path),
          part.map((d) => d.license),
          part.map((d) => d.risk),
        ],
      );
    }
  }
  private async insertFindings(c: Tx, job: IngestJob, r: IngestResult): Promise<void> {
    for (let i = 0; i < r.findings.length; i += 1000) {
      const part = r.findings.slice(i, i + 1000);
      await c.query(
        `INSERT INTO knowledge.scan_findings (id, version_id, org_id, job_id, scanner, code, severity, path, line, detail)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::text[], $8::text[], $9::int[], $10::text[])`,
        [
          part.map(() => uuidv7()),
          part.map(() => job.versionId),
          part.map(() => null),
          part.map(() => job.id),
          part.map((f) => f.scanner),
          part.map((f) => f.code),
          part.map((f) => f.severity),
          part.map((f) => f.path?.slice(0, 500) ?? null),
          part.map((f) => f.line),
          part.map((f) => f.detail.slice(0, 500)),
        ],
      );
    }
  }

  // ---- failure handling -------------------------------------------------------------------------------------------------------------
  private async settleFailure(job: IngestJob, e: unknown): Promise<void> {
    try {
      if (e instanceof Stop) {
        if (e.why === 'lease_lost') {
          this.say('knowledge_job_lease_lost', { job: job.id });
          return; // the reaper owns it now; this worker writes nothing
        }
        await this.db.withKnowledgeWorker(async (c) => {
          await this.finishJob(c, job, 'CANCELLED', {
            code: 'cancelled',
            detail: 'cancelled by an administrator',
          });
          await this.setVersion(
            c,
            job.versionId,
            ['QUARANTINED', 'VALIDATING', 'ANALYZING'],
            'QUARANTINED',
            'cancelled',
          );
          await this.writeLog(
            c,
            job.id,
            job.versionId,
            'warn',
            job.kind,
            'job.cancelled',
            'the job was cancelled while running; nothing was recorded',
          );
        });
        return;
      }
      if (
        e instanceof ArchiveRejected ||
        (e instanceof ObjectStoreError && e.code === 'not_found')
      ) {
        const code = e instanceof ArchiveRejected ? e.code : 'archive_missing';
        const detail = e instanceof ArchiveRejected ? e.detail : 'the stored archive is missing';
        await this.db.withKnowledgeWorker(async (c) => {
          await this.finishJob(c, job, 'FAILED', { code, detail });
          await this.setVersion(c, job.versionId, ['VALIDATING', 'ANALYZING'], 'FAILED', code);
          await c.query(
            `INSERT INTO knowledge.scan_findings (id, version_id, org_id, job_id, scanner, code, severity, path, line, detail) VALUES ($1,$2,NULL,$3,'archive',$4,'block',NULL,NULL,$5)`,
            [uuidv7(), job.versionId, job.id, code, detail.slice(0, 500)],
          );
          await this.writeLog(
            c,
            job.id,
            job.versionId,
            'error',
            job.kind,
            `rejected.${code}`,
            `the package was rejected: ${detail}`,
            { code },
          );
        });
        return;
      }
      // anything else is treated as infrastructure trouble: back off and retry, then dead-letter. The raw error text is never stored (it can carry a connection string).
      const name = e instanceof Error ? e.name : 'Error';
      await this.db.withKnowledgeWorker(async (c) => {
        if (job.attempt < job.maxAttempts) {
          const delay = TRANSIENT_DELAY(job.attempt);
          const r = await c.query(
            `UPDATE knowledge.processing_jobs SET state = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL, run_after = now() + make_interval(secs => $3), error_code = 'transient_error',
                    error_detail = 'a temporary error interrupted the job; it will be retried'
              WHERE id = $1 AND lease_owner = $2 AND state = 'RUNNING'`,
            [job.id, this.workerId, delay],
          );
          if (r.rowCount === 1)
            await this.writeLog(
              c,
              job.id,
              job.versionId,
              'warn',
              job.kind,
              'job.retry',
              `a temporary error (${name}) interrupted the job; retrying in ${delay}s`,
              { attempt: job.attempt, delay },
            );
        } else {
          await this.finishJobAs(c, job, 'DEAD_LETTER');
          await this.setVersion(
            c,
            job.versionId,
            ['VALIDATING', 'ANALYZING'],
            'FAILED',
            'processing_failed',
          );
          await this.writeLog(
            c,
            job.id,
            job.versionId,
            'error',
            job.kind,
            'job.dead_letter',
            `the job failed ${job.attempt} times (${name}) and was dead-lettered`,
          );
        }
      });
    } catch (inner) {
      this.say('knowledge_job_settle_failed', {
        job: job.id,
        error: inner instanceof Error ? inner.name : 'Error',
      });
    }
  }
  private async finishJobAs(c: Tx, job: IngestJob, state: 'DEAD_LETTER'): Promise<void> {
    await c.query(
      `UPDATE knowledge.processing_jobs SET state = $3, finished_at = now(), error_code = 'processing_failed', error_detail = 'the job failed after its last attempt', lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND lease_owner = $2 AND state = 'RUNNING'`,
      [job.id, this.workerId, state],
    );
  }
}

function blockReason(r: IngestResult): string {
  const codes = new Set(r.findings.filter((f) => f.severity === 'block').map((f) => f.code));
  if (codes.has('secret_found')) return 'secrets_found';
  if (codes.has('license_blocked')) return 'license_blocked';
  if (codes.has('dependency_denied')) return 'denied_dependency';
  if (codes.has('lifecycle_script_network')) return 'install_script_network';
  return 'blocking_findings';
}

/** A package that must stay quarantined keeps its inventory (hashes, sizes, findings) but no stored content. */
function quarantineKeys(r: IngestResult): IngestResult {
  const files = r.files.map((f) =>
    f.objectKey ? { ...f, objectKey: null, notStoredReason: 'package_quarantined' } : f,
  );
  return { ...r, files, stats: { ...r.stats, stored: 0, storedBytes: 0 } };
}
