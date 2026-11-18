/** Pure helpers of the managed data and email screens (UI-M08-01..14). No I/O: unit-tested in `data.spec.ts`. */
import { t, type Locale, type MessageKey } from '@nuzm/i18n';

export type Tone = 'success' | 'danger' | 'warn' | undefined;

/** The ETag header value for a numeric (or opaque string) version, exactly as the API accepts it. */
export const ifMatch = (etag: number | string) => `"${etag}"`;

/** A new Idempotency-Key per user intent (a retry of the same intent reuses it). */
export const newKey = () => crypto.randomUUID();

/* ------------------------------------------------------------------ problems */

export interface ProblemInfo {
  status: number;
  code?: string;
  detail?: string;
  throttled?: boolean;
  fieldErrors: { field?: string; message?: string }[];
}

/** Everything a screen needs from a failed call, without ever trusting the shape of the body. */
export function problemOf(r: { response: { status: number }; error?: unknown }): ProblemInfo {
  const e = (r.error ?? {}) as {
    code?: unknown;
    detail?: unknown;
    throttled?: unknown;
    errors?: unknown;
  };
  return {
    status: r.response.status,
    code: typeof e.code === 'string' ? e.code : undefined,
    detail: typeof e.detail === 'string' ? e.detail : undefined,
    throttled: e.throttled === true,
    fieldErrors: Array.isArray(e.errors)
      ? e.errors
          .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
          .map((x) => ({
            field: typeof x.field === 'string' ? x.field : undefined,
            message: typeof x.message === 'string' ? x.message : undefined,
          }))
      : [],
  };
}

const BY_CODE: Record<string, MessageKey> = {
  unsupported_capability: 'm8.err.unsupported',
  residency_denied: 'm8.err.residency',
  name_taken: 'm8.err.nameTaken',
  in_use: 'm8.err.inUse',
  rotation_in_progress: 'm8.err.rotation',
  restore_not_supported: 'm8.err.restoreUnsupported',
  policy_invalid: 'm8.err.policyInvalid',
  ttl_too_long: 'm8.err.ttl',
  category_not_allowed: 'm8.err.category',
  suppressed: 'm8.err.suppressed',
  sender_not_verified: 'm8.err.senderNotVerified',
  domain_not_owned: 'm8.err.domainNotOwned',
  quota_exceeded: 'm8.err.quota',
  kind_not_available: 'm8.err.noPrice',
  spend_approval_required: 'm8.err.approval',
  insufficient_funds: 'm8.err.funds',
  account_restricted: 'm8.err.funds',
  precondition_required: 'm8.err.reload',
  precondition_failed: 'm8.err.stale',
  step_up_required: 'm8.err.stepUp',
  rate_limited: 'm8.err.rate',
};

/**
 * Plain-language message for a failed call, in the user's language (never the raw problem text). For `unsupported_capability` the API's own detail is
 * returned separately so the screen can show "why" (for example that a version is not offered).
 */
export function dataError(locale: Locale, p: ProblemInfo): { text: string; detail?: string } {
  const key = p.code ? BY_CODE[p.code] : undefined;
  if (p.status === 429 && p.throttled) return { text: t(locale, 'm8.err.throttled') };
  if (key)
    return {
      text: t(locale, key),
      detail: p.code === 'unsupported_capability' ? p.detail : undefined,
    };
  if (p.status === 403) return { text: t(locale, 'state.forbidden.title') };
  if (p.status === 412) return { text: t(locale, 'm8.err.stale') };
  if (p.status === 428) return { text: t(locale, 'm8.err.reload') };
  if (p.status === 409) return { text: t(locale, 'err.conflict') };
  if (p.status === 422) return { text: t(locale, 'err.validation') };
  if (p.status === 429) return { text: t(locale, 'm8.err.rate') };
  return { text: t(locale, 'state.error.title') };
}

/* ------------------------------------------------------------------ names and numbers */

/** Names of databases and buckets: lowercase letters, digits and dashes, starting and ending with a letter or digit. */
export const validResourceName = (v: string) => /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(v);
/** The reserved prefixes of the bucket namespace and of the platform's own buckets. */
export const reservedBucketName = (v: string) => /^(nz-|sys-)/.test(v);
export const validLocalPart = (v: string) => /^[a-z0-9][a-z0-9._+-]{0,62}$/i.test(v);
export const validDomain = (v: string) =>
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v) && v.length <= 253;
export const validEmailAddress = (v: string) =>
  /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/.test(v) && v.length <= 254;
