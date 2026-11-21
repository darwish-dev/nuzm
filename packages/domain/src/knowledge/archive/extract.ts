import { ArchiveRejected, DEFAULT_LIMITS, type ExtractLimits } from './errors';
import { PathRegistry } from './paths';
import { extractTarGz } from './tar';
import type { ArchiveSource, ExtractContext, ExtractHandlers, ExtractSummary } from './types';
import { extractZip } from './zip';

export type ArchiveFormat = 'zip' | 'tar.gz';
/** Sniffs the format from the bytes, never from the file name or the declared content type. */
export async function detectFormat(src: ArchiveSource): Promise<ArchiveFormat> {
  const head = await src.readRange(0, Math.min(4, src.size));
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tar.gz';
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'zip';
  // an archive with no entries starts with the end-of-directory record; anything else is not an accepted format
  if (head.length >= 4 && head.readUInt32LE(0) === 0x06054b50) return 'zip';
  throw new ArchiveRejected('unsupported_format', 'only ZIP and tar.gz archives are accepted');
}

export async function extractArchive(
  src: ArchiveSource,
  handlers: ExtractHandlers,
  opts: { limits?: Partial<ExtractLimits>; now?: () => number } = {},
): Promise<ExtractSummary> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  if (src.size === 0) throw new ArchiveRejected('corrupt', 'the archive is empty');
  const ctx: ExtractContext = {
    limits,
    deadline: now() + limits.maxMillis,
    registry: new PathRegistry(),
    now,
    total: 0,
  };
  const format = await detectFormat(src);
  return format === 'zip' ? extractZip(src, handlers, ctx) : extractTarGz(src, handlers, ctx);
}

export { ArchiveRejected, DEFAULT_LIMITS } from './errors';
export type { ArchiveRejectCode, ExtractLimits } from './errors';
export type { ArchiveSource, EntryInfo, Decision, ExtractHandlers, ExtractSummary } from './types';
export { classifyContent, isText, isSensitivePath, isNoisePath, languageOf } from './filetype';
export type { FileKind, FileClass } from './filetype';
export { checkEntryPath } from './paths';
export { parseZipDirectory } from './zip';
