import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

export const DSR_TYPES = ['access', 'correction', 'deletion', 'portability'] as const;
export type DsrType = (typeof DSR_TYPES)[number];
export const DSR_STATUSES = [
  'received',
  'identity_verified',
  'in_progress',
  'fulfilled',
  'rejected',
  'partially_fulfilled',
] as const;
export type DsrStatus = (typeof DSR_STATUSES)[number];
export const TERMINAL: readonly DsrStatus[] = ['fulfilled', 'rejected', 'partially_fulfilled'];
export const isTerminal = (s: DsrStatus) => TERMINAL.includes(s);

/** received -> identity_verified -> in_progress -> fulfilled | rejected | partially_fulfilled (a request can also be rejected before it starts). */
export const TRANSITIONS: Record<DsrStatus, readonly DsrStatus[]> = {
  received: ['identity_verified', 'rejected'],
  identity_verified: ['in_progress', 'rejected'],
  in_progress: ['fulfilled', 'rejected', 'partially_fulfilled'],
  fulfilled: [],
  rejected: [],
  partially_fulfilled: [],
};
export const canTransition = (from: DsrStatus, to: DsrStatus) => TRANSITIONS[from].includes(to);

export type HandlerAction = 'export' | 'erase' | 'rectify';
export const ACTION_OF: Record<DsrType, HandlerAction> = {
  access: 'export',
  portability: 'export',
  deletion: 'erase',
  correction: 'rectify',
};

/** The catalogue of rejection and refusal reasons (docs/10 §4; M04 §4 task 10). Codes are stable; wording is for people, in both languages. */
export const REASONS = {
  identity_unverified: {
    ar: 'لم يتم التحقق من هوية صاحب الطلب.',
    en: 'The identity of the person making the request was not verified.',
  },
  legal_hold_active: {
    ar: 'البيانات مشمولة بحجز قانوني ولا يمكن حذفها الآن.',
    en: 'The data is under a legal hold and cannot be erased now.',
  },
  retention_mandatory: {
    ar: 'يلزم الاحتفاظ بهذه السجلات بموجب التزام نظامي أو محاسبي.',
    en: 'These records must be kept under a legal or accounting obligation.',
  },
  account_is_global: {
    ar: 'الحساب مشترك بين عدة مؤسسات؛ إغلاقه يتم بطلب إغلاق الحساب لا من داخل مؤسسة.',
    en: 'The account is shared across organizations; closing it is a separate account-closure step, not an organization request.',
  },
  last_owner: {
    ar: 'لا يمكن إزالة المالك الوحيد للمؤسسة.',
    en: 'The only owner of an organization cannot be removed.',
  },
  unsupported: {
    ar: 'هذا النوع من الطلبات غير مدعوم لهذه البيانات.',
    en: 'This kind of request is not supported for this data.',
  },
  not_applicable: {
    ar: 'لا توجد بيانات من هذا النوع عن صاحب الطلب.',
    en: 'There is no data of this kind about the subject.',
  },
  processing_failed: {
    ar: 'تعذّرت المعالجة الآلية ويلزم تدخل بشري.',
    en: 'Automatic processing failed and needs a person.',
  },
} as const;
export type ReasonCode = keyof typeof REASONS;
export const REASON_PRIORITY: ReasonCode[] = [
  'legal_hold_active',
  'retention_mandatory',
  'account_is_global',
  'last_owner',
  'unsupported',
  'processing_failed',
  'identity_unverified',
  'not_applicable',
];

export type Subject =
  { kind: 'member'; userId: string } | { kind: 'org' } | { kind: 'opaque'; ref: string };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function parseSubject(ref: string): Subject {
  if (ref === 'org') return { kind: 'org' };
  const m = new RegExp(`^member:(${UUID})$`, 'i').exec(ref);
  return m ? { kind: 'member', userId: m[1]!.toLowerCase() } : { kind: 'opaque', ref };
}

export interface TaskOutcome {
  handler: string;
  action: HandlerAction;
  status: 'succeeded' | 'refused' | 'failed';
  reason: ReasonCode | null;
}
export interface Aggregate {
  status: 'fulfilled' | 'rejected' | 'partially_fulfilled';
  reasonCode: ReasonCode | null;
}
/**
 * The request's final state from its tasks: everything succeeded (including "nothing to do") = fulfilled; some succeeded and some refused or failed =
 * partially_fulfilled; nothing succeeded = rejected with the most specific reason (legal hold, then retention, …). A technical failure of every task is
 * `rejected` with `processing_failed`: it needs a person.
 */