export const positiveInt = (v: string, max = 1_000_000) =>
  /^[1-9]\d{0,9}$/.test(v.trim()) && Number(v) <= max;

/** Bytes for people (binary units); null/undefined is "unavailable" (the caller prints the localized word). */
export function formatBytes(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return null;
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}
/** Usage as a 0..100 percentage of the quota; null when either figure is unknown or the quota is zero. */
export function usagePercent(used: number | null | undefined, quota: number | null | undefined) {
  if (used === null || used === undefined || !quota || quota <= 0) return null;
  return Math.min(100, Math.round((used / quota) * 100));
}
/**
 * Bucket usage as the provider could report it: a figure is null (shown as "unavailable") when the provider says it cannot report it
 * (`available.<x> === false`) or sent no number.
 */
export function bucketUsage(u: Record<string, unknown> | null | undefined): {
  bytes: number | null;
  requests: number | null;
  egress: number | null;
  at: string | null;
} {
  const avail = (u?.available ?? {}) as Record<string, unknown>;
  const num = (v: unknown, flag: string) =>
    avail[flag] === false || typeof v !== 'number' || !Number.isFinite(v) ? null : v;
  return {
    bytes: num(u?.bytesStored, 'bytes'),
    requests: num(u?.requests, 'requests'),
    egress: num(u?.egressBytes, 'egress'),
    at: typeof u?.at === 'string' ? u.at : null,
  };
}
/** First 12 characters of a checksum, for a table cell (the full value is the title). */
export const shortChecksum = (c: string | null | undefined) =>
  c ? c.replace(/^sha256:/, '').slice(0, 12) : null;

/* ------------------------------------------------------------------ database */

export const ENGINES = ['postgresql', 'mysql', 'redis'] as const;
export type EngineName = (typeof ENGINES)[number];
/** Example text for the version input only: never offered, never sent unless the user types it. */
export const VERSION_EXAMPLE: Record<EngineName, string> = {
  postgresql: '16',
  mysql: '8.4',
  redis: '7.2',
};

export function databaseTone(s: string): Tone {
  return s === 'running'
    ? 'success'
    : s === 'failed'
      ? 'danger'
      : s === 'unknown' || s === 'provisioning' || s === 'deleting'
        ? 'warn'
        : undefined;
}
export const isBusyStatus = (s: string) =>
  s === 'provisioning' || s === 'deleting' || s === 'unknown';

/**
 * CIDR allow-list text (one range per line, commas also accepted). `open` when a range admits the whole internet (/0), which is never allowed.
 */
export function parseCidrs(text: string): {
  list: string[];
  error?: 'empty' | 'invalid' | 'open';
  bad?: string;
} {
  const list = [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  if (list.length === 0) return { list, error: 'empty' };
  for (const c of list) {
    const m = /^(.+)\/(\d{1,3})$/.exec(c);
    if (!m) return { list, error: 'invalid', bad: c };
    const [, addr, bitsText] = m;
    const bits = Number(bitsText);
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr!);
    if (v4) {
      if (v4.slice(1).some((o) => Number(o) > 255) || bits > 32)
        return { list, error: 'invalid', bad: c };
    } else if (/^[0-9a-fA-F:]+$/.test(addr!) && addr!.includes(':') && !/:::/.test(addr!)) {
      if (bits > 128 || (addr!.match(/::/g) ?? []).length > 1)
        return { list, error: 'invalid', bad: c };
    } else return { list, error: 'invalid', bad: c };
    if (bits === 0) return { list, error: 'open', bad: c };
  }
  return { list };
}

