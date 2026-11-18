import type { DataService } from '@nuzm/adapter-data';

/** Operation kinds of the data module (platform.operations.kind). */
export const OP = {
  DB_CREATE: 'data.database.create',
  DB_DELETE: 'data.database.delete',
  DB_BACKUP: 'data.database.backup',
  DB_RESTORE: 'data.database.restore',
  DB_ROTATE: 'data.database.rotate',
  DB_ROTATE_END: 'data.database.rotate_end',
  DB_VERIFY: 'data.database.restore_verify',
  BUCKET_CREATE: 'data.bucket.create',
  BUCKET_DELETE: 'data.bucket.delete',
  MAILBOX_CREATE: 'email.mailbox.create',
  MAILBOX_UPDATE: 'email.mailbox.update',
  MAILBOX_DELETE: 'email.mailbox.delete',
  ALIAS_ADD: 'email.alias.add',
  MESSAGE_SEND: 'email.message.send',
} as const;
export const DATA_OP_KINDS: readonly string[] = Object.values(OP);

export type Row = Record<string, unknown>;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

export const ENGINES = ['postgresql', 'mysql', 'redis'] as const;
export type Engine = (typeof ENGINES)[number];
export const serviceOfEngine = (e: Engine): DataService => (e === 'redis' ? 'cache' : 'database');
/** `platform.operations.resource_kind` of a managed database / cache instance. */
export const DB_RESOURCE = 'database';

/**
 * Proposals (D-34, D-31 and the M08 prompt): every value is configuration with a conservative default, none is a legal period.
 * Overridable per environment; per-organization overrides come from entitlements (`data_backup_retention_days`, `data_backup_interval_hours`).
 */
export interface DataConfig {
  /** Dual-credential window of a rotation (proposal 24 h). */
  rotationWindowHours: number;
  /** Backup retention in days (D-34 OPEN: conservative default; never a legal period). */
  backupRetentionDays: number;
  /** Scheduled backup frequency in hours (proposal). */
  backupIntervalHours: number;
  /** Restore-verification cadence in days (proposal: weekly). */
  verificationIntervalDays: number;
  /** Tables sampled by the integrity check. */
  verificationSampleTables: number;
  /** In-process retries of a call that PROVABLY did not happen (rate limit / outage). */
  transientRetries: number;
  transientRetryDelayMs: number;
  /** How often to look (and how long to wait between looks) for an instance to reach running before the operation parks for reconcile. */
  provisionPollAttempts: number;
  provisionPollDelayMs: number;
  hoursPerMonth: number;
}
export const loadDataConfig = (env: NodeJS.ProcessEnv = process.env): DataConfig => {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    rotationWindowHours: n('DATA_ROTATION_WINDOW_HOURS', 24),
    backupRetentionDays: n('DATA_BACKUP_RETENTION_DAYS', 7),
    backupIntervalHours: n('DATA_BACKUP_INTERVAL_HOURS', 24),
    verificationIntervalDays: n('DATA_VERIFY_INTERVAL_DAYS', 7),
    verificationSampleTables: n('DATA_VERIFY_SAMPLE_TABLES', 20),
    transientRetries: n('DATA_TRANSIENT_RETRIES', 3),
    transientRetryDelayMs: Number(env.DATA_TRANSIENT_RETRY_DELAY_MS ?? 200),
    provisionPollAttempts: n('DATA_PROVISION_POLL_ATTEMPTS', 30),
    provisionPollDelayMs: Number(env.DATA_PROVISION_POLL_DELAY_MS ?? 1000),
    hoursPerMonth: 730,
  };
};
export const DATA_CONFIG = Symbol('DATA_CONFIG');