export function aggregate(tasks: TaskOutcome[]): Aggregate {
  if (tasks.length === 0) return { status: 'rejected', reasonCode: 'not_applicable' };
  // "nothing of this kind about the subject" is neutral: it neither fulfils the request nor stands in its way
  const worked = tasks.filter(
    (t) => t.status === 'succeeded' && t.reason !== 'not_applicable',
  ).length;
  const stuck = tasks.filter((t) => t.status !== 'succeeded');
  if (stuck.length === 0) return { status: 'fulfilled', reasonCode: null };
  if (worked > 0) return { status: 'partially_fulfilled', reasonCode: null };
  const reasons = stuck.map((t) =>
    t.status === 'failed' ? ('processing_failed' as ReasonCode) : (t.reason ?? 'unsupported'),
  );
  const reason = REASON_PRIORITY.find((r) => reasons.includes(r)) ?? 'unsupported';
  return { status: 'rejected', reasonCode: reason };
}

export interface DsrConfig {
  fulfilDays: Record<DsrType, number>;
  warnAt: number;
  escalateAt: number;
  taskMaxAttempts: number;
  maxConcurrentExports: number;
  archiveTtlHours: number;
  linkTtlSeconds: number;
}
export function parseDsrConfig(text: string): DsrConfig {
  const raw = parse(text) as {
    dsr?: Record<string, unknown>;
    exports?: Record<string, unknown>;
  } | null;
  const fail = (m: string): never => {
    throw new Error(`dsr config: ${m}`);
  };
  const d = raw?.dsr;
  const e = raw?.exports;
  if (!d || !e) return fail('dsr and exports sections are required');
  const days = d.fulfil_days as Record<string, unknown> | undefined;
  for (const t of DSR_TYPES)
    if (!Number.isInteger(days?.[t]) || (days![t] as number) < 1 || (days![t] as number) > 365)
      fail(`fulfil_days.${t} must be 1..365`);
  const warn = d.warn_at;
  const esc = d.escalate_at;
  if (typeof warn !== 'number' || typeof esc !== 'number' || !(warn > 0 && warn < esc && esc < 1))
    fail('warn_at and escalate_at must satisfy 0 < warn_at < escalate_at < 1');
  const int = (v: unknown, k: string, lo: number, hi: number) => {
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi)
      fail(`${k} must be ${lo}..${hi}`);
    return v as number;
  };
  return {
    fulfilDays: Object.fromEntries(DSR_TYPES.map((t) => [t, days![t] as number])) as Record<
      DsrType,
      number
    >,
    warnAt: warn as number,
    escalateAt: esc as number,
    taskMaxAttempts: int(d.task_max_attempts, 'task_max_attempts', 1, 10),
    maxConcurrentExports: int(e.max_concurrent, 'exports.max_concurrent', 1, 100),
    archiveTtlHours: int(e.archive_ttl_hours, 'exports.archive_ttl_hours', 1, 720),
    linkTtlSeconds: int(e.link_ttl_seconds, 'exports.link_ttl_seconds', 30, 86_400),
  };
}
export function loadDsrConfig(path = process.env.COMPLIANCE_DEFAULTS_PATH): DsrConfig {
  if (path) return parseDsrConfig(readFileSync(resolve(path), 'utf8'));
  for (let d = __dirname, i = 0; i < 14; i++, d = dirname(d)) {
    const f = join(d, 'spec/compliance/defaults.yaml');
    if (existsSync(f)) return parseDsrConfig(readFileSync(f, 'utf8'));
  }
  throw new Error('dsr config: spec/compliance/defaults.yaml not found');
}

/** Where a request is on its clock: `ok` until warn_at of the time to the deadline, then `warning`, then `escalated` from escalate_at, `overdue` after the deadline. */
export function slaState(
  receivedAt: Date,
  dueAt: Date,
  now: Date,
  cfg: Pick<DsrConfig, 'warnAt' | 'escalateAt'>,
): 'ok' | 'warning' | 'escalated' | 'overdue' {
  const total = dueAt.getTime() - receivedAt.getTime();
  const used = now.getTime() - receivedAt.getTime();
  if (now.getTime() >= dueAt.getTime()) return 'overdue';
  if (used >= total * cfg.escalateAt) return 'escalated';
  if (used >= total * cfg.warnAt) return 'warning';
  return 'ok';
}
