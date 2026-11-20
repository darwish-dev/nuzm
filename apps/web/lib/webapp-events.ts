/**
 * Pure helpers of the web-app run timeline: the persisted events of a build as a short, readable list (what started, what finished and with how many tokens, files
 * committed, approvals, budget warnings, how it ended and why), the places each step's result can be opened (Code, Data, Spec, Tests, Deployments), and the "what
 * was produced" summary. No I/O: unit-tested in `webapp-events.spec.ts`. Every string from an event is masked with `safeText` (an event is data, never markup).
 */
import { safeText } from './appbuilder';
import type { SpecView } from './appworkspace';
import { num, str, type Message, type Run, type RunEvent } from './builder';
import { runFailure } from './mobile';
import type { AppTab } from './webapp-workspace';

/** Where a timeline entry or a produced item opens: a panel of the workspace and, for Data, which sub-view. */
export interface OpenTarget {
  tab: AppTab;
  /** the Data panel's view */
  view?: 'tables' | 'migrations' | 'api' | 'access';
  /** a file path to open in Code */
  path?: string;
}

export type TimelineTone = 'info' | 'ok' | 'warn' | 'danger' | 'wait';
export type TimelineIcon = 'sparkle' | 'check' | 'close' | 'code' | 'shield' | 'pulse' | 'refresh';

export interface TimelineItem {
  seq: number;
  at: string;
  tone: TimelineTone;
  icon: TimelineIcon;
  /** a `wsp.ev.*` message key and its params */
  key: string;
  params: Record<string, string | number>;
  /** the second line: tokens used, a failure's reasons ... (already masked) */
  detail?: { key: string; params: Record<string, string | number> };
  reasons?: string[];
  open?: OpenTarget;
}

/** What each agent's artifact opens: the panel where its result lives. */
export const ARTIFACT_OPENS: Record<string, OpenTarget> = {
  requirements: { tab: 'spec' },
  app_spec: { tab: 'spec' },
  db_schema: { tab: 'design', view: 'migrations' },
  api_contract: { tab: 'design', view: 'api' },
  frontend_bundle: { tab: 'code' },
  test_plan: { tab: 'tests' },
  deploy_plan: { tab: 'deployments' },
};

/** Events that are bookkeeping, not news: the timeline leaves them out. */
const QUIET = new Set([
  'checkpoint',
  'segment_started',
  'artifact',
  'step_started',
  'step_completed',
]);

const nodeId = (e: RunEvent): string => str(e.data.node) ?? str(e.data.agent) ?? '';

