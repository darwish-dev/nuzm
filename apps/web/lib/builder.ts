/**
 * Types and pure helpers of the website builder screens (UI-M09-01..09). No I/O: unit-tested in `builder.spec.ts`.
 *
 * The OpenAPI schemas of the builder answer many bodies as free-form objects (`additionalProperties: true`), so the shapes the screens read are
 * written down here, mirroring `packages/domain/src/builder` (site model, ops, diff, risks) and the services under `apps/api/src/modules/{ai,builder,deploy}`.
 * Everything is read defensively: nothing here invents a field, a state or a price.
 */
import type { Locale, MessageKey } from '@nuzm/i18n';
import type { CallResult } from './compute';

export const BUILDER_FLAG = 'ai.enabled';
export const TEMPLATE_IDS = [
  'restaurant',
  'clinic',
  'retail',
  'portfolio',
  'services',
  'education',
  'ngo',
  'landing',
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export const SITE_LOCALES = ['ar', 'en'] as const;
export type SiteLocale = (typeof SITE_LOCALES)[number];
export type Tone = 'success' | 'warn' | 'danger' | undefined;

// ---- contract shapes ------------------------------------------------------------------------------------------------------------

export type Localized = Partial<Record<SiteLocale, string>>;
export interface Section {
  id: string;
  type: string;
  props: Record<string, unknown>;
  style?: { background?: string; align?: string };
}
export interface PageSeo {
  title?: Localized;
  description?: Localized;
  noindex?: boolean;
}
export interface Page {
  id: string;
  slug: string;
  title: Localized;
  seo?: PageSeo;
  sections: Section[];
}
export interface SiteModel {
  locales: SiteLocale[];
  defaultLocale: SiteLocale;
  brand: { name: Localized };
  seo: { siteTitle: Localized; description: Localized; baseUrl?: string };
  pages: Page[];
  forms: { id: string; name: string }[];
  /** the rest of the stored model (navigation, footer, design tokens): carried as data, shown in the Code view */
  nav?: unknown;
  footer?: unknown;
  tokens?: unknown;
  /** images the site uses (placeholders or uploads); older stored models may not carry the list */
  assets?: {
    id: string;
    kind: string;
    source: 'placeholder' | 'upload';
    alt: Localized;
    label?: string;
    mime?: string;
    width?: number;
    height?: number;
  }[];
}
/** An editor operation (the API validates it against its own schema; the builders below produce only valid shapes). */
export type Op = { op: string } & Record<string, unknown>;

export interface DiffEntry {
  kind: string;
  pageId?: string;
  sectionId?: string;
  summary: string;
}
export interface TextChange {
  path: string;
  locale: string;
  before: string | null;
  after: string | null;
}
export interface Diff {
  structural: DiffEntry[];
  text: TextChange[];
}
export interface Risk {
  code: string;
  count: number;
  detail?: string;
}
export interface ChangeResult {
  diff: Diff;
  risks: Risk[];
  newVersion: { id: string; seq: number };
  inverseOps: Op[];
  etag?: number;
  changeId?: string | null;
}
export interface LastDeployment {
  id: string;
  state: string;
  url: string | null;
  at: string;
}
export interface Project {
  id: string;
  type: string;
  name: string;
  locales: string[];
  templateId: string | null;
  headVersionId: string | null;
  headSeq: number | null;
  dataRegion: string;
  etag: number;
  createdAt: string;
  updatedAt: string;
  lastDeployment: LastDeployment | null;
}
export interface SeoCheck {
  id: string;
  ok: boolean;
  message: { ar: string; en: string };
}
export interface ProjectDetail extends Project {
  versionId: string;
  versionSeq: number;
  /** who made the shown version; `system` and `template` are starters (placeholders), not generated content */
  versionSource?: 'user' | 'ai' | 'restore' | 'template' | 'system';
  siteModel: SiteModel;
  seo: { score: number; checks: SeoCheck[] };
  diff: Diff | null;
}
export interface Page_<T> {
  items: T[];
  nextCursor: string | null;
}
export interface Version {
  id: string;
  seq: number;
  parentId: string | null;
  label: string | null;
  named: boolean;
  source: string;
  runId: string | null;
  restoredFrom: string | null;
  createdBy: string | null;
  createdAt: string;
  modelHash: string;
  isHead: boolean;
}
export interface ProjectFile {
  path: string;
  size: number;
  mime: string;
  contentHash: string;
}
export interface FileContent {
  path: string;
  mime: string;
  size: number;
  encoding: 'utf8' | 'base64';
  content: string;
}
export interface Preview {
  id: string;
  projectId: string;
  versionId: string;
  viewport: string;
  url: string;
  expiresAt: string;
}
export interface FormField {
  name: string;
  type: string;
  required?: boolean;
}
export interface BuilderForm {
  id: string;
  projectId: string;
  formKey: string;
  name: string;
  fields: FormField[];
  enabled: boolean;
  retentionDays: number;
  notifyEmailSet?: boolean;
  submissions: number;
  spamBlocked: number;
  endpoint: string;
}
export interface Submission {
  id: string;
  formId: string;
  formKey: string;
  fields: Record<string, string>;
  masked: boolean;
  createdAt: string;
  expiresAt: string;
}
export interface CmsField {
  name: string;
  type: string;
  required?: boolean;
}
export interface CmsItem {
  id: string;
  data: Record<string, unknown>;
  state: string;
  version: number;
  updatedAt: string;
}
export interface CmsCollection {
  id: string;
  collectionKey: string;
  name: string;
  fields: CmsField[];
  items: CmsItem[];
}

export interface PendingApproval {
  id: string;
  kind: string;
  summary: unknown;
  expiresAt: string;
}
export interface RunUsage {
  tokensIn: number;
  tokensOut: number;
  spentCredits: string;
  reservedCredits: string;
  modelRef: string | null;
}
export interface Run {
  id: string;
  sessionId: string;
  projectId: string | null;
  kind: string;
  state: string;
  operationId: string | null;
  step: string | null;
  budget: unknown;
  usage: RunUsage;
  dataRegion: string;
  result: unknown;
  error: unknown;
  pendingApproval: PendingApproval | null;
  artifacts: { id: string; type: string; createdAt: string }[];
  createdAt: string;
  finishedAt: string | null;
}
export interface RunEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  at: string;
}
export interface Session {
  id: string;
  title: string;
  projectId: string | null;
  state: string;
  dataRegion: string;
  createdAt: string;
}
export interface Message {
  id: string;
  sessionId: string;
  runId: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** files (as text) and links sent with the message */
  attachments?: { kind: string; name?: string; url?: string }[];
  createdAt: string;
}
export interface Credits {
  currency: string;
  creditUnitMinor: number;
  walletCredits: string;
  reservedCredits: string;
  availableCredits: string;
  last30DaysCredits: string;
  lowCredit: boolean;
}
export interface HostingSiteRef {
  id: string;
  name: string;
  status: string;
  primaryDomain?: string | null;
}
export interface Deployment {
  id: string;
  projectId: string;
  versionId: string;
  target: { kind?: string; hostingSiteId?: string };
  environment: string;
  state: string;
  operationId: string | null;
  artifactHash: string | null;
  previousDeploymentId: string | null;
  rollbackOf: string | null;
  url: string | null;
  smoke: {
    ok?: boolean;
    tls?: boolean | null;
    phase?: string;
    results?: { path: string; status: number }[];
  } | null;
  error: { code?: string } | null;
  createdAt: string;
  finishedAt: string | null;
}
export interface DeployLog {
  seq: number;
  level: string;
  message: string;
  data?: unknown;
  at: string;
}

