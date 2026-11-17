import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

/** docs/10 §6: detected -> triaged -> assessed -> notification_decision (human) -> notified -> remediation -> closed. */
export const BREACH_STATES = [
  'detected',
  'triaged',
  'assessed',
  'notification_decision',
  'notified',
  'remediation',
  'closed',
] as const;
export type BreachState = (typeof BREACH_STATES)[number];
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Allowed edges. `notification_decision -> remediation` is only for a recorded decision NOT to notify; `-> notified` only for one to notify (checked with the data). */
export const EDGES: Record<BreachState, readonly BreachState[]> = {
  detected: ['triaged'],
  triaged: ['assessed'],
  assessed: ['notification_decision'],
  notification_decision: ['notified', 'remediation'],
  notified: ['remediation'],
  remediation: ['closed'],
  closed: [],
};
export const canMove = (from: BreachState, to: BreachState) => EDGES[from].includes(to);

export interface BreachConfig {
  triageHours: number;
  assessHours: number;
  decisionHours: number;
  /** How far before detection the evidence pack looks at the audit trail. */
  evidenceLookbackHours: number;
}
export function parseBreachConfig(text: string): BreachConfig {
  const b = (parse(text) as { breach?: Record<string, unknown> } | null)?.breach;
  const fail = (m: string): never => {
    throw new Error(`breach config: ${m}`);
  };
  if (!b) return fail('the breach section is required');
  const int = (k: string, lo: number, hi: number, def?: number) => {
    const v = b[k] ?? def;
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi)
      fail(`${k} must be ${lo}..${hi}`);
    return v as number;
  };
  const triageHours = int('triage_hours', 1, 720);
  const assessHours = int('assess_hours', 1, 720);
  const decisionHours = int('decision_hours', 1, 720);
  if (!(triageHours <= assessHours && assessHours <= decisionHours))
    fail('triage_hours <= assess_hours <= decision_hours is required');
  return {
    triageHours,
    assessHours,
    decisionHours,
    evidenceLookbackHours: int('evidence_lookback_hours', 0, 720, 24),
  };
}
export function loadBreachConfig(path = process.env.COMPLIANCE_DEFAULTS_PATH): BreachConfig {
  if (path) return parseBreachConfig(readFileSync(resolve(path), 'utf8'));
  for (let d = __dirname, i = 0; i < 14; i++, d = dirname(d)) {
    const f = join(d, 'spec/compliance/defaults.yaml');
    if (existsSync(f)) return parseBreachConfig(readFileSync(f, 'utf8'));
  }
  throw new Error('breach config: spec/compliance/defaults.yaml not found');
}

export interface BreachTimers {
  triageDueAt: string;
  assessDueAt: string;
  decisionDueAt: string;
  /** The deadline of the step the case is waiting for, and whether it has passed; null once the decision is recorded. */
  current: { step: 'triage' | 'assess' | 'decision'; dueAt: string; overdue: boolean } | null;
}
/** Timers count from detection. They are PLACEHOLDERS: statutory deadlines are human-defined (HG-04-01); the system only shows them, it notifies nobody. */
export function timersFor(
  detectedAt: Date,
  state: BreachState,
  cfg: BreachConfig,
  now: Date,
): BreachTimers {
  const at = (h: number) => new Date(detectedAt.getTime() + h * 3_600_000);
  const t = {
    triageDueAt: at(cfg.triageHours).toISOString(),
    assessDueAt: at(cfg.assessHours).toISOString(),
    decisionDueAt: at(cfg.decisionHours).toISOString(),
  };
  const step =
    state === 'detected'
      ? ('triage' as const)
      : state === 'triaged'
        ? ('assess' as const)
        : state === 'assessed'
          ? ('decision' as const)
          : null;
  const dueAt =
    step === 'triage' ? t.triageDueAt : step === 'assess' ? t.assessDueAt : t.decisionDueAt;
  return {
    ...t,
    current: step ? { step, dueAt, overdue: now.getTime() >= Date.parse(dueAt) } : null,
  };
}
