import { createHash } from 'node:crypto';

/**
 * ARTIFACT TRANSPORT CONTRACT: the narrow port the deploy module needs to put a built static site on a hosting node, written so that the hosting line can implement it WITHOUT
 * importing anything from the deploy module. Everything here is structural (plain data and a plain interface) plus the few pure rules both sides must share: the manifest
 * hash, the path and release-id rules, the bounds and the error codes. The specification is `docs/parallel/HOST-TRANSPORT-SPEC.md`; the shared test is
 * `./conformance.ts`; the executable reference is the SIMULATED in-memory transport of the deploy module.
 *
 * Nothing in this file talks to a node. A result that comes from a stand-in is SIMULATED and proves the contract and the wiring, never what a real node does.
 */

/** A site as the transport sees it: only `id` addresses the node; the rest is carried for audit and labels. Structurally equal to the deploy module's `TargetSite`. */
export interface TransportSite {
  id: string;
  name: string;
  status: string;
  runtime: string;
  dataRegion: string;
  domain: string | null;
}
export interface TransportFile {
  /** relative, `/`-separated, NFC, see `assertArtifactPath` */
  path: string;
  mime: string;
  content: Uint8Array;
}
export interface TransportArtifact {
  /** the manifest hash of `files` (`artifactManifestHash`) */
  hash: string;
  files: TransportFile[];
}
export interface ReleaseInfo {
  releaseId: string;
  /** recomputed from what was written */
  hash: string;
  files: number;
  bytes: number;
}

export interface ArtifactTransportPort {
  /** true for any stand-in: every result it gives is SIMULATED. A real transport answers false only after its live verification. */
  readonly simulated: boolean;
  /** Write the whole tree under a NEW release; never touches the live document root. Idempotent for identical content; a different tree under an existing id is `release_exists`. */
  putRelease(
    site: TransportSite,
    releaseId: string,
    artifact: TransportArtifact,
  ): Promise<ReleaseInfo>;
  /** The manifest hash recomputed FROM THE NODE, never from what was sent; `null` when the release does not exist. */
  readReleaseHash(site: TransportSite, releaseId: string): Promise<string | null>;
  /** Make the release the served document root; returns the release that was served before (`null` the first time). Unknown release: `release_not_found`, nothing changes. */
  switchCurrent(
    site: TransportSite,
    releaseId: string,
  ): Promise<{ previousReleaseId: string | null }>;
  /** The release being served, read from the node (`null` before the first switch). */
  currentRelease(site: TransportSite): Promise<string | null>;
  /** HTTP status of `path` served from a staged release or from the live site: plain HTTPS from the platform, status code only. */
  probe(
    site: TransportSite,
    where: { release: string } | 'live',
    path: string,
  ): Promise<{ status: number }>;
  hasRelease(site: TransportSite, releaseId: string): Promise<boolean>;
  /** Delete a release; the live one is `live_release_protected`; a missing one is a no-op (idempotent). */
  removeRelease(site: TransportSite, releaseId: string): Promise<void>;
  /** Release ids, OLDEST FIRST (creation order). */
  listReleases(site: TransportSite): Promise<string[]>;
}

// ---- error codes ------------------------------------------------------------------------------------------------------------------------------------------------------------
export const TRANSPORT_ERROR_CODES = [
  /** the site is missing, or belongs to another organization (the two are indistinguishable by design) */
  'site_not_found',
  'release_not_found',
  /** a release with this id exists and holds a DIFFERENT tree */
  'release_exists',
  /** the live release may not be removed */
  'live_release_protected',
  'invalid_release_id',
  /** an artifact path breaks `assertArtifactPath` (traversal, absolute, symlink-like, control character, duplicate) */
  'invalid_path',
  'empty_artifact',
  /** more files, more bytes or a bigger file than the bounds; includes the plan's disk quota */
  'limit_exceeded',
  /** the node is not connected / the path is not available (the unavailable transport answers this to every call, it never silently succeeds) */
  'node_unavailable',
  /** the write was cut short or the node answered nonsense; no partial release is left visible */
  'transfer_failed',
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

export class ArtifactTransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactTransportError';
  }
}