// ---- generic readers --------------------------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown, d = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d;

/** A localized text as the model stores it, in `locale`, falling back to the other language (a placeholder, never an invented text). */
export const localized = (v: unknown, locale: SiteLocale): string => {
  if (!isObj(v)) return '';
  const first = str(v[locale]);
  if (first) return first;
  const other = locale === 'ar' ? 'en' : 'ar';
  return str(v[other]) ?? '';
};

/** Integer-string digit grouping for credits (string arithmetic only: credits can exceed 2^53). */
export const credits = (s: string | undefined): string => {
  const d = (s ?? '0').replace(/^0+(?=\d)/, '');
  return /^\d+$/.test(d) ? d.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '0';
};

// ---- problems -----------------------------------------------------------------------------------------------------------------------

export interface BuilderProblem {
  status: number;
  code?: string;
  traceId?: string;
  approvalId?: string;
  /** `base_outdated`: the head the editor must rebase onto */
  headVersionId?: string;
  headSeq?: number;
  /** `op_invalid`: what is wrong, per path */
  issues: { path: string; message: string }[];
  /** `approval_required` on a deployment: the cost disclosure the human confirms */
  costDisclosure?: { newHostingPlan?: boolean; note?: string };
}

export function problemOf(r: CallResult<unknown>): BuilderProblem {
  const e = (r.error ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(e.errors) ? e.errors : [];
  return {
    status: r.response.status,
    code: str(e.code),
    traceId: str(e.traceId) ?? r.response.headers.get('x-trace-id') ?? undefined,
    approvalId: str(e.approvalId),
    headVersionId: str(e.headVersionId),
    headSeq: typeof e.headSeq === 'number' ? e.headSeq : undefined,
    issues: raw
      .filter(isObj)
      .map((i) => ({ path: str(i.path) ?? '', message: str(i.message) ?? '' }))
      .slice(0, 20),
    costDisclosure: isObj(e.costDisclosure)
      ? {
          newHostingPlan: e.costDisclosure.newHostingPlan === true,
          note: str(e.costDisclosure.note),
        }
      : undefined,
  };
}

const PROBLEM_KEYS: Record<string, MessageKey> = {
  insufficient_credits: 'bld.err.insufficient_credits',
  residency_denied: 'bld.err.residency_denied',
  unsupported_capability: 'bld.err.unsupported_capability',
  ai_unavailable: 'bld.err.ai_unavailable',
  ai_provider_not_enabled: 'bld.err.ai_provider_not_enabled',
  quota_exceeded: 'bld.err.quota_exceeded',
  name_taken: 'bld.err.name_taken',
  run_active: 'bld.err.run_active',
  content_blocked: 'bld.err.content_blocked',
  secret_detected: 'bld.err.secret_detected',
  base_outdated: 'bld.err.base_outdated',
  op_invalid: 'bld.err.op_invalid',
  approval_required: 'bld.err.approval_required',
  approval_expired: 'bld.err.approval_expired',
  invalid_state: 'bld.err.invalid_state',
  conflict: 'bld.err.conflict',
  in_use: 'bld.err.in_use',
  payload_too_large: 'bld.err.payload_too_large',
  validation_failed: 'bld.err.validation',
  idempotency_in_progress: 'bld.err.in_progress',
  unsupported_kind: 'bld.err.unsupported_kind',
  site_not_active: 'bld.err.site_not_active',
  network_error: 'bld.err.network',
};

/** The localized explanation of a failure code, when there is one (a run's error code); null for codes that only have the generic failure note. */
export const failureReasonKey = (code: string | null | undefined): MessageKey | null =>
  code && PROBLEM_KEYS[code] ? PROBLEM_KEYS[code]! : null;

/** Where the customer fixes a problem themselves, when the console has a screen for it (shown as a link under the message). */
const PROBLEM_FIXES: Record<string, { href: string; label: MessageKey }> = {
  residency_denied: { href: '/privacy#residency', label: 'bld.fix.residency' },
  insufficient_credits: { href: '/billing/payments#wallet', label: 'bld.fix.credits' },
};
export const problemFix = (p: Pick<BuilderProblem, 'code'>) =>
  (p.code && PROBLEM_FIXES[p.code]) || null;

/** Localized message for a problem: by code first, then by status. Never the raw server text. */
export function problemKey(p: BuilderProblem): MessageKey {
  if (p.code && PROBLEM_KEYS[p.code]) return PROBLEM_KEYS[p.code]!;
  if (p.status === 429) return 'bld.err.rate_limited';
  if (p.status === 403) return 'state.forbidden.title';
  if (p.status === 404) return 'bld.err.not_found';
  if (p.status === 409) return 'bld.err.conflict';
  if (p.status === 422) return 'bld.err.validation';
  return 'state.error.title';
}

// ---- Server-Sent Events -----------------------------------------------------------------------------------------------------------------

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Incremental parser of a `text/event-stream` body: feed it decoded chunks (frames may be split anywhere), it calls `onFrame` once per complete frame.
 * Comment lines (`: keep-alive`) and `retry:` are ignored; multi-line `data:` is joined with a newline; CRLF, LF and CR line ends are accepted.
 */
export function createSseParser(onFrame: (f: SseFrame) => void) {
  let buf = '';
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0 || event !== undefined)
      onFrame({
        ...(id !== undefined ? { id } : {}),
        ...(event ? { event } : {}),
        data: data.join('\n'),
      });
    event = undefined;
    data = [];
  };
  const line = (l: string) => {
    if (l === '') return flush();
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  return {
    push(chunk: string) {
      buf += chunk;
      let m: RegExpExecArray | null;
      const re = /\r\n|\n|\r/g;
      let start = 0;
      while ((m = re.exec(buf))) {
        // a lone CR at the very end may be the first half of CRLF: wait for the next chunk
        if (m[0] === '\r' && m.index + 1 === buf.length) break;
        line(buf.slice(start, m.index));
        start = m.index + m[0].length;
      }
      buf = buf.slice(start);
    },
  };
}

