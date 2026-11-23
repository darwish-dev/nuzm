import { ArchiveRejected, type ExtractLimits } from './errors';

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
// bidi controls, zero-width characters, BOM, line/paragraph separators: invisible characters that make a name look different from what it is
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u2028\u2029]/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export interface CheckedPath {
  /** The path as stored and shown (no leading or trailing slash, `/` separators). */
  path: string;
  /** Normalised comparison key: Unicode NFKC + lower case. Two entries with the same key would collide on a case-insensitive or normalising file system. */
  key: string;
  isDirectory: boolean;
}

/**
 * Validates the name of one archive entry. Rejects (never repairs): absolute and drive paths, `..` and `.` segments, backslashes, NUL and control characters, invisible
 * and bidirectional-override characters, trailing dots or spaces and reserved device names (Windows), over-long names and over-deep paths.
 */
export function checkEntryPath(raw: string, limits: ExtractLimits): CheckedPath {
  if (raw.length === 0) throw new ArchiveRejected('path_invalid', 'an entry has an empty name');
  if (raw.includes('\uFFFD'))
    throw new ArchiveRejected('path_invalid', 'an entry name is not valid UTF-8');
  if (CONTROL.test(raw))
    throw new ArchiveRejected('path_invalid', 'an entry name contains a control character');
  if (INVISIBLE.test(raw))
    throw new ArchiveRejected(
      'path_invalid',
      'an entry name contains an invisible or bidirectional-override character',
    );
  if (raw.includes('\\'))
    throw new ArchiveRejected('path_invalid', 'an entry name contains a backslash');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw))
    throw new ArchiveRejected('path_traversal', 'an entry has an absolute or drive path');
  const isDirectory = raw.endsWith('/');
  const trimmed = isDirectory ? raw.slice(0, -1) : raw;
  if (trimmed.length === 0) throw new ArchiveRejected('path_invalid', 'an entry has an empty name');
  if (Buffer.byteLength(trimmed, 'utf8') > limits.maxPathBytes)
    throw new ArchiveRejected('path_invalid', `a path is longer than ${limits.maxPathBytes} bytes`);
  const segments = trimmed.split('/');
  if (segments.length > limits.maxDepth)
    throw new ArchiveRejected('too_deep', `a path is deeper than ${limits.maxDepth} levels`);
  for (const s of segments) {
    if (s === '')
      throw new ArchiveRejected('path_invalid', 'an entry name contains an empty path segment');
    if (s === '..')
      throw new ArchiveRejected('path_traversal', 'an entry climbs out of the package with ".."');
    if (s === '.')
      throw new ArchiveRejected('path_invalid', 'an entry name contains a "." segment');
    if (Buffer.byteLength(s, 'utf8') > limits.maxNameBytes)
      throw new ArchiveRejected(
        'path_invalid',
        `a file name is longer than ${limits.maxNameBytes} bytes`,
      );
    if (/[. ]$/.test(s))
      throw new ArchiveRejected('path_invalid', 'an entry name ends with a dot or a space');
    if (WINDOWS_RESERVED.test(s))
      throw new ArchiveRejected('path_invalid', 'an entry uses a reserved device name');
  }
  return { path: trimmed, key: trimmed.normalize('NFKC').toLowerCase(), isDirectory };
}

/** Tracks the names seen in one extraction and refuses two that collide (case, Unicode form) or a file that shares a name with a directory. */
export class PathRegistry {
  private readonly files = new Set<string>();
  private readonly dirs = new Set<string>();
  add(p: CheckedPath): void {
    const parts = p.key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (this.files.has(parent))
        throw new ArchiveRejected(
          'path_collision',
          'an entry is inside a path that is also a file',
        );
      this.dirs.add(parent);
    }
    if (p.isDirectory) {
      if (this.files.has(p.key))
        throw new ArchiveRejected('path_collision', 'a directory has the same name as a file');
      this.dirs.add(p.key);
      return;
    }
    if (this.files.has(p.key))
      throw new ArchiveRejected(
        'path_collision',
        'two entries have the same name once case and Unicode form are ignored',
      );
    if (this.dirs.has(p.key))
      throw new ArchiveRejected('path_collision', 'a file has the same name as a directory');
    this.files.add(p.key);
  }
}
