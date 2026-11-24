import type { Db } from '@nuzm/platform';

/** Storage port of the benchmark module: append-only runs and governance records (migrations 1920 and 1921). Platform scope, no tenant data. */
export interface RunRow {
  id: string;
  label: string;
  datasetVersion: string;
  datasetHash: string;
  evidenceLabel: string;
  origins: string[];
  adapters: string[];
  report: unknown;
  scores: unknown;
  reportFingerprint: string;
  requestId: string;
  createdBy: string;
  createdAt: string;
}
export type RecordKind = 'threshold_acceptance' | 'budget' | 'security_review' | 'reviewers' | 'review_plan' | 'review' | 'qualification' | 'live_attempt';
export interface RecordRow {
  id: string;
  kind: RecordKind;
  subject: string;
  payload: unknown;
  requestId: string | null;
  recordedBy: string;
  recordedAt: string;
}
export abstract class BenchmarkStore {
  /** Inserts a run; a repeated `requestId` returns the stored row with `created: false`. */
  abstract insertRun(row: RunRow): Promise<{ row: RunRow; created: boolean }>;
  abstract getRun(id: string): Promise<RunRow | null>;
  abstract listRuns(limit: number): Promise<RunRow[]>;
  abstract insertRecord(row: RecordRow): Promise<{ row: RecordRow; created: boolean }>;
  /** Oldest first. */
  abstract records(kind: RecordKind, subject?: string): Promise<RecordRow[]>;
}

export class InMemoryBenchmarkStore extends BenchmarkStore {
  private runs: RunRow[] = [];
  private recs: RecordRow[] = [];
  insertRun(row: RunRow) {
    const dup = this.runs.find((r) => r.requestId === row.requestId);
    if (dup) return Promise.resolve({ row: dup, created: false });
    this.runs.push(row);
    return Promise.resolve({ row, created: true });
  }
  getRun(id: string) {
    return Promise.resolve(this.runs.find((r) => r.id === id) ?? null);
  }
  listRuns(limit: number) {
    return Promise.resolve([...this.runs].reverse().slice(0, limit));
  }
  insertRecord(row: RecordRow) {
    const dup = row.requestId ? this.recs.find((r) => r.requestId === row.requestId) : undefined;
    if (dup) return Promise.resolve({ row: dup, created: false });
    this.recs.push(row);
    return Promise.resolve({ row, created: true });
  }
  records(kind: RecordKind, subject?: string) {
    return Promise.resolve(this.recs.filter((r) => r.kind === kind && (subject === undefined || r.subject === subject)));
  }
}

const iso = (v: unknown) => new Date(v as string).toISOString();
export class PgBenchmarkStore extends BenchmarkStore {
  constructor(private readonly db: Db) {
    super();
  }
  private toRun(r: Record<string, unknown>): RunRow {
    return {
      id: r.id as string,
      label: r.label as string,
      datasetVersion: r.dataset_version as string,
      datasetHash: r.dataset_hash as string,
      evidenceLabel: r.evidence_label as string,
      origins: r.origins as string[],
      adapters: r.adapters as string[],
      report: r.report,
      scores: r.scores,
      reportFingerprint: r.report_fingerprint as string,
      requestId: r.request_id as string,
      createdBy: r.created_by as string,
      createdAt: iso(r.created_at),
    };
  }
  private toRec(r: Record<string, unknown>): RecordRow {
    return {
      id: r.id as string,
      kind: r.kind as RecordKind,
      subject: r.subject as string,
      payload: r.payload,
      requestId: (r.request_id as string | null) ?? null,
      recordedBy: r.recorded_by as string,
      recordedAt: iso(r.recorded_at),
    };
  }
  async insertRun(row: RunRow) {
    return this.db.withPlatformScope(async (c) => {
      const ins = await c.query(
        `INSERT INTO ai.benchmark_runs (id, label, dataset_version, dataset_hash, evidence_label, origins, adapters, report, scores, report_fingerprint, request_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (request_id) DO NOTHING RETURNING *`,
        [row.id, row.label, row.datasetVersion, row.datasetHash, row.evidenceLabel, row.origins, row.adapters, JSON.stringify(row.report), JSON.stringify(row.scores), row.reportFingerprint, row.requestId, row.createdBy],
      );
      if (ins.rows[0]) return { row: this.toRun(ins.rows[0]), created: true };
      const old = await c.query(`SELECT * FROM ai.benchmark_runs WHERE request_id = $1`, [row.requestId]);
      return { row: this.toRun(old.rows[0]), created: false };
    });
  }
  async getRun(id: string) {
    return this.db.withPlatformScope(async (c) => {
      const r = await c.query(`SELECT * FROM ai.benchmark_runs WHERE id = $1`, [id]);
      return r.rows[0] ? this.toRun(r.rows[0]) : null;
    });
  }
  async listRuns(limit: number) {
    return this.db.withPlatformScope(async (c) => (await c.query(`SELECT * FROM ai.benchmark_runs ORDER BY created_at DESC, id DESC LIMIT $1`, [limit])).rows.map((r) => this.toRun(r)));
  }
  async insertRecord(row: RecordRow) {
    return this.db.withPlatformScope(async (c) => {
      const ins = await c.query(
        `INSERT INTO ai.benchmark_records (id, kind, subject, payload, request_id, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (request_id) DO NOTHING RETURNING *`,
        [row.id, row.kind, row.subject, JSON.stringify(row.payload), row.requestId, row.recordedBy],
      );
      if (ins.rows[0]) return { row: this.toRec(ins.rows[0]), created: true };
      const old = await c.query(`SELECT * FROM ai.benchmark_records WHERE request_id = $1`, [row.requestId]);
      return { row: this.toRec(old.rows[0]), created: false };
    });
  }
  async records(kind: RecordKind, subject?: string) {
    return this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT * FROM ai.benchmark_records WHERE kind = $1 AND ($2::text IS NULL OR subject = $2) ORDER BY recorded_at ASC, id ASC`,
          [kind, subject ?? null],
        )
      ).rows.map((r) => this.toRec(r)),
    );
  }
}