/** The single item of a `database` quote (docs/04): exactly what the pricer takes. */
export function databaseQuoteItem(f: {
  engine: EngineName;
  version: string;
  planRef: string;
  storageGb: string;
  region: string;
}): { item?: Record<string, unknown>; error?: 'version' | 'plan' | 'storage' } {
  const version = f.version.trim();
  const plan = f.planRef.trim();
  if (!/^\d{1,3}(\.\d{1,3}){0,2}$/.test(version)) return { error: 'version' };
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(plan)) return { error: 'plan' };
  if (!positiveInt(f.storageGb, 999_999)) return { error: 'storage' };
  const region = f.region.trim();
  return {
    item: {
      engine: f.engine,
      version,
      planRef: plan,
      storageGb: Number(f.storageGb),
      ...(region ? { region } : {}),
    },
  };
}
/** Key of one offer (the options that were refused stay disabled until the user changes them). */
export const offerKey = (x: Record<string, unknown>) =>
  [x.engine, x.version, x.planRef, x.storageGb, x.region ?? ''].join('|');

/** What the console shows of a verification record (the shape is the restore service's: checkedAt, passed, engineCheck, tables[]). */
export function verificationOf(v: Record<string, unknown> | null | undefined): {
  checkedAt?: string;
  passed: boolean | null;
  tablesTotal: number;
  tablesMatched: number;
} | null {
  if (!v) return null;
  const tables = Array.isArray(v.tables) ? (v.tables as { match?: unknown }[]) : [];
  return {
    checkedAt: typeof v.checkedAt === 'string' ? v.checkedAt : undefined,
    passed: typeof v.passed === 'boolean' ? v.passed : null,
    tablesTotal: tables.length,
    tablesMatched: tables.filter((x) => x.match === true).length,
  };
}
export const restoreTone = (s: string): Tone =>
  s === 'succeeded' ? 'success' : s === 'failed' ? 'danger' : 'warn';
export const backupTone = (s: string): Tone =>
  s === 'available' ? 'success' : s === 'failed' ? 'danger' : s === 'creating' ? 'warn' : undefined;

/** In-place restore is allowed only after the exact name is typed and the box ticked. */
export const inPlaceReady = (name: string, typed: string, ack: boolean) =>
  ack && typed.trim() === name;

/* ------------------------------------------------------------------ storage */

export const POLICY_ACTIONS = ['read', 'write', 'delete', 'list'] as const;
export const CORS_METHODS = ['GET', 'PUT', 'HEAD'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];
export type CorsMethod = (typeof CORS_METHODS)[number];

export interface PolicyDoc {
  version: 1;
  access: 'private' | 'public-read';
  statements?: {
    effect: 'allow';
    actions: PolicyAction[];
    prefix?: string;
    principal: 'bucket-credentials';
  }[];
  cors?: { origins: string[]; methods: CorsMethod[]; maxAgeSeconds: number }[];
}
export interface PolicyDraft {
  access: 'private' | 'public-read';
  statements: { actions: PolicyAction[]; prefix: string }[];
  cors: { origins: string; methods: CorsMethod[]; maxAge: string }[];
}

export function policyToDraft(p: PolicyDoc): PolicyDraft {
  return {
    access: p.access,
    statements: (p.statements ?? []).map((s) => ({
      actions: [...s.actions],
      prefix: s.prefix ?? '',
    })),
    cors: (p.cors ?? []).map((c) => ({
      origins: c.origins.join('\n'),
      methods: [...c.methods],
      maxAge: String(c.maxAgeSeconds),
    })),
  };
}