// ---- bounds ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface TransportLimits {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
}
/** PROPOSED (not decided; the hosting line's per-plan upload limit is 25 MB per file, ceiling 60 MB): a deployment is bounded by tree, not only by file. */
export const DEFAULT_TRANSPORT_LIMITS: TransportLimits = {
  maxFiles: 2000,
  maxBytes: 60 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
};

// ---- the shared pure rules ------------------------------------------------------------------------------------------------------------------------------------------
/**
 * Manifest hash: sha256 over, for each file in ascending `path` order (UTF-16 code-unit order, i.e. the plain `<` of JavaScript strings),
 * `path + "\0" + sha256hex(content) + "\n"`. Identical to the deploy module's `artifactHash`.
 */
export const artifactManifestHash = (files: { path: string; content: Uint8Array }[]): string => {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1)))
    h.update(`${f.path}\0${createHash('sha256').update(f.content).digest('hex')}\n`);
  return h.digest('hex');
};

/** `<lowercase alphanumerics and dashes>`, 8 to 64 characters, starting with an alphanumeric. A deployment id (UUID) fits; `current`, `..` and path fragments do not. */
const RELEASE_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
const RESERVED_RELEASE_IDS = new Set(['current', 'releases']);
export function assertReleaseId(id: string): void {
  if (typeof id !== 'string' || !RELEASE_ID.test(id) || RESERVED_RELEASE_IDS.has(id))
    throw new ArtifactTransportError(
      'invalid_release_id',
      'release id must be 8-64 characters of a-z, 0-9 and "-"',
    );
}

/**
 * An artifact path is relative, `/`-separated, NFC-normalised UTF-8, at most 512 bytes and 8 levels deep; no empty, `.` or `..` segment, no leading `/`, no `\`, no control
 * character (including NUL), no segment of only dots, none ending in `/`. Symlinks cannot be expressed (a file is bytes). The hosting file-manager guard refuses a symlink anywhere
 * on a path, so a path that survives this check can never need one.
 */
export function assertArtifactPath(p: string): void {
  const bad = (why: string): never => {
    throw new ArtifactTransportError('invalid_path', `artifact path refused: ${why}`);
  };
  if (typeof p !== 'string' || p.length === 0) return bad('empty');
  if (p !== p.normalize('NFC')) return bad('not NFC');
  if (new TextEncoder().encode(p).byteLength > 512) return bad('longer than 512 bytes');
  if (p.startsWith('/')) return bad('absolute');
  if (p.includes('\\')) return bad('backslash');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
  if (/[\u0000-\u001f\u007f]/.test(p)) return bad('control character');
  const segs = p.split('/');
  if (segs.length > 8) return bad('deeper than 8 levels');
  for (const s of segs) {
    if (s === '') return bad('empty segment');
    if (/^\.+$/.test(s)) return bad('"." or ".." segment');
  }
}

/** Validate a whole artifact against the shared rules and the bounds (the transport calls this BEFORE writing a byte). Case-insensitive duplicates are refused too (a node may fold case). */
export function assertArtifactAcceptable(
  artifact: TransportArtifact,
  limits: TransportLimits = DEFAULT_TRANSPORT_LIMITS,
): { files: number; bytes: number } {
  if (artifact.files.length === 0)
    throw new ArtifactTransportError('empty_artifact', 'an artifact needs at least one file');
  if (artifact.files.length > limits.maxFiles)
    throw new ArtifactTransportError(
      'limit_exceeded',
      `more than ${limits.maxFiles} files in one deployment`,
    );
  const seen = new Set<string>();
  let bytes = 0;
  for (const f of artifact.files) {
    assertArtifactPath(f.path);
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new ArtifactTransportError('invalid_path', 'duplicate path');
    seen.add(key);
    if (f.content.byteLength > limits.maxFileBytes)
      throw new ArtifactTransportError(
        'limit_exceeded',
        'a file is bigger than the per-file bound',
      );
    bytes += f.content.byteLength;
  }
  if (bytes > limits.maxBytes)
    throw new ArtifactTransportError(
      'limit_exceeded',
      'the tree is bigger than the per-deployment bound',
    );
  if (artifactManifestHash(artifact.files) !== artifact.hash)
    throw new ArtifactTransportError(
      'transfer_failed',
      'the artifact hash does not match its files',
    );
  return { files: artifact.files.length, bytes };
}
