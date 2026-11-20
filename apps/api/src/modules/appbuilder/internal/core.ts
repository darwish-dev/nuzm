import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { UUID, isUuid } from '@nuzm/domain';
export { UUID, isUuid };

/** Shared building blocks of the app-builder module (M10A). Pure: no I/O. */
export type Row = Record<string, unknown>;
export const newId = (): string => uuidv7();
export const sha256 = (s: string | Uint8Array): string =>
  createHash('sha256').update(s).digest('hex');

/** Deterministic JSON: object keys sorted, no whitespace. Rejects values JSON cannot carry faithfully (undefined, NaN, Infinity, functions). */
export function canonicalJson(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x === 'string' || typeof x === 'boolean') return x;
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) throw new TypeError('canonicalJson: non-finite number');
      return x;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (typeof x === 'object' && x !== null) {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) {
        const val = (x as Record<string, unknown>)[k];
        if (val === undefined) continue;
        o[k] = walk(val);
      }
      return o;
    }
    throw new TypeError(`canonicalJson: unsupported value of type ${typeof x}`);
  };
  return JSON.stringify(walk(v));
}
export const hashOf = (v: unknown): string => sha256(canonicalJson(v));

/** Operation kinds (platform.operations.kind) of this module. */
export const OP = {
  SANDBOX_START: 'builder.sandbox.start',
  TEST_RUN: 'builder.test_run.execute',
  EXPORT_BUILD: 'builder.export.build',
  DEPLOY: 'builder.deployment.execute',
  ROLLBACK: 'builder.deployment.rollback',
} as const;

/** The seven agents of the web-app graph (FR-APP-01) plus the debugging agent of the `test-fix` kind. */
export const AGENTS = [
  'requirements',
  'architecture',
  'database',
  'backend',
  'frontend',
  'qa',
  'devops',
  'test-fix',
] as const;
export type AgentId = (typeof AGENTS)[number];

/** M10 §9: the human approval gates. Each is hash-bound to the exact action and expires after 24 h. */
export const APPROVAL_TYPES = [
  'production_deploy',
  'production_rollback',
  'data_migration_rollback',
  'destructive_migration',
  'paid_resource',
  'egress_or_dependency',
  'budget_increase',
  'export_third_party',
  'mobile_signing',
  'release_owner',
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_TTL_HOURS = 24;

/** Budget caps of M10 §9 (proposals; D-18/D-23 OPEN). Overridable per run request, never above these ceilings. */
export const RUN_CEILINGS = {
  maxTokens: 2_000_000,
  maxMinutes: 60,
  maxSteps: 200,
  warnAtPct: 80,
} as const;

/** M10 §9 sandbox quotas (proposals; tune after D-21). */
export const SANDBOX_QUOTA = {
  vcpu: 2,
  memoryMb: 4096,
  diskGb: 10,
  pids: 512,
  concurrentPerOrg: 5,
  idleTimeoutMinutes: 30,
  maxLifetimeMinutes: 240,
  buildTimeoutMinutes: 20,
} as const;

export const nowIso = (d = new Date()): string => d.toISOString();
export const iso = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);