/** The persisted events of a run as timeline entries, oldest first. Unknown event types are kept (by their code) so nothing is hidden or invented. */
export function timelineOf(events: readonly RunEvent[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (QUIET.has(e.type)) continue;
    const base = { seq: e.seq, at: e.at };
    const agent = nodeId(e);
    switch (e.type) {
      case 'created':
        out.push({ ...base, tone: 'info', icon: 'sparkle', key: 'wsp.ev.created', params: {} });
        break;
      case 'node_started':
        out.push({
          ...base,
          tone: 'info',
          icon: 'pulse',
          key: 'wsp.ev.nodeStarted',
          params: { agent },
          ...(num(e.data.attempt, 1) > 1
            ? { detail: { key: 'wsp.ev.attempt', params: { n: num(e.data.attempt, 1) } } }
            : {}),
        });
        break;
      case 'node_succeeded': {
        const tokens = num(e.data.tokensIn) + num(e.data.tokensOut);
        const artifact = str(e.data.artifact) ?? '';
        out.push({
          ...base,
          tone: 'ok',
          icon: 'check',
          key: e.data.approved === true ? 'wsp.ev.nodeApproved' : 'wsp.ev.nodeDone',
          params: { agent },
          ...(tokens > 0 ? { detail: { key: 'wsp.ev.tokens', params: { n: tokens } } } : {}),
          ...(ARTIFACT_OPENS[artifact] ? { open: ARTIFACT_OPENS[artifact] } : {}),
        });
        break;
      }
      case 'node_failed': {
        const reason = safeText(e.data.reason, 80);
        out.push({
          ...base,
          tone: 'danger',
          icon: 'close',
          key: 'wsp.ev.nodeFailed',
          params: { agent },
          ...(reason ? { detail: { key: 'wsp.ev.reason', params: { reason } } } : {}),
        });
        break;
      }
      case 'approval_requested': {
        const kinds = Array.isArray(e.data.types)
          ? e.data.types
              .filter((x): x is string => typeof x === 'string')
              .map((x) => safeText(x, 40))
          : [safeText(e.data.kind, 40)].filter(Boolean);
        out.push({
          ...base,
          tone: 'wait',
          icon: 'shield',
          key: 'wsp.ev.approvalAsked',
          params: { kinds: kinds.join(', '), agent },
        });
        break;
      }
      case 'approval_approve':
      case 'approval_approved':
        out.push({
          ...base,
          tone: 'ok',
          icon: 'shield',
          key: 'wsp.ev.approvalYes',
          params: { kind: safeText(e.data.kind, 40) },
        });
        break;
      case 'approval_deny':
      case 'approval_denied':
        out.push({
          ...base,
          tone: 'danger',
          icon: 'shield',
          key: 'wsp.ev.approvalNo',
          params: { kind: safeText(e.data.kind, 40) },
        });
        break;
      case 'approval_expired':
        out.push({
          ...base,
          tone: 'warn',
          icon: 'shield',
          key: 'wsp.ev.approvalExpired',
          params: {},
        });
        break;
      case 'approval_decided':
        out.push({ ...base, tone: 'info', icon: 'refresh', key: 'wsp.ev.resumed', params: {} });
        break;
      case 'budget_warn':
        out.push({
          ...base,
          tone: 'warn',
          icon: 'pulse',
          key: 'wsp.ev.budgetWarn',
          params: { pct: num(e.data.pct) },
        });
        break;
      case 'project_committed':
        out.push({
          ...base,
          tone: 'ok',
          icon: 'code',
          key: 'wsp.ev.committed',
          params: { n: num(e.data.files) },
          open: { tab: 'code' },
        });
        break;
      case 'cancel_requested':
        out.push({
          ...base,
          tone: 'warn',
          icon: 'close',
          key: 'wsp.ev.cancelRequested',
          params: {},
        });
        break;
      case 'succeeded':
        out.push({ ...base, tone: 'ok', icon: 'check', key: 'wsp.ev.succeeded', params: {} });
        break;
      case 'cancelled':
        out.push({ ...base, tone: 'warn', icon: 'close', key: 'wsp.ev.cancelled', params: {} });
        break;
      case 'budget_exceeded':
        out.push({
          ...base,
          tone: 'danger',
          icon: 'close',
          key: 'wsp.ev.budgetExceeded',
          params: {},
        });
        break;
      case 'failed': {
        const f = runFailure(e.data.error);
        out.push({
          ...base,
          tone: 'danger',
          icon: 'close',
          key: 'wsp.ev.failed',
          params: { code: f.code ?? '—' },
          reasons: f.details.length > 0 ? f.details : f.message ? [f.message] : [],
        });
        break;
      }
      default:
        out.push({
          ...base,
          tone: 'info',
          icon: 'pulse',
          key: `bld.ev.${e.type}`,
          params: { code: safeText(e.type, 40) },
        });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ what was produced */

/** One line of "what was produced": a count and where to look at it. */
export interface ProducedItem {
  id: 'spec' | 'tables' | 'migrations' | 'endpoints' | 'roles' | 'files' | 'tests' | 'deploy';
  count: number | null;
  open: OpenTarget;
  /** a destructive migration needs a human approval to deploy */
  warn?: boolean;
}

/** The pieces of a finished build the summary counts, read from the run's artifacts (the spec, the schema and the API) and the commit event. */
export interface ProducedInput {
  artifactTypes: readonly string[];
  spec: SpecView | null;
  tables: number | null;
  migrations: number | null;
  destructive: boolean;
  endpoints: number | null;
  files: number | null;
}

export function producedItems(p: ProducedInput): ProducedItem[] {
  const has = (t: string) => p.artifactTypes.includes(t);
  const out: ProducedItem[] = [];
  if (has('app_spec'))
    out.push({ id: 'spec', count: p.spec?.entities.length ?? null, open: { tab: 'spec' } });
  if (has('db_schema')) {
    out.push({
      id: 'tables',
      count: p.tables,
      open: { tab: 'design', view: 'tables' },
    });
    out.push({
      id: 'migrations',
      count: p.migrations,
      open: { tab: 'design', view: 'migrations' },
      ...(p.destructive ? { warn: true } : {}),
    });
  }
  if (has('api_contract'))
    out.push({ id: 'endpoints', count: p.endpoints, open: { tab: 'design', view: 'api' } });
  if (p.spec && p.spec.roles.length > 0)
    out.push({ id: 'roles', count: p.spec.roles.length, open: { tab: 'design', view: 'access' } });
  if (has('frontend_bundle') || p.files !== null)
    out.push({ id: 'files', count: p.files, open: { tab: 'code' } });
  if (has('test_plan')) out.push({ id: 'tests', count: null, open: { tab: 'tests' } });
  if (has('deploy_plan')) out.push({ id: 'deploy', count: null, open: { tab: 'deployments' } });
  return out;
}

/** The files a build committed, from its `project_committed` event (null while it has not committed). */
export const committedFiles = (events: readonly RunEvent[]): number | null => {
  const e = [...events].reverse().find((x) => x.type === 'project_committed');
  return e ? num(e.data.files) : null;
};

/* ------------------------------------------------------------------ conversation history */

/**
 * Where the earlier runs of a project sit in the conversation: each run follows the last message that was written before it started (a run that predates every
 * message goes to the start). The newest run is left out: the live card shows it at the end of the thread.
 */
export function runsByMessage<R extends Pick<Run, 'id' | 'createdAt'>>(
  messages: readonly Pick<Message, 'id' | 'createdAt'>[],
  runs: readonly R[],
  currentRunId: string | null,
): { before: R[]; after: Map<string, R[]> } {
  const sorted = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const before: R[] = [];
  const after = new Map<string, R[]>();
  const older = runs
    .filter((r) => r.id !== currentRunId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const r of older) {
    let host: string | null = null;
    for (const m of sorted) if (m.createdAt <= r.createdAt) host = m.id;
    if (host === null) before.push(r);
    else after.set(host, [...(after.get(host) ?? []), r]);
  }
  return { before, after };
}

/** The clock time of an event (`10:04:31`), in the platform time zone; "" for a date that does not parse. */
export function timeText(iso: string, locale: 'ar' | 'en'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Riyadh',
  }).format(d);
}
