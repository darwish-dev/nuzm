/** AI Intelligence Center admin helpers (ADR-065, slice S-K1): shapes of the API, filter parsing, list and size formatting. No I/O. */
export const RESOURCE_TYPES = [
  'PROJECT',
  'THEME',
  'COMPONENT_LIBRARY',
  'DESIGN_SYSTEM',
  'DOCUMENTATION',
  'API_SPECIFICATION',
  'DATABASE_SCHEMA',
  'STARTER_KIT',
  'REUSABLE_MODULE',
] as const;
export const PLATFORMS = ['WEB', 'MOBILE', 'BACKEND', 'FULL_STACK', 'CROSS_PLATFORM'] as const;
export const STATUSES = [
  'UPLOADING',
  'QUARANTINED',
  'VALIDATING',
  'ANALYZING',
  'INDEXING',
  'AWAITING_REVIEW',
  'ACTIVE',
  'FAILED',
  'DISABLED',
  'ARCHIVED',
] as const;
export const VISIBILITIES = ['PLATFORM_PRIVATE', 'PLATFORM_PUBLISHED'] as const;
export const LICENSE_VERDICTS = ['ALLOWED', 'RESTRICTED', 'UNKNOWN', 'BLOCKED'] as const;
export const REUSE_SCOPES = ['NONE', 'ARCHITECTURE_ONLY', 'COMPONENTS', 'FULL_STARTER'] as const;

export interface KnowledgeResource {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  resourceType: (typeof RESOURCE_TYPES)[number];
  platform: (typeof PLATFORMS)[number] | null;
  frameworks: string[];
  languages: string[];
  category: string | null;
  tags: string[];
  visibility: (typeof VISIBILITIES)[number];
  sourceKind: string;
  status: (typeof STATUSES)[number];
  currentVersionId: string | null;
  defaultEligible: boolean;
  dataRegion: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface KnowledgePage {
  items: KnowledgeResource[];
  nextCursor: string | null;
}
export interface KnowledgePermissions {
  reuseScope: (typeof REUSE_SCOPES)[number];
  aiProcessing: boolean;
  componentReuse: boolean;
  starterEligible: boolean;
  architectureReference: boolean;
  licenseSpdx: string | null;
  licenseVerdict: (typeof LICENSE_VERDICTS)[number];
}
export interface KnowledgeJob {
  id: string;
  kind: string;
  state: string;
  attempt: number;
  progress: number;
  errorCode: string | null;
  errorDetail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface KnowledgeDetail extends KnowledgeResource {
  permissions: KnowledgePermissions | null;
  currentVersion: {
    id: string;
    seq: number;
    state: string;
    licenseVerdict: string;
    bytes: number;
    checksumSha256: string;
  } | null;
  manifest: {
    schemaVersion: string;
    frameworks: string[];
    languages: string[];
    modules: string[];
    components: string[];
    capabilities: { name: string; confidence: number; evidence: unknown[] }[];
  } | null;
  quality: {
    dimension: string;
    score: number | null;
    method: string;
    evidenceRef: string | null;
    measured: boolean;
  }[];
  componentCount: number;
  jobs: KnowledgeJob[];
}
export interface KnowledgeVersion {
  id: string;
  seq: number;
  semver: string | null;
  state: string;
  checksumSha256: string;
  bytes: number;
  sourceCommit: string | null;
  licenseVerdict: string;
  createdAt: string | null;
  activatedAt: string | null;
}

export interface LibraryFilters {
  type?: string;
  status?: string;
  platform?: string;
  framework?: string;
  q?: string;
  cursor?: string;
}
const oneOf = (list: readonly string[], v: unknown) =>
  typeof v === 'string' && list.includes(v) ? v : undefined;
const clean = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** Reads the filters from the page's search params, dropping anything that is not a known value (the API would answer 422 for it). */
export function parseFilters(sp: Record<string, string | string[] | undefined>): LibraryFilters {
  const first = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]);
  return {
    type: oneOf(RESOURCE_TYPES, first('type')),
    status: oneOf(STATUSES, first('status')),
    platform: oneOf(PLATFORMS, first('platform')),
    framework: clean(first('framework'), 60),
    q: clean(first('q'), 100),
    cursor: clean(first('cursor'), 200),
  };
}
/** The query the API takes; empty values are left out. */
export const filtersToQuery = (f: LibraryFilters, limit = 25) =>
  Object.fromEntries(
    Object.entries({ ...f, limit }).filter(([, v]) => v !== undefined && v !== ''),
  ) as Record<string, string | number>;