/** A parsed frame as a run event; anything malformed is dropped (the stream is persisted, a missed event is re-read on reconnect). */
export function toRunEvent(f: SseFrame): RunEvent | null {
  try {
    const j = JSON.parse(f.data) as unknown;
    if (!isObj(j) || typeof j.seq !== 'number' || typeof j.type !== 'string') return null;
    return {
      seq: j.seq,
      type: j.type,
      data: isObj(j.data) ? j.data : {},
      at: str(j.at) ?? '',
    };
  } catch {
    return null;
  }
}

/** Insert an event keeping the list ordered by `seq` and free of duplicates (a reconnect may replay). */
export function mergeEvent(list: RunEvent[], e: RunEvent): RunEvent[] {
  if (list.some((x) => x.seq === e.seq)) return list;
  return [...list, e].sort((a, b) => a.seq - b.seq);
}
export const lastSeq = (list: RunEvent[]): number => list.reduce((m, e) => Math.max(m, e.seq), 0);

// ---- runs -----------------------------------------------------------------------------------------------------------------------------

export const RUN_ACTIVE = ['queued', 'running', 'waiting_approval'] as const;
export const isRunActive = (state: string): boolean =>
  (RUN_ACTIVE as readonly string[]).includes(state);
/** States after which nothing more happens on its own. */
export const isRunFinished = (state: string): boolean =>
  ['succeeded', 'failed', 'cancelled', 'budget_exceeded'].includes(state);
