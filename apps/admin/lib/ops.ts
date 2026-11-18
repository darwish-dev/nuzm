/**
 * Pure helpers of the admin M12 screens (UI-M12-04..14): operations health, incidents, alerts, recovery exercises, access reviews, policy
 * versions and audit retention. No I/O: unit-tested in `ops.spec.ts`. The API is the authority on every rule; the checks here only save a round trip.
 * Several response members are loosely typed in the SDK (`{ [key: string]: unknown }`): the readers below narrow them defensively and never invent fields.
 */
import type { Schemas } from '@nuzm/sdk';
import { localToIso, splitList } from './compliance';
import { isUuid } from './finance';

export type Tone = 'success' | 'danger' | 'warn' | undefined;

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---- incidents (UI-M12-05, -06) -----------------------------------------------------------------------------------------------

export const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
export type IncidentSeverity = (typeof SEVERITIES)[number];
export const INCIDENT_STATUSES = [
  'open',
  'investigating',
  'identified',
  'monitoring',
  'resolved',
  'closed',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Forward progress, plus reopening a resolved incident; `closed` is terminal (the API enforces it too: 409 invalid_state). */
const NEXT: Record<IncidentStatus, IncidentStatus[]> = {
  open: ['investigating', 'identified', 'monitoring', 'resolved'],
  investigating: ['identified', 'monitoring', 'resolved'],
  identified: ['monitoring', 'resolved'],
  monitoring: ['resolved', 'investigating'],
  resolved: ['closed', 'investigating'],
  closed: [],
};
export const nextIncidentStatuses = (s: string): IncidentStatus[] =>
  (NEXT as Record<string, IncidentStatus[]>)[s] ?? [];

export const incidentSeverityTone = (s: string): Tone =>
  s === 'SEV1' ? 'danger' : s === 'SEV2' ? 'warn' : undefined;
export const incidentStatusTone = (s: string): Tone =>
  s === 'resolved' || s === 'closed' ? 'success' : s === 'open' ? 'warn' : undefined;

export interface TimelineEntry {
  id: string;
  kind: string;
  body: string | null;
  statusTo: string | null;
  severityTo: string | null;
  author: string;
  at: string;
}
/** The incident's timeline (latest 50 updates, newest first as the API returns them). Entries without an id or timestamp are dropped. */
export function readTimeline(raw: unknown): TimelineEntry[] {
  return list(raw).flatMap((x) => {
    const e = rec(x);
    const id = str(e.id);
    const at = str(e.at);
    const kind = str(e.kind);
    if (!id || !at || !kind) return [];
    return [
      {
        id,
        kind,
        body: str(e.body),
        statusTo: str(e.statusTo),
        severityTo: str(e.severityTo),
        author: str(e.author) ?? '',
        at,
      },
    ];
  });
}

/** Component keys as the API validates them: lowercase, 2 to 61 characters of a-z 0-9 . _ : - */
export const COMPONENT_KEY = /^[a-z][a-z0-9_.:-]{1,60}$/;

export interface IncidentFields {
  severity: string;
  title: string;
  summary: string;
  components: string;
  breachCaseId: string;
}
export function openIncidentBody(f: IncidentFields): {
  body?: Schemas['IncidentCreate'];
  error?: string;
} {
  const title = f.title.trim();
  const summary = f.summary.trim();
  const components = splitList(f.components);
  const breach = f.breachCaseId.trim();
  if (!(SEVERITIES as readonly string[]).includes(f.severity)) return { error: 'severity' };
  if (title.length < 3 || title.length > 200) return { error: 'title' };
  if (summary.length > 2000) return { error: 'summary' };
  if (components.length > 30 || components.some((c) => !COMPONENT_KEY.test(c)))
    return { error: 'components' };
  if (breach && !isUuid(breach)) return { error: 'breachCaseId' };
  return {
    body: {
      severity: f.severity as IncidentSeverity,
      title,
      ...(summary ? { summary } : {}),
      ...(components.length ? { components } : {}),
      ...(breach ? { breachCaseId: breach } : {}),
    },
  };
}

export interface IncidentUpdateFields {
  status: string; // '' = unchanged
  severity: string; // '' = unchanged
  note: string;
  commsDraft: string;
  breachCaseId: string;
}
/** Only what changed is sent (every change adds a timeline entry). `{ error: 'nothing' }` when nothing was entered. */
export function updateIncidentBody(
  current: { status: string; severity: string; breachCaseId: string | null },
  f: IncidentUpdateFields,
): { body?: Schemas['IncidentUpdate']; error?: string } {
  const note = f.note.trim();
  const comms = f.commsDraft.trim();
  const breach = f.breachCaseId.trim();
  const body: Schemas['IncidentUpdate'] = {};
  if (f.status && f.status !== current.status) {
    if (!(INCIDENT_STATUSES as readonly string[]).includes(f.status)) return { error: 'status' };
    body.status = f.status as IncidentStatus;
  }
  if (f.severity && f.severity !== current.severity) {
    if (!(SEVERITIES as readonly string[]).includes(f.severity)) return { error: 'severity' };
    body.severity = f.severity as IncidentSeverity;
  }
  if (note) {
    if (note.length > 4000) return { error: 'note' };
    body.note = note;
  }
  if (comms) {
    if (comms.length > 4000) return { error: 'commsDraft' };
    body.commsDraft = comms;
  }
  if (breach && breach !== current.breachCaseId) {
    if (!isUuid(breach)) return { error: 'breachCaseId' };
    body.breachCaseId = breach;
  }
  return Object.keys(body).length === 0 ? { error: 'nothing' } : { body };
}

// ---- alerts (UI-M12-07) -------------------------------------------------------------------------------------------------------

export const ALERT_STATES = ['ok', 'firing', 'acknowledged', 'silenced'] as const;
export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const ALERT_OPS = ['>', '>=', '<', '<=', '=='] as const;
export const alertStateTone = (s: string): Tone =>
  s === 'firing' ? 'danger' : s === 'ok' ? 'success' : s === 'acknowledged' ? 'warn' : undefined;
export const alertSeverityTone = (s: string): Tone =>
  s === 'critical' ? 'danger' : s === 'warning' ? 'warn' : undefined;

/** "metric op threshold" of a rule, or null when the stored rule is not in that shape. */
export function readRule(raw: unknown): { metric: string; op: string; threshold: number } | null {
  const r = rec(raw);
  const metric = str(r.metric);
  const op = str(r.op);
  const threshold = num(r.threshold);
  return metric && op && threshold !== null ? { metric, op, threshold } : null;
}

export interface SilenceCheck {
  until?: string;
  error?: 'until';
}
/** A silence needs an expiry between now and 30 days ahead (the API enforces it too). `until` is a datetime-local value. */
export function silenceUntil(value: string, now = Date.now()): SilenceCheck {
  const iso = localToIso(value);
  if (!iso) return { error: 'until' };
  const at = Date.parse(iso);
  return at > now && at <= now + 30 * 86_400_000 ? { until: iso } : { error: 'until' };
}

export interface AlertDefineFields {
  ruleKey: string;
  title: string;
  severity: string;
  ownerRole: string;
  runbookUrl: string;
  metric: string;
  op: string;
  threshold: string;
}
export function defineAlertBody(f: AlertDefineFields): {
  body?: Schemas['AlertAction'];
  error?: string;
} {
  const threshold = f.threshold.trim() === '' ? NaN : Number(f.threshold);
  if (!/^[a-z][a-z0-9_.-]{2,80}$/.test(f.ruleKey.trim())) return { error: 'ruleKey' };
  if (f.title.trim().length < 3 || f.title.trim().length > 200) return { error: 'title' };
  if (!(ALERT_SEVERITIES as readonly string[]).includes(f.severity)) return { error: 'severity' };
  if (!/^[a-z][a-z_]{2,40}$/.test(f.ownerRole.trim())) return { error: 'ownerRole' };
  if (!/^(docs\/runbooks\/[a-z0-9._-]+\.md|https:\/\/\S+)$/.test(f.runbookUrl.trim()))
    return { error: 'runbookUrl' };
  if (f.metric.trim().length === 0 || f.metric.trim().length > 120) return { error: 'metric' };
  if (!(ALERT_OPS as readonly string[]).includes(f.op)) return { error: 'op' };
  if (!Number.isFinite(threshold)) return { error: 'threshold' };
  return {
    body: {
      action: 'define',
      ruleKey: f.ruleKey.trim(),
      title: f.title.trim(),
      severity: f.severity as (typeof ALERT_SEVERITIES)[number],
      ownerRole: f.ownerRole.trim(),
      runbookUrl: f.runbookUrl.trim(),
      rule: { metric: f.metric.trim(), op: f.op, threshold },
    },
  };
}

// ---- recovery exercises (UI-M12-09) -------------------------------------------------------------------------------------------

export const EXERCISE_SCOPES = [
  'control_plane_db',
  'object_storage',
  'hosting_site',
  'managed_db',
  'secrets_kms',
  'regional_loss_tabletop',
] as const;
export const EXERCISE_ENVIRONMENTS = ['local', 'staging', 'production'] as const;

/**
 * The measured RTO: whole seconds between the two datetime-local values, computed here and never typed. `error` names why there is none
 * (a missing value, a restore before the start, or a restore in the future).
 */
export function measuredRto(
  startedAt: string,
  restoredAt: string,
  now = Date.now(),
):
  | { seconds: number; startedIso: string; restoredIso: string }
  | { error: 'startedAt' | 'restoredAt' } {
  const s = localToIso(startedAt);
  if (!s) return { error: 'startedAt' };
  const r = localToIso(restoredAt);
  if (!r) return { error: 'restoredAt' };
  const ms = Date.parse(r) - Date.parse(s);
  if (ms < 0 || Date.parse(r) > now + 60_000) return { error: 'restoredAt' };
  return { seconds: Math.round(ms / 1000), startedIso: s, restoredIso: r };
}

/** `HH:MM:SS` (hours may exceed two digits). */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** Evidence references: one per line or comma-separated; duplicates dropped. */
export function splitRefs(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

export interface ExerciseFields {
  scope: string;
  environment: string;
  startedAt: string;
  restoredAt: string;
  rpoSeconds: string;
  evidence: string;
  notes: string;
}
export function recoveryExerciseBody(f: ExerciseFields): {
  body?: Schemas['RecoveryExerciseCreate'];
  error?: string;
} {
  if (!(EXERCISE_SCOPES as readonly string[]).includes(f.scope)) return { error: 'scope' };
  if (!(EXERCISE_ENVIRONMENTS as readonly string[]).includes(f.environment))
    return { error: 'environment' };
  const rto = measuredRto(f.startedAt, f.restoredAt);
  if ('error' in rto) return { error: rto.error };
  if (!/^\d{1,9}$/.test(f.rpoSeconds.trim())) return { error: 'rpoSeconds' };
  const evidence = splitRefs(f.evidence);
  if (
    evidence.length < 1 ||
    evidence.length > 20 ||
    evidence.some((e) => e.length < 3 || e.length > 300)
  )
    return { error: 'evidence' };
  const notes = f.notes.trim();
  if (notes.length > 2000) return { error: 'notes' };
  return {
    body: {
      scope: f.scope as (typeof EXERCISE_SCOPES)[number],
      environment: f.environment as (typeof EXERCISE_ENVIRONMENTS)[number],
      startedAt: rto.startedIso,
      restoredAt: rto.restoredIso,
      rpoSeconds: Number(f.rpoSeconds.trim()),
      rtoSeconds: rto.seconds, // measured from the two timestamps, never an estimate
      evidenceRefs: evidence,
      ...(notes ? { notes } : {}),
    },
  };
}

// ---- operations health (UI-M12-04) --------------------------------------------------------------------------------------------

export interface HealthComponent {
  key: string;
  status: string;
  detail: [string, string][];
}
export interface HealthSlo {
  sloKey: string;
  objective: number | null;
  unit: string;
  measured: number | null;
  status: string;
}
export interface HealthProbe {
  key: string;
  ok: boolean;
  mode: string;
  ranAt: string | null;
}
export interface HealthView {
  status: string;
  generatedAt: string | null;
  components: HealthComponent[];
  outboxLagSeconds: number | null;
  operationsByState: [string, number][];
  financialLastRunAt: string | null;
  technicalLastRunAt: string | null;
  openFinancialBreaks: number | null;
  openProviderIncidents: number | null;
  probes: HealthProbe[];
  sloBurn: HealthSlo[];
  alerts: { firing: number | null; acknowledged: number | null; silenced: number | null };
}

/** Anything the API did not report stays null / `unknown`: a missing measurement is never shown as healthy. */
export function readHealth(h: Schemas['OpsHealth']): HealthView {
  const queues = rec(h.queues);
  const rc = rec(h.reconcilers);
  const al = rec(h.alerts);
  return {
    status: h.status,
    generatedAt: str(h.generatedAt),
    components: h.components.flatMap((x) => {
      const c = rec(x);
      const key = str(c.key);
      if (!key) return [];
      return [
        {
          key,
          status: str(c.status) ?? 'unknown',
          detail: Object.entries(rec(c.detail)).map(([k, v]): [string, string] => [
            k,
            v === null || v === undefined ? '—' : String(v),
          ]),
        },
      ];
    }),
    outboxLagSeconds: num(queues.outboxLagSeconds),
    operationsByState: Object.entries(rec(queues.operationsByState)).flatMap(([k, v]) =>
      num(v) === null ? [] : [[k, num(v)!] as [string, number]],
    ),
    financialLastRunAt: str(rc.financialLastRunAt),
    technicalLastRunAt: str(rc.technicalLastRunAt),
    openFinancialBreaks: num(rc.openFinancialBreaks),
    openProviderIncidents: num(rec(h.providers).openIncidents),
    probes: (h.probes ?? []).flatMap((x) => {
      const p = rec(x);
      const key = str(p.key);
      const ok = bool(p.ok);
      return key && ok !== null ? [{ key, ok, mode: str(p.mode) ?? '', ranAt: str(p.ranAt) }] : [];
    }),
    sloBurn: (h.sloBurn ?? []).flatMap((x) => {
      const s = rec(x);
      const sloKey = str(s.sloKey);
      return sloKey
        ? [
            {
              sloKey,
              objective: num(s.objective),
              unit: str(s.unit) ?? '',
              measured: num(s.measured),
              status: str(s.status) ?? 'not_measured',
            },
          ]
        : [];
    }),
    alerts: {
      firing: num(al.firing),
      acknowledged: num(al.acknowledged),
      silenced: num(al.silenced),
    },
  };
}

export const healthTone = (s: string): Tone =>
  s === 'ok' || s === 'within'
    ? 'success'
    : s === 'down' || s === 'burning'
      ? 'danger'
      : s === 'degraded'
        ? 'warn'
        : undefined;

// ---- access reviews (UI-M12-10, -11) ------------------------------------------------------------------------------------------

export interface ReviewItem {
  itemId: string;
  userId: string;
  email: string;
  role: string;
  decision: 'keep' | 'revoke' | null;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}
/** The members snapshotted into a campaign, with their decisions (SCR-M12-04: there is no separate item endpoint; the campaign payload carries them). */
export function readReviewItems(raw: unknown): ReviewItem[] {
  return list(raw).flatMap((x) => {
    const i = rec(x);
    const itemId = str(i.itemId);
    if (!itemId) return [];
    const d = str(i.decision);
    return [
      {
        itemId,
        userId: str(i.userId) ?? '',
        email: str(i.email) ?? '',
        role: str(i.role) ?? '',
        decision: d === 'keep' || d === 'revoke' ? d : null,
        reason: str(i.reason),
        decidedBy: str(i.decidedBy),
        decidedAt: str(i.decidedAt),
      },
    ];
  });
}
export function reviewProgress(r: { items: unknown[]; progress?: unknown }): {
  total: number;
  decided: number;
} {
  const p = rec(r.progress);
  const items = readReviewItems(r.items);
  return {
    total: num(p.total) ?? items.length,
    decided: num(p.decided) ?? items.filter((i) => i.decision).length,
  };
}

export interface ReviewFields {
  orgId: string;
  reviewers: string;
  dueAt: string;
}
export function createReviewBody(
  f: ReviewFields,
  now = Date.now(),
): { body?: Schemas['AccessReviewCreate']; error?: string } {
  const reviewers = splitList(f.reviewers);
  const due = localToIso(f.dueAt);
  if (!isUuid(f.orgId.trim())) return { error: 'orgId' };
  if (reviewers.length < 1 || reviewers.length > 20 || reviewers.some((r) => !isUuid(r)))
    return { error: 'reviewers' };
  if (!due || Date.parse(due) <= now) return { error: 'dueAt' };
  return {
    body: { scope: { orgId: f.orgId.trim(), kinds: ['members'] }, reviewers, dueAt: due },
  };
}

export function decisionBody(
  itemId: string,
  decision: 'keep' | 'revoke',
  reason: string,
): { body?: Schemas['AccessReviewDecision']; error?: string } {
  if (reason.trim().length < 3 || reason.trim().length > 1000) return { error: 'reason' };
  return { body: { itemId, decision, reason: reason.trim() } };
}

// ---- policy versions (UI-M12-12) ----------------------------------------------------------------------------------------------

export interface PolicyFields {
  policyKey: string;
  title: string;
  bodyRef: string;
  effectiveFrom: string;
  approvedBy: string;
  approvalRef: string;
  changeNote: string;
}
/** An approver needs the approval reference (and the reverse); neither means a DRAFT. This screen never approves on anyone's behalf. */
export function publishPolicyBody(f: PolicyFields): {
  body?: Schemas['PolicyVersionPublish'];
  error?: string;
} {
  const approver = f.approvedBy.trim();
  const ref = f.approvalRef.trim();
  const note = f.changeNote.trim();
  if (!/^[a-z][a-z0-9_-]{2,40}$/.test(f.policyKey.trim())) return { error: 'policyKey' };
  if (f.title.trim().length < 3 || f.title.trim().length > 200) return { error: 'title' };
  if (f.bodyRef.trim().length < 3 || f.bodyRef.trim().length > 300) return { error: 'bodyRef' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.effectiveFrom) || Number.isNaN(Date.parse(f.effectiveFrom)))
    return { error: 'effectiveFrom' };
  if (approver && !isUuid(approver)) return { error: 'approvedBy' };
  if (Boolean(approver) !== Boolean(ref) || (ref && (ref.length < 3 || ref.length > 300)))
    return { error: 'approvalRef' };
  return {
    body: {
      policyKey: f.policyKey.trim(),
      title: f.title.trim(),
      bodyRef: f.bodyRef.trim(),
      effectiveFrom: f.effectiveFrom,
      ...(approver ? { approvedBy: approver, approvalRef: ref } : {}),
      ...(note ? { changeNote: note } : {}),
    },
  };
}

// ---- audit retention (UI-M12-14) ----------------------------------------------------------------------------------------------

export interface RetentionPolicyRow {
  id: string;
  dataClass: string;
  version: number;
  retainDays: number;
  archiveAfterDays: number;
  basis: string;
  status: string;
  documentRef: string | null;
}
export function readRetentionPolicies(raw: unknown): RetentionPolicyRow[] {
  return list(raw).flatMap((x) => {
    const p = rec(x);
    const id = str(p.id);
    const dataClass = str(p.dataClass);
    const retain = num(p.retainDays);
    const archive = num(p.archiveAfterDays);
    if (!id || !dataClass || retain === null || archive === null) return [];
    return [
      {
        id,
        dataClass,
        version: num(p.version) ?? 0,
        retainDays: retain,
        archiveAfterDays: archive,
        basis: str(p.basis) ?? '',
        status: str(p.status) ?? '',
        documentRef: str(p.documentRef),
      },
    ];
  });
}
export interface LegalHoldRow {
  id: string;
  orgId: string | null;
  dataset: string | null;
  status: string;
}
export function readLegalHolds(raw: unknown): LegalHoldRow[] {
  return list(raw).flatMap((x) => {
    const h = rec(x);
    const id = str(h.id);
    return id
      ? [{ id, orgId: str(h.orgId), dataset: str(h.dataset), status: str(h.status) ?? '' }]
      : [];
  });
}
export interface DryRun {
  archiveCutoff: string | null;
  expiryCutoff: string | null;
  archiveCandidates: number | null;
  expiryCandidates: number | null;
  heldCandidates: number | null;
  eligibleToArchive: number | null;
}
/** The dry-run of what a policy WOULD archive minus anything under a legal hold. Null when the API sent none. Nothing is archived or deleted. */
export function readDryRun(raw: unknown): DryRun | null {
  if (raw === null || raw === undefined) return null;
  const p = rec(raw);
  return {
    archiveCutoff: str(p.archiveCutoff),
    expiryCutoff: str(p.expiryCutoff),
    archiveCandidates: num(p.archiveCandidates),
    expiryCandidates: num(p.expiryCandidates),
    heldCandidates: num(p.heldCandidates),
    eligibleToArchive: num(p.eligibleToArchive),
  };
}

export interface RetentionFields {
  dataClass: string;
  retainDays: string;
  archiveAfterDays: string;
  basis: string;
  status: string;
  documentRef: string;
  changeNote: string;
}
export function putRetentionBody(
  f: RetentionFields,
  minimumDays: number | null,
  currentVersion: number | null,
): { body?: Schemas['AuditRetentionPut']; error?: string } {
  const days = (v: string) => (/^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : NaN);
  const retain = days(f.retainDays);
  const archive = days(f.archiveAfterDays);
  const doc = f.documentRef.trim();
  const note = f.changeNote.trim();
  if (!/^[a-z][a-z-]{2,30}$/.test(f.dataClass.trim())) return { error: 'dataClass' };
  if (!Number.isInteger(retain) || retain < 1 || retain > 36_500) return { error: 'retainDays' };
  if (minimumDays !== null && retain < minimumDays) return { error: 'minimum' };
  if (!Number.isInteger(archive) || archive < 1 || archive > retain)
    return { error: 'archiveAfterDays' };
  if (f.basis.trim().length < 3 || f.basis.trim().length > 500) return { error: 'basis' };
  if (f.status !== 'proposal' && f.status !== 'approved') return { error: 'status' };
  if (doc.length > 200) return { error: 'documentRef' };
  if (f.status === 'approved' && doc.length < 3) return { error: 'documentRef' };
  if (note.length > 500) return { error: 'changeNote' };
  return {
    body: {
      dataClass: f.dataClass.trim(),
      retainDays: retain,
      archiveAfterDays: archive,
      basis: f.basis.trim(),
      status: f.status,
      ...(doc ? { documentRef: doc } : {}),
      ...(note ? { changeNote: note } : {}),
      ...(currentVersion !== null ? { baseVersion: currentVersion } : {}),
    },
  };
}

/** First 8 characters of an id: enough to tell rows apart; the full value is in the title attribute where shown. */
export const shortId = (id: string) => id.slice(0, 8);