/** The same filters as a URL query string (for the filter form, paging links and reset). */
export const filtersToSearch = (f: LibraryFilters, extra: Record<string, string> = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** "a, b ,a" → ["a","b"] (what the API takes for tags, frameworks and languages). */
export const splitList = (s: string): string[] => [
  ...new Set(
    s
      .split(/[,،]/)
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];

export function formatBytes(n: number, locale: 'ar' | 'en' = 'en'): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const num = new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en', {
    maximumFractionDigits: i === 0 ? 0 : 1,
  }).format(v);
  return `${num} ${units[i]}`;
}

/** The status colour of a badge. */
export const statusTone = (s: string): 'success' | 'danger' | 'warn' | undefined =>
  s === 'ACTIVE'
    ? 'success'
    : s === 'FAILED'
      ? 'danger'
      : s === 'QUARANTINED' || s === 'AWAITING_REVIEW' || s === 'DISABLED'
        ? 'warn'
        : undefined;
export const licenseTone = (s: string): 'success' | 'danger' | 'warn' | undefined =>
  s === 'ALLOWED'
    ? 'success'
    : s === 'BLOCKED'
      ? 'danger'
      : s === 'RESTRICTED' || s === 'UNKNOWN'
        ? 'warn'
        : undefined;

export const isUuidLike = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

// ---- S-K2a: ingestion, review and activation (SCR-K-02) ----------------------------------------------------------------------------------
export interface IngestJob {
  id: string;
  versionId: string;
  versionSeq: number;
  kind: string;
  state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'DEAD_LETTER';
  attempt: number;
  maxAttempts: number;
  progress: number;
  errorCode: string | null;
  errorDetail: string | null;
  cancelRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
}
export interface IngestLog {
  id: string;
  seq: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  stage: string;
  code: string;
  message: string;
  createdAt: string | null;
}
export interface IngestFinding {
  id: string;
  scanner: string;
  code: string;
  severity: 'info' | 'warn' | 'block';
  path: string | null;
  line: number | null;
  detail: string;
}
export interface IngestFile {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
  language: string | null;
  isBinary: boolean;
  isExecutable: boolean;
  stored: boolean;
  secretFindings: number;
}
export interface ReviewBlocker {
  code:
    | 'state'
    | 'not_analyzed'
    | 'blocking_findings'
    | 'license_not_allowed'
    | 'rejected'
    | 'approvals_missing';
  detail: string;
}
export interface ReviewState {
  versionId: string;
  resourceId: string;
  state: string;
  stateReason: string | null;
  provenanceClass: 'FIRST_PARTY' | 'THIRD_PARTY';
  uploadedBy: string | null;
  analysisJobId: string | null;
  licenseProposal: { spdx: string | null; verdict: string; reason?: string } | null;
  licenseVerdict: string;
  findings: { info: number; warn: number; block: number };
  requiredApprovals: number;
  approvals: string[];
  reviews: {
    id: string;
    decision: 'APPROVE' | 'REJECT';
    reviewerId: string;
    reason: string | null;
    createdAt: string | null;
  }[];
  blockers: ReviewBlocker[];
  canActivate: boolean;
  you: { canReview: boolean; hasApproved: boolean; isUploader: boolean };
}
/** Reasons the UI has a translation for; any other `stateReason` is an archive rejection code, shown with the generic text and the code itself. */
export const KNOWN_REASONS = [
  'secrets_found',
  'license_blocked',
  'denied_dependency',
  'install_script_network',
  'blocking_findings',
  'cancelled',
  'rejected',
  'processing_failed',
  'archive_missing',
] as const;
export const isKnownReason = (r: string): r is (typeof KNOWN_REASONS)[number] =>
  (KNOWN_REASONS as readonly string[]).includes(r);
export const severityTone = (s: string): 'success' | 'danger' | 'warn' | undefined =>
  s === 'block' ? 'danger' : s === 'warn' ? 'warn' : undefined;
export const jobTone = (s: string): 'success' | 'danger' | 'warn' | undefined =>
  s === 'SUCCEEDED'
    ? 'success'
    : s === 'FAILED' || s === 'DEAD_LETTER'
      ? 'danger'
      : s === 'CANCELLED'
        ? 'warn'
        : undefined;
/** Jobs that can still be asked to stop. */
export const isCancellable = (j: Pick<IngestJob, 'state' | 'cancelRequested'>) =>
  (j.state === 'QUEUED' || j.state === 'RUNNING') && !j.cancelRequested;
/** A version whose processing was interrupted (not rejected) can be queued again. */
export const isRetryable = (v: { state: string }, reason: string | null) =>
  (v.state === 'FAILED' || v.state === 'QUARANTINED') &&
  !!reason &&
  ['processing_failed', 'archive_missing', 'cancelled'].includes(reason);