/**
 * What the website canvas may show. A `system` or `template` version is the STARTER the project was created with (its title is the project name), not generated
 * content: while no generation or edit has replaced it, the canvas shows the generation state instead of presenting the starter as an AI result.
 *  - `site`: show the preview (the version was made by the AI, by the person, or by a restore)
 *  - `processing`: a run is queued or working; `approval`: the run waits for the person's approval
 *  - `failed`: the last run failed, was cancelled or ran out of budget; `errorKey` says why in the person's language
 *  - `empty`: nothing has been generated yet (no run, or a run that changed nothing)
 */
export type CanvasState =
  | { kind: 'site' }
  | { kind: 'processing' }
  | { kind: 'approval' }
  | { kind: 'failed'; state: string; errorKey: MessageKey; code: string | null }
  | { kind: 'empty' };
export function canvasState(
  versionSource: string | undefined,
  run: Pick<Run, 'state' | 'error'> | null,
): CanvasState {
  if (versionSource !== 'system' && versionSource !== 'template') return { kind: 'site' };
  if (!run) return { kind: 'empty' };
  if (run.state === 'waiting_approval') return { kind: 'approval' };
  if (isRunActive(run.state)) return { kind: 'processing' };
  if (run.state === 'failed' || run.state === 'cancelled' || run.state === 'budget_exceeded') {
    const e = run.error as { code?: unknown } | null;
    const code = typeof e?.code === 'string' ? e.code : null;
    const errorKey: MessageKey =
      run.state === 'cancelled'
        ? 'bld.canvas.cancelled'
        : run.state === 'budget_exceeded'
          ? 'bld.canvas.budget'
          : code && PROBLEM_KEYS[code]
            ? PROBLEM_KEYS[code]!
            : 'bld.canvas.failedGeneric';
    return { kind: 'failed', state: run.state, errorKey, code };
  }
  return { kind: 'empty' };
}
export const runTone = (state: string): Tone =>
  state === 'succeeded'
    ? 'success'
    : state === 'failed' || state === 'budget_exceeded'
      ? 'danger'
      : state === 'waiting_approval' || state === 'cancelled'
        ? 'warn'
        : undefined;

/** Whether the stream should be reopened after it ended: only while the run can still produce events without a human decision. */
export const shouldReconnect = (state: string): boolean =>
  state === 'queued' || state === 'running';

/** Message key + params of one timeline entry (unknown event types are shown by their code, nothing is invented). */
export function eventText(e: RunEvent): { key: string; params: Record<string, string | number> } {
  const task = str(e.data.task) ?? '';
  const kind = str(e.data.kind) ?? '';
  const type = str(e.data.type) ?? '';
  return {
    key: `bld.ev.${e.type}`,
    params: { task, kind, type, pageId: str(e.data.pageId) ?? '', seq: num(e.data.seq) },
  };
}
export const EVENT_KEYS = [
  'created',
  'segment_started',
  'step_started',
  'step_completed',
  'checkpoint',
  'artifact',
  'approval_requested',
  'approval_approved',
  'approval_denied',
  'approval_expired',
  'page_generated',
  'model_invalid',
  'version_created',
  'auto_applied',
  'change_conflict',
  'cancel_requested',
  'succeeded',
  'failed',
  'cancelled',
  'budget_exceeded',
  'fetch_failed',
  'repair',
  'output_blocked',
  'tool_call_denied',
  'tool_call_ignored',
] as const;

/** Events that matter to a screen reader (progress, not every checkpoint). */
export const isAnnounced = (type: string): boolean =>
  !['checkpoint', 'segment_started', 'created', 'artifact'].includes(type);

/** The summary of a pending approval, read defensively (plan: pages; apply_changes: diff and risks). The stored payload is never shown. */
export interface ApprovalView {
  title: string;
  pages: { pageId: string; slug: string; sections: number }[];
  diff: Diff | null;
  risks: Risk[];
  summary: string;
}
export function approvalView(a: PendingApproval): ApprovalView {
  const s = isObj(a.summary) ? a.summary : {};
  const pages = Array.isArray(s.pages) ? s.pages.filter(isObj) : [];
  const diff = isObj(s.diff) ? s.diff : null;
  const risks = Array.isArray(s.risks) ? s.risks.filter(isObj) : [];
  return {
    title: str(s.title) ?? '',
    pages: pages.map((p) => ({
      pageId: str(p.pageId) ?? '',
      slug: str(p.slug) ?? '',
      sections: num(p.sections),
    })),
    diff: diff
      ? {
          structural: (Array.isArray(diff.structural) ? diff.structural : [])
            .filter(isObj)
            .map((d) => ({
              kind: str(d.kind) ?? '',
              ...(str(d.pageId) ? { pageId: str(d.pageId) } : {}),
              ...(str(d.sectionId) ? { sectionId: str(d.sectionId) } : {}),
              summary: str(d.summary) ?? '',
            })),
          text: (Array.isArray(diff.text) ? diff.text : []).filter(isObj).map((d) => ({
            path: str(d.path) ?? '',
            locale: str(d.locale) ?? '',
            before: str(d.before) ?? null,
            after: str(d.after) ?? null,
          })),
        }
      : null,
    risks: risks.map((r) => ({
      code: str(r.code) ?? '',
      count: num(r.count),
      ...(str(r.detail) ? { detail: str(r.detail) } : {}),
    })),
    summary: typeof s.summary === 'string' ? s.summary : '',
  };
}

