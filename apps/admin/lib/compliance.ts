/** Pure helpers of the admin compliance screens (UI-M04-07, -09, -10, -13, -14). No I/O: unit-tested in `compliance.spec.ts`. */
import { isUuid } from './finance';

type Tone = 'success' | 'danger' | 'warn' | undefined;

export const BREACH_FLOW = [
  'detected',
  'triaged',
  'assessed',
  'notification_decision',
  'notified',
  'remediation',
  'closed',
] as const;
export type BreachState = (typeof BREACH_FLOW)[number];

/** The states a case in `state` may move to (the API enforces it too). After the decision only the branch that was decided is offered. */
export function nextBreachStates(
  state: string,
  decision: { notify?: boolean } | null | undefined,
): BreachState[] {
  switch (state) {
    case 'detected':
      return ['triaged'];
    case 'triaged':
      return ['assessed'];
    case 'assessed':
      return ['notification_decision'];
    case 'notification_decision':
      return decision?.notify === true
        ? ['notified']
        : decision?.notify === false
          ? ['remediation']
          : [];
    case 'notified':
      return ['remediation'];
    case 'remediation':
      return ['closed'];
    default:
      return [];
  }
}

/** "a, b ,, c" → ["a","b","c"]; duplicates dropped. */
export function splitList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

export interface BreachFields {
  note: string;
  personalData: 'yes' | 'no';
  scope: string;
  classes: string;
  regions: string;
  orgIds: string;
  tables: string;
  notify: 'yes' | 'no';
  rationale: string;
  recipients: string;
  notifiedAt: string; // a datetime-local value
  reference: string;
  severity: string;
}

/** Local `YYYY-MM-DDTHH:mm` (from a datetime-local input) → ISO UTC, or null. */
export function localToIso(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The body of a move to `to`: what the API wants for each step, checked here only to save a round trip (the API is the authority).
 * Returns `{ error: field }` naming the first problem.
 */
export function breachMoveBody(
  to: BreachState,
  f: BreachFields,
): { data?: Record<string, unknown>; note?: string; error?: string } {
  const note = f.note.trim();
  if (to === 'triaged')
    return { data: f.severity ? { severity: f.severity } : {}, ...(note ? { note } : {}) };
  if (to === 'assessed') {
    const classes = splitList(f.classes);
    const orgIds = splitList(f.orgIds);
    if (f.scope.trim().length < 10) return { error: 'scope' };
    if (f.personalData === 'yes' && classes.length === 0) return { error: 'classes' };
    if (orgIds.some((x) => !isUuid(x))) return { error: 'orgIds' };
    return {
      data: {
        personalDataAffected: f.personalData === 'yes',
        scope: f.scope.trim(),
        dataClasses: classes,
        regions: splitList(f.regions),
        orgIds,
        tables: splitList(f.tables),
      },
      ...(note ? { note } : {}),
    };
  }
  if (to === 'notification_decision') {
    const recipients = splitList(f.recipients);
    if (f.rationale.trim().length < 10) return { error: 'rationale' };
    if (f.notify === 'yes' && recipients.length === 0) return { error: 'recipients' };
    return {
      data: { notify: f.notify === 'yes', rationale: f.rationale.trim(), recipients },
      ...(note ? { note } : {}),
    };
  }
  if (to === 'notified') {
    const at = localToIso(f.notifiedAt);
    if (!at) return { error: 'notifiedAt' };
    if (f.reference.trim().length < 3) return { error: 'reference' };
    return { data: { notifiedAt: at, reference: f.reference.trim() }, ...(note ? { note } : {}) };
  }
  if (note === '') return { error: 'note' }; // remediation and closed need a note
  return { note };
}

export const controlTone = (status: string): Tone =>
  status === 'reviewed' ? 'success' : status === 'not_mapped' ? 'warn' : undefined;
export const severityTone = (s: string): Tone =>
  s === 'critical' || s === 'high' ? 'danger' : s === 'medium' ? 'warn' : undefined;
export const validationTone = (s: string): Tone =>
  s === 'validated' ? 'success' : s === 'rejected' ? 'danger' : s === 'open' ? 'warn' : undefined;

/** First 12 hex characters of a hash: enough to compare by eye, the full value is in the title. */
export const shortHash = (h: string) => h.slice(0, 12);
