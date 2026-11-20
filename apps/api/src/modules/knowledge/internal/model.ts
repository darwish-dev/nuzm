import { v7 as uuidv7 } from 'uuid';
import { ProblemException } from '../../../common/errors';

/** AI Intelligence Center (ADR-065, SCR-K-01): shared vocabulary, limits and pure validation of the library. */
export type Row = Record<string, unknown>;
export const newId = (): string => uuidv7();
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
export const SHA256_RE = /^[0-9a-f]{64}$/;

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
export const STATES = [
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
export const REUSE_SCOPES = ['NONE', 'ARCHITECTURE_ONLY', 'COMPONENTS', 'FULL_STARTER'] as const;
export const LICENSE_VERDICTS = ['ALLOWED', 'RESTRICTED', 'UNKNOWN', 'BLOCKED'] as const;

/**
 * Platform hard caps of an upload. They are constants until the engine settings (SCR-K-01, slice S-K5) exist; the settings can only lower them.
 * The ingestion limits that guard extraction (entries, extracted bytes, ratio, depth) belong to the validation stage (S-K2), not to the upload.
 */
export const UPLOAD_LIMITS = {
  maxBytes: 2 * 1024 ** 3,
  defaultPartSize: 8 * 1024 ** 2,
  minPartSize: 256 * 1024,
  maxPartSize: 64 * 1024 ** 2,
  maxParts: 10_000,
  ttlMs: 24 * 3600 * 1000,
  maxOpenPerStaff: 20,
} as const;

/**
 * What a library upload may be called. A package is an archive (source), a document, or an image reference. Everything is data until the validation stage has
 * opened it; nothing here is ever executed. Executables and scripts are refused outright; SVG is refused because it can carry script.
 */
export const ALLOWED_UPLOAD_SUFFIXES = [
  '.zip',
  '.tar.gz',
  '.tgz',
  '.md',
  '.markdown',
  '.txt',
  '.pdf',
  '.docx',
  '.json',
  '.yaml',
  '.yml',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
] as const;

/** A file name as the browser sent it: no path, no control characters, no hidden or doubled-suffix tricks, an allow-listed suffix. */
export function validateFilename(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 255)
    throw new ProblemException('validation_failed', 'filename must be 1 to 255 characters');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
  if (/[\\/\u0000-\u001f\u007f]/.test(raw) || raw.startsWith('.') || raw.includes('..'))
    throw new ProblemException(
      'knowledge_archive_rejected',
      'the file name must not contain a path, control characters or leading dots',
    );
  const lower = raw.toLowerCase();
  const suffix = ALLOWED_UPLOAD_SUFFIXES.find((s) => lower.endsWith(s));
  if (!suffix)
    throw new ProblemException(
      'knowledge_archive_rejected',
      `this file type is not accepted (allowed: ${ALLOWED_UPLOAD_SUFFIXES.join(' ')})`,
    );
  return raw;
}

export const oneOf = <T extends string>(
  list: readonly T[],
  v: unknown,
  field: string,
  optional = false,
): T | undefined => {
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new ProblemException('validation_failed', `${field} is required`);
  }
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v))
    throw new ProblemException('validation_failed', `${field} must be one of ${list.join(', ')}`);
  return v as T;
};

export const text = (v: unknown, field: string, max: number, optional = true): string | null => {
  if (v === undefined || v === null) {
    if (optional) return null;
    throw new ProblemException('validation_failed', `${field} is required`);
  }
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max)
    throw new ProblemException('validation_failed', `${field} must be 1 to ${max} characters`);
  return v.trim();
};

export const stringList = (v: unknown, field: string, maxItems = 30, maxLen = 60): string[] => {
  if (v === undefined || v === null) return [];
  if (
    !Array.isArray(v) ||
    v.length > maxItems ||
    v.some((x) => typeof x !== 'string' || x.length < 1 || x.length > maxLen)
  )
    throw new ProblemException(
      'validation_failed',
      `${field} must be a list of up to ${maxItems} short strings`,
    );
  return [...new Set(v.map((x) => (x as string).trim()))];
};

/** A URL-safe, lower-case slug from a free name; Arabic-only names fall back to a neutral stem (the unique suffix is added by the caller). */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'resource';
}

export interface ResourceDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  resourceType: string;
  platform: string | null;
  frameworks: string[];
  languages: string[];
  category: string | null;
  tags: string[];
  visibility: string;
  sourceKind: string;
  status: string;
  currentVersionId: string | null;
  defaultEligible: boolean;
  dataRegion: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export const toResource = (r: Row): ResourceDto => ({
  id: r.id as string,
  name: r.name as string,
  slug: r.slug as string,
  description: (r.description as string | null) ?? null,
  resourceType: r.resource_type as string,
  platform: (r.platform as string | null) ?? null,
  frameworks: (r.frameworks as string[]) ?? [],
  languages: (r.languages as string[]) ?? [],
  category: (r.category as string | null) ?? null,
  tags: (r.tags as string[]) ?? [],
  visibility: r.visibility as string,
  sourceKind: r.source_kind as string,
  status: r.status as string,
  currentVersionId: (r.current_version_id as string | null) ?? null,
  defaultEligible: r.default_eligible as boolean,
  dataRegion: r.data_region as string,
  createdAt: (r.created_at as Date).toISOString(),
  updatedAt: (r.updated_at as Date).toISOString(),
  version: Number(r.version),
});