// ---- site model: outline and inspector ------------------------------------------------------------------------------------------------

/** The component types the inspector knows (mirror of the model's SECTION_SPECS: loc = required localized text, locOpt = optional). */
interface ItemSpec {
  prop: string;
  loc: string[];
  locOpt: string[];
  strings: string[];
}
interface SectionSpec {
  loc: string[];
  locOpt: string[];
  strings: string[];
  items?: ItemSpec;
}
export const SECTION_SPECS: Record<string, SectionSpec> = {
  hero: { loc: ['heading'], locOpt: ['subheading', 'ctaLabel'], strings: [] },
  text: { loc: ['body'], locOpt: ['heading'], strings: [] },
  image: { loc: [], locOpt: ['caption'], strings: [] },
  gallery: { loc: [], locOpt: ['heading'], strings: [] },
  features: {
    loc: [],
    locOpt: ['heading'],
    strings: ['collection'],
    items: { prop: 'items', loc: ['title', 'text'], locOpt: [], strings: ['icon'] },
  },
  pricing: {
    loc: [],
    locOpt: ['heading'],
    strings: ['collection'],
    items: {
      prop: 'plans',
      loc: ['name'],
      locOpt: ['description', 'period'],
      strings: ['price', 'currency'],
    },
  },
  testimonials: {
    loc: [],
    locOpt: ['heading'],
    strings: ['collection'],
    items: { prop: 'items', loc: ['quote'], locOpt: ['role'], strings: ['author'] },
  },
  faq: {
    loc: [],
    locOpt: ['heading'],
    strings: ['collection'],
    items: { prop: 'items', loc: ['question', 'answer'], locOpt: [], strings: [] },
  },
  contact_form: { loc: [], locOpt: ['heading', 'intro'], strings: [] },
  map: { loc: [], locOpt: ['heading', 'address'], strings: ['query'] },
  stats: {
    loc: [],
    locOpt: ['heading'],
    strings: [],
    items: { prop: 'stats', loc: ['label'], locOpt: [], strings: ['value'] },
  },
  cta: { loc: ['heading'], locOpt: ['subheading', 'ctaLabel'], strings: [] },
  steps: {
    loc: [],
    locOpt: ['heading'],
    strings: [],
    items: { prop: 'steps', loc: ['title', 'text'], locOpt: [], strings: [] },
  },
};
export const SECTION_TYPES = Object.keys(SECTION_SPECS);
const LONG_TEXT = new Set([
  'body',
  'text',
  'answer',
  'quote',
  'subheading',
  'intro',
  'description',
]);

export interface OutlineEntry {
  pageId: string;
  pageLabel: string;
  sectionId: string;
  type: string;
  label: string;
  index: number;
  count: number;
}
/** Every component of every page in reading order, labelled by its heading in `locale` when it has one. */
export function outlineOf(model: SiteModel, locale: SiteLocale): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  for (const p of model.pages)
    p.sections.forEach((s, i) =>
      out.push({
        pageId: p.id,
        pageLabel: localized(p.title, locale) || p.slug,
        sectionId: s.id,
        type: s.type,
        label: localized(s.props.heading ?? s.props.body ?? s.props.caption, locale),
        index: i,
        count: p.sections.length,
      }),
    );
  return out;
}
export const findSection = (
  model: SiteModel,
  pageId: string,
  sectionId: string,
): Section | undefined =>
  model.pages.find((p) => p.id === pageId)?.sections.find((s) => s.id === sectionId);

export interface InspectorField {
  key: string;
  /** property name (for the label) */
  name: string;
  /** `items.2` for a field of the third item, else null */
  group: string | null;
  kind: 'loc' | 'str';
  locale?: SiteLocale;
  required: boolean;
  multiline: boolean;
  initial: string;
}

/** The editable text fields of a component for the site's locales, with their current values. */
export function inspectorFields(section: Section, locales: SiteLocale[]): InspectorField[] {
  const spec = SECTION_SPECS[section.type];
  if (!spec) return [];
  const out: InspectorField[] = [];
  const locField = (
    key: string,
    name: string,
    group: string | null,
    holder: Record<string, unknown>,
    required: boolean,
  ) => {
    for (const l of locales)
      out.push({
        key: `${key}|${l}`,
        name,
        group,
        kind: 'loc',
        locale: l,
        required,
        multiline: LONG_TEXT.has(name),
        initial: str(isObj(holder[name]) ? (holder[name] as Record<string, unknown>)[l] : '') ?? '',
      });
  };
  for (const n of spec.loc) locField(`p:${n}`, n, null, section.props, true);
  for (const n of spec.locOpt) locField(`p:${n}`, n, null, section.props, false);
  for (const n of spec.strings)
    out.push({
      key: `p:${n}`,
      name: n,
      group: null,
      kind: 'str',
      required: false,
      multiline: false,
      initial: str(section.props[n]) ?? '',
    });
  if (spec.items) {
    const list = Array.isArray(section.props[spec.items.prop])
      ? (section.props[spec.items.prop] as unknown[])
      : [];
    list.forEach((raw, i) => {
      const it = isObj(raw) ? raw : {};
      const g = `${spec.items!.prop}.${i}`;
      for (const n of spec.items!.loc) locField(`i:${i}:${n}`, n, g, it, true);
      for (const n of spec.items!.locOpt) locField(`i:${i}:${n}`, n, g, it, false);
      for (const n of spec.items!.strings)
        out.push({
          key: `i:${i}:${n}`,
          name: n,
          group: g,
          kind: 'str',
          required: false,
          multiline: false,
          initial: str(it[n]) ?? '',
        });
    });
  }
  return out;
}