/** The document the API accepts (`{version:1, access, statements, cors?}`), or the first thing that is wrong. */
export function draftToPolicy(d: PolicyDraft): {
  policy?: PolicyDoc;
  error?: 'actions' | 'prefix' | 'origins' | 'methods' | 'maxAge';
  index?: number;
} {
  const statements: NonNullable<PolicyDoc['statements']> = [];
  for (const [i, s] of d.statements.entries()) {
    if (s.actions.length === 0) return { error: 'actions', index: i };
    if (/[*?]|\.\./.test(s.prefix) || s.prefix.startsWith('/'))
      return { error: 'prefix', index: i };
    statements.push({
      effect: 'allow',
      actions: POLICY_ACTIONS.filter((a) => s.actions.includes(a)),
      prefix: s.prefix,
      principal: 'bucket-credentials',
    });
  }
  const cors: NonNullable<PolicyDoc['cors']> = [];
  for (const [i, c] of d.cors.entries()) {
    const origins = [
      ...new Set(
        c.origins
          .split(/[\n,]/)
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ];
    if (origins.length === 0 || origins.some((o) => !/^(\*|https?:\/\/[^\s/*]+)$/.test(o)))
      return { error: 'origins', index: i };
    if (c.methods.length === 0) return { error: 'methods', index: i };
    if (!positiveInt(c.maxAge, 86_400)) return { error: 'maxAge', index: i };
    cors.push({
      origins,
      methods: CORS_METHODS.filter((m) => c.methods.includes(m)),
      maxAgeSeconds: Number(c.maxAge),
    });
  }
  return {
    policy: { version: 1, access: d.access, statements, ...(cors.length ? { cors } : {}) },
  };
}

/** Any policy that makes (or keeps) the bucket public goes through the explicit warning and `confirmPublic`; a private policy never does. */
export const needsPublicConfirm = (access: PolicyDoc['access']) => access === 'public-read';

export interface LifecycleCaps {
  expiry?: boolean;
  abortMultipart?: boolean;
  transition?: boolean;
}
export interface LifecycleRuleDraft {
  id: string;
  prefix: string;
  expireDays: string;
  abortDays: string;
  transitionDays: string;
  transitionClass: string;
}
export const emptyRule = (n: number): LifecycleRuleDraft => ({
  id: `rule-${n}`,
  prefix: '',
  expireDays: '',
  abortDays: '',
  transitionDays: '',
  transitionClass: '',
});
export function rulesToDraft(
  rules: {
    id: string;
    prefix: string;
    expireDays?: number;
    abortIncompleteMultipartDays?: number;
    transition?: { days?: number; storageClass?: string };
  }[],
): LifecycleRuleDraft[] {
  return rules.map((r) => ({
    id: r.id,
    prefix: r.prefix,
    expireDays: r.expireDays === undefined ? '' : String(r.expireDays),
    abortDays:
      r.abortIncompleteMultipartDays === undefined ? '' : String(r.abortIncompleteMultipartDays),
    transitionDays: r.transition?.days === undefined ? '' : String(r.transition.days),
    transitionClass: r.transition?.storageClass ?? '',
  }));
}
/** Only fields the provider supports are ever sent (a hidden action is never smuggled in); every rule must do something. */
export function draftToRules(
  drafts: LifecycleRuleDraft[],
  caps: LifecycleCaps,
): { rules?: Record<string, unknown>[]; error?: 'id' | 'empty' | 'days'; index?: number } {
  const rules: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const [i, d] of drafts.entries()) {
    const id = d.id.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || ids.has(id)) return { error: 'id', index: i };
    ids.add(id);
    const r: Record<string, unknown> = { id, prefix: d.prefix };
    if (caps.expiry && d.expireDays.trim()) {
      if (!positiveInt(d.expireDays, 36_500)) return { error: 'days', index: i };
      r.expireDays = Number(d.expireDays);
    }
    if (caps.abortMultipart && d.abortDays.trim()) {
      if (!positiveInt(d.abortDays, 365)) return { error: 'days', index: i };
      r.abortIncompleteMultipartDays = Number(d.abortDays);
    }
    if (caps.transition && d.transitionDays.trim()) {
      if (!positiveInt(d.transitionDays, 36_500) || !d.transitionClass.trim())
        return { error: 'days', index: i };
      r.transition = { days: Number(d.transitionDays), storageClass: d.transitionClass.trim() };
    }
    if (Object.keys(r).length === 2) return { error: 'empty', index: i };
    rules.push(r);
  }
  return { rules };
}

export const SIGNED_METHODS = ['GET', 'HEAD', 'PUT', 'DELETE'] as const;
export const SIGNED_DEFAULT_TTL = 900;
export const SIGNED_MAX_TTL = 604_800;
export function signedUrlBody(f: { key: string; method: string; ttl: string }): {
  body?: { key: string; method: string; ttlSeconds: number };
  error?: 'key' | 'ttl';
} {
  const key = f.key;
  // eslint-disable-next-line no-control-regex
  if (key.length < 1 || key.length > 1024 || /[\u0000-\u001f\u007f]/.test(key))
    return { error: 'key' };
  const ttl = f.ttl.trim() === '' ? SIGNED_DEFAULT_TTL : Number(f.ttl);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > SIGNED_MAX_TTL) return { error: 'ttl' };
  return { body: { key, method: f.method, ttlSeconds: ttl } };
}

/* ------------------------------------------------------------------ email */

export const domainTone = (s: string): Tone =>
  s === 'verified' ? 'success' : s === 'failed' ? 'danger' : 'warn';
export const recordTone = (s: string): Tone =>
  s === 'ok' ? 'success' : s === 'conflict' ? 'danger' : s === 'missing' ? 'warn' : undefined;
export const messageTone = (s: string): Tone =>
  s === 'delivered' || s === 'sent'
    ? 'success'
    : s === 'bounced' || s === 'complained' || s === 'failed'
      ? 'danger'
      : 'warn';
export const mailboxTone = (s: string): Tone =>
  s === 'active' ? 'success' : s === 'failed' || s === 'suspended' ? 'danger' : 'warn';

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  priority?: number;
  purpose: string;
  required: boolean;
  status: string;
  detail?: string;
}
/** Counts per status, for the "3 of 5 records verified" summary. */
export function recordSummary(records: DnsRecord[]) {
  const required = records.filter((r) => r.required);
  return {
    total: required.length,
    ok: required.filter((r) => r.status === 'ok').length,
    conflict: required.filter((r) => r.status === 'conflict').length,
    missing: required.filter((r) => r.status === 'missing').length,
    unknown: required.filter((r) => r.status === 'unknown').length,
  };
}
/** The text a customer pastes into their DNS provider for one record (type, name, value; MX with its priority). */
export const recordLine = (r: DnsRecord) =>
  `${r.type} ${r.name} ${r.priority !== undefined ? `${r.priority} ` : ''}${r.value}`;
/** Automatic apply is offered only when the domain is a Nuzm DNS zone. */
export const canApplyAutomatically = (d: { dnsZoneId?: string | null }) => !!d.dnsZoneId;
/** Domains that can host mailboxes: verified, with the mailbox purpose. */
export const mailboxDomains = <D extends { state: string; purposes: string[] }>(ds: D[]) =>
  ds.filter((d) => d.state === 'verified' && d.purposes.includes('mailbox'));
export const senderDomains = <D extends { purposes: string[] }>(ds: D[]) =>
  ds.filter((d) => d.purposes.includes('transactional'));

export const MAILBOX_QUOTA_MIN = 100;
export const MAILBOX_QUOTA_MAX = 1_048_576;
export const validQuotaMb = (v: string) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= MAILBOX_QUOTA_MIN && n <= MAILBOX_QUOTA_MAX;
};

/** Hard bounces and complaints protect the sender's reputation: removing them needs an explicit override. */
export const isProtectiveReason = (reason: string) =>
  reason === 'bounce_hard' || reason === 'complaint';

/* templates */

const PH = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,40})\s*\}\}/g;
export const detectPlaceholders = (...parts: string[]): string[] => [
  ...new Set(parts.flatMap((p) => [...p.matchAll(PH)].map((m) => m[1]!))),
];
export type VarConfig = Record<string, { type: 'string' | 'number'; required: boolean }>;
/** A schema with exactly the detected placeholders (kept settings where the user already chose them). */
export function variablesFor(detected: string[], current: VarConfig): VarConfig {
  const out: VarConfig = {};
  for (const n of detected) out[n] = current[n] ?? { type: 'string', required: true };
  return out;
}
/** The document an iframe renders for a preview: a locked-down page (no network, no script) in the template's direction. */
export function previewDoc(html: string, locale: 'ar' | 'en'): string {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><base target="_blank"><style>body{font:16px/1.6 system-ui,sans-serif;margin:16px;color:#111827;background:#fff}</style></head><body>${html}</body></html>`;
}
/** Latest version of each key first (the list API is newest-first, so the first row of a key is its latest). */
export function groupTemplates<T extends { key: string; version: number }>(items: T[]) {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(i.key, [...(m.get(i.key) ?? []), i]);
  return [...m.entries()].map(([key, versions]) => ({
    key,
    versions: [...versions].sort((a, b) => b.version - a.version),
  }));
}
/** Field errors of a 422 keyed by variable name (`variables.name`) so the editor can mark the right row. */
export function variableErrors(p: ProblemInfo): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of p.fieldErrors) {
    const m = e.field ? /^variables\.(.+)$/.exec(e.field) : null;
    if (m) out[m[1]!] = e.message ?? '';
  }
  return out;
}
