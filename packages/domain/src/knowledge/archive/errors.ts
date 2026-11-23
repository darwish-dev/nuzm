/**
 * Safe archive extraction for the AI Intelligence Center (ADR-065, S-K2a). Uploaded packages are HOSTILE data: this library parses bytes with pure functions and hard
 * limits and never executes, imports, installs or follows anything it finds. A rule violation rejects the WHOLE package with a stable code and an actionable detail
 * (never the content of a file).
 */
export type ArchiveRejectCode =
  | 'unsupported_format'
  | 'too_many_entries'
  | 'too_large'
  | 'file_too_large'
  | 'ratio_exceeded'
  | 'path_invalid'
  | 'path_traversal'
  | 'path_collision'
  | 'too_deep'
  | 'symlink'
  | 'hardlink'
  | 'special_file'
  | 'encrypted'
  | 'unsupported_method'
  | 'corrupt'
  | 'overlap'
  | 'size_mismatch'
  | 'crc_mismatch'
  | 'timeout'
  | 'cancelled';

export class ArchiveRejected extends Error {
  constructor(
    readonly code: ArchiveRejectCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ArchiveRejected';
  }
}

export interface ExtractLimits {
  maxEntries: number;
  /** Sum of the uncompressed sizes of all files. */
  maxTotalBytes: number;
  maxFileBytes: number;
  /** Per entry: uncompressed / compressed, enforced for entries above `ratioFloorBytes`. */
  maxEntryRatio: number;
  /** Whole archive: uncompressed total / archive size, enforced above `ratioFloorBytes` in total. */
  maxTotalRatio: number;
  ratioFloorBytes: number;
  maxDepth: number;
  maxPathBytes: number;
  maxNameBytes: number;
  /** Largest central directory / tar metadata block accepted. */
  maxMetadataBytes: number;
  /** Wall-clock budget of one extraction. */
  maxMillis: number;
}
export const DEFAULT_LIMITS: ExtractLimits = {
  maxEntries: 50_000,
  maxTotalBytes: 2 * 1024 ** 3,
  maxFileBytes: 256 * 1024 ** 2,
  maxEntryRatio: 100,
  maxTotalRatio: 50,
  ratioFloorBytes: 10 * 1024 ** 2,
  maxDepth: 32,
  maxPathBytes: 400,
  maxNameBytes: 255,
  maxMetadataBytes: 64 * 1024 ** 2,
  maxMillis: 10 * 60_000,
};