export interface StyleDraft {
  background: string;
  align: string;
}
export const styleOf = (s: Section): StyleDraft => ({
  background: s.style?.background ?? '',
  align: s.style?.align ?? '',
});

/**
 * The ops that turn the inspector's edited values into a change: one `setText` per changed top-level text (an emptied optional text becomes `null`),
 * ONE `updateProps` for changed plain strings and items, and one `updateProps` for the style. Nothing changed → no ops.
 */
export function draftOps(
  pageId: string,
  section: Section,
  fields: InspectorField[],
  values: Record<string, string>,
  style: StyleDraft,
): Op[] {
  const ops: Op[] = [];
  const spec = SECTION_SPECS[section.type];
  const props: Record<string, unknown> = {};
  let items: Record<string, unknown>[] | null = null;
  const itemsProp = spec?.items?.prop;
  for (const f of fields) {
    const v = values[f.key] ?? f.initial;
    if (v === f.initial) continue;
    if (f.group === null && f.kind === 'loc') {
      ops.push({
        op: 'setText',
        target: 'section',
        pageId,
        sectionId: section.id,
        prop: f.name,
        locale: f.locale!,
        value: v === '' ? null : v,
      });
    } else if (f.group === null) {
      props[f.name] = v === '' ? null : v;
    } else if (itemsProp) {
      items ??= (
        Array.isArray(section.props[itemsProp]) ? (section.props[itemsProp] as unknown[]) : []
      ).map((x) => JSON.parse(JSON.stringify(isObj(x) ? x : {})) as Record<string, unknown>);
      const idx = Number(f.group.split('.')[1]);
      const it = items[idx];
      if (!it) continue;
      if (f.kind === 'loc') {
        const holder = isObj(it[f.name]) ? { ...(it[f.name] as Record<string, unknown>) } : {};
        if (v === '') delete holder[f.locale!];
        else holder[f.locale!] = v;
        if (Object.keys(holder).length === 0) delete it[f.name];
        else it[f.name] = holder;
      } else if (v === '') delete it[f.name];
      else it[f.name] = v;
    }
  }
  if (items && itemsProp) props[itemsProp] = items;
  const cur = styleOf(section);
  const styleChanged = cur.background !== style.background || cur.align !== style.align;
  if (Object.keys(props).length > 0 || styleChanged) {
    const st: Record<string, string> = {};
    if (style.background) st.background = style.background;
    if (style.align) st.align = style.align;
    ops.push({
      op: 'updateProps',
      pageId,
      sectionId: section.id,
      props,
      ...(styleChanged ? { style: Object.keys(st).length > 0 ? st : null } : {}),
    });
  }
  return ops;
}

export const moveOp = (pageId: string, sectionId: string, index: number): Op => ({
  op: 'moveComponent',
  pageId,
  sectionId,
  index,
});
export const deleteOp = (pageId: string, sectionId: string): Op => ({
  op: 'deleteComponent',
  pageId,
  sectionId,
});

/** Placeholder CONTENT for a newly inserted component (site content, not interface text: the owner replaces it). */
const SAMPLE: Record<SiteLocale, string> = { ar: 'نص تجريبي', en: 'Sample text' };
export const INSERTABLE = [
  'hero',
  'text',
  'features',
  'faq',
  'pricing',
  'testimonials',
  'stats',
  'steps',
  'cta',
  'map',
  'contact_form',
] as const;

export const nextSectionId = (model: SiteModel, type: string): string => {
  const used = new Set(model.pages.flatMap((p) => p.sections.map((s) => s.id)));
  for (let n = 1; n < 1000; n++)
    if (!used.has(`${type.replace(/_/g, '-')}${n}`)) return `${type.replace(/_/g, '-')}${n}`;
  return `${type.replace(/_/g, '-')}${Date.now()}`;
};

/** A valid new component of `type` with sample text in every site language; null when the type needs something the site lacks (a form). */
export function sampleSection(model: SiteModel, type: string, id: string): Section | null {
  const L = Object.fromEntries(model.locales.map((l) => [l, SAMPLE[l]])) as Localized;
  switch (type) {
    case 'hero':
      return { id, type, props: { heading: L } };
    case 'text':
      return { id, type, props: { body: L } };
    case 'features':
      return { id, type, props: { items: [{ title: L, text: L }] } };
    case 'faq':
      return { id, type, props: { items: [{ question: L, answer: L }] } };
    case 'pricing':
      return { id, type, props: { plans: [{ name: L, price: '0', currency: 'SAR' }] } };
    case 'testimonials':
      return { id, type, props: { items: [{ quote: L, author: SAMPLE.en }] } };
    case 'stats':
      return {
        id,
        type,
        props: {
          stats: [
            { value: '00', label: L },
            { value: '00', label: L },
          ],
        },
      };
    case 'steps':
      return {
        id,
        type,
        props: {
          steps: [
            { title: L, text: L },
            { title: L, text: L },
          ],
        },
      };
    case 'cta':
      return { id, type, props: { heading: L } };
    case 'map':
      return { id, type, props: {} };
    case 'contact_form': {
      const f = model.forms[0];
      return f ? { id, type, props: { formId: f.id } } : null;
    }
    default:
      return null;
  }
}
export const insertOp = (pageId: string, section: Section, index?: number): Op => ({
  op: 'insertComponent',
  pageId,
  section,
  ...(index !== undefined ? { index } : {}),
});

// ---- undo / redo --------------------------------------------------------------------------------------------------------------------------

/** Stacks of inverse op sets: `undo` holds what reverts the last edits, `redo` what re-applies a reverted one. The server returns each inverse; nothing is computed here. */
export interface History {
  undo: Op[][];
  redo: Op[][];
}
export const emptyHistory: History = { undo: [], redo: [] };
const CAP = 50;
export const pushEdit = (h: History, inverse: Op[]): History => ({
  undo: [...h.undo, inverse].slice(-CAP),
  redo: [],
});
/** The next undo (or redo) step without consuming it: consume with `finishUndo` once the server accepted it, so a failed step leaves both stacks as they were. */
export const nextUndo = (h: History): Op[] | null => h.undo[h.undo.length - 1] ?? null;
export const nextRedo = (h: History): Op[] | null => h.redo[h.redo.length - 1] ?? null;
export const finishUndo = (h: History, redoOps: Op[]): History => ({
  undo: h.undo.slice(0, -1),
  redo: [...h.redo, redoOps].slice(-CAP),
});
export const finishRedo = (h: History, undoOps: Op[]): History => ({
  undo: [...h.undo, undoOps].slice(-CAP),
  redo: h.redo.slice(0, -1),
});

// ---- diff / risk display --------------------------------------------------------------------------------------------------------------

export const RISK_CODES = [
  'deletes_page',
  'deletes_component',
  'changes_seo',
  'changes_slug',
  'removes_asset',
  'many_changes',
  'changes_base_url',
] as const;
/** Risk flags that make a change need a second look. All of them do; the list is kept for the key set. */
export const DIFF_KINDS = [
  'page_added',
  'page_deleted',
  'slug_changed',
  'component_added',
  'component_deleted',
  'component_changed',
  'components_reordered',
  'tokens_changed',
  'seo_changed',
  'nav_changed',
  'assets_changed',
] as const;

// ---- SEO ----------------------------------------------------------------------------------------------------------------------------------

/** Mirror of the model's base URL rule (an absolute https URL). */
export const isBaseUrl = (v: string): boolean =>
  v.length <= 200 && /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{2,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(v);

export const seoTone = (score: number): Tone =>
  score >= 80 ? 'success' : score >= 50 ? 'warn' : 'danger';

/** One `Localized` from per-locale form values: empty strings are dropped. */
export const localizedOf = (values: Record<string, string>, locales: SiteLocale[]): Localized =>
  Object.fromEntries(
    locales.filter((l) => (values[l] ?? '').trim() !== '').map((l) => [l, values[l]!.trim()]),
  ) as Localized;

/** `setSeo` for the site-level fields; `baseUrl` empty removes it (null). */
export function siteSeoOp(
  locales: SiteLocale[],
  v: { title: Record<string, string>; description: Record<string, string>; baseUrl: string },
): Op {
  return {
    op: 'setSeo',
    seo: {
      siteTitle: localizedOf(v.title, locales),
      description: localizedOf(v.description, locales),
      baseUrl: v.baseUrl.trim() === '' ? null : v.baseUrl.trim(),
    },
  };
}
/** `updatePage` for a page's own SEO; all empty means "no page-level SEO" (null). */
export function pageSeoOp(
  pageId: string,
  locales: SiteLocale[],
  v: { title: Record<string, string>; description: Record<string, string>; noindex: boolean },
): Op {
  const title = localizedOf(v.title, locales);
  const description = localizedOf(v.description, locales);
  const seo: Record<string, unknown> = {
    ...(Object.keys(title).length ? { title } : {}),
    ...(Object.keys(description).length ? { description } : {}),
    ...(v.noindex ? { noindex: true } : {}),
  };
  return { op: 'updatePage', pageId, seo: Object.keys(seo).length ? seo : null };
}

// ---- preview ------------------------------------------------------------------------------------------------------------------------------

export const VIEWPORTS = { mobile: 375, tablet: 768, desktop: 1200 } as const;
export type Viewport = keyof typeof VIEWPORTS;

/** The preview is only ever framed from an https (or, in development, http) URL: anything else is not put in an iframe. */
export const isPreviewUrl = (u: string): boolean => /^https?:\/\/[^\s/]+\//.test(u);

// ---- deployments --------------------------------------------------------------------------------------------------------------------------

export const DEPLOY_ACTIVE = ['queued', 'building', 'deploying', 'smoke_checking'] as const;
export const isDeployActive = (state: string): boolean =>
  (DEPLOY_ACTIVE as readonly string[]).includes(state);
export const deployTone = (state: string): Tone =>
  state === 'succeeded'
    ? 'success'
    : state === 'failed' || state === 'rolled_back'
      ? 'danger'
      : isDeployActive(state)
        ? 'warn'
        : undefined;
/** Rollback is offered for a succeeded deployment that has something to go back to. */
export const canRollback = (d: Deployment): boolean =>
  d.state === 'succeeded' && d.previousDeploymentId !== null && d.rollbackOf === null;
export const DEPLOY_ENVIRONMENTS = ['production', 'staging'] as const;

// ---- CMS ----------------------------------------------------------------------------------------------------------------------------------

export const CMS_FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'localized_text'] as const;
export const SLUG = /^[a-z][a-z0-9_-]{0,39}$/;
export const FIELD_NAME = /^[a-z][a-z0-9_]{0,29}$/;

/** The typed value the CMS API expects for one field, from the editor's string value; null = invalid for the type. */
export function cmsValue(
  type: string,
  raw: string | boolean | Record<string, string>,
): string | number | boolean | Record<string, string> | null | undefined {
  if (type === 'boolean') return raw === true;
  if (type === 'localized_text') {
    const o = Object.fromEntries(
      Object.entries(raw as Record<string, string>).filter(([, v]) => v.trim() !== ''),
    );
    return Object.keys(o).length ? o : undefined;
  }
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') return undefined; // empty = not set
  if (type === 'number') {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'date') return Number.isNaN(Date.parse(s)) ? null : s;
  return s;
}

/** A short text of an item for a table cell (first text-like field, in `locale`). */
export function cmsItemLabel(fields: CmsField[], data: Record<string, unknown>, l: Locale): string {
  for (const f of fields) {
    const v = data[f.name];
    if (typeof v === 'string' && v) return v;
    if (isObj(v)) {
      const s = localized(v, l);
      if (s) return s;
    }
  }
  return '';
}

/** Absolute label of a form field for a table header. */
export const LOCALE_LABEL: Record<SiteLocale, string> = { ar: 'العربية', en: 'English' };

// ---- the run as a few human steps (the live card in the chat) --------------------------------------------------------------------------------

export type StageState = 'done' | 'active' | 'pending' | 'failed';
export interface Stage {
  /** `requirements`, `plan`, `approval`, `pages`, `build`, `prepare`, `apply`, `reply`, `work` (the label is looked up as `bld.stage.<id>`) */
  id: string;
  state: StageState;
  /** a short extra, e.g. `2/5` for pages written */
  detail?: string;
}

const TERMINAL_BAD = ['failed', 'cancelled', 'budget_exceeded'];

/**
 * The run's events as the handful of steps a person understands. Only what the events say is shown: a step is reached when its first event has arrived, so the
 * card never claims progress that did not happen. `pagesTotal` (from the plan awaiting approval) turns "pages" into `written/total`.
 */
export function runStages(
  kind: string,
  state: string,
  events: RunEvent[],
  pagesTotal: number | null,
): Stage[] {
  const started = (task: string) =>
    events.some((e) => e.type === 'step_started' && e.data.task === task);
  const has = (type: string) => events.some((e) => e.type === type);
  const written = events.filter((e) => e.type === 'page_generated').length;
  const ids =
    kind === 'website'
      ? ['requirements', 'plan', 'approval', 'pages', 'build']
      : kind === 'edit'
        ? ['prepare', 'approval', 'apply']
        : kind === 'chat'
          ? ['reply']
          : ['work'];
  const reached = (id: string): boolean => {
    switch (id) {
      case 'requirements':
      case 'prepare':
      case 'reply':
      case 'work':
        return true;
      case 'plan':
        return started('architecture') || has('approval_requested') || has('approval_approved');
      case 'approval':
        return (
          has('approval_requested') || has('approval_approved') || state === 'waiting_approval'
        );
      case 'pages':
        return has('approval_approved') || written > 0 || started('page');
      case 'build':
        return has('version_created') || state === 'succeeded';
      case 'apply':
        return has('approval_approved') || has('version_created') || state === 'succeeded';
      default:
        return false;
    }
  };
  let current = 0;
  ids.forEach((id, i) => {
    if (reached(id)) current = i;
  });
  const finished = state === 'succeeded';
  const bad = TERMINAL_BAD.includes(state);
  return ids.map((id, i) => {
    const detail =
      id === 'pages' && written > 0
        ? pagesTotal
          ? `${Math.min(written, pagesTotal)}/${pagesTotal}`
          : String(written)
        : undefined;
    const base = { id, ...(detail ? { detail } : {}) };
    if (finished) return { ...base, state: 'done' as const };
    if (i < current) return { ...base, state: 'done' as const };
    if (i === current) return { ...base, state: bad ? ('failed' as const) : ('active' as const) };
    return { ...base, state: 'pending' as const };
  });
}
