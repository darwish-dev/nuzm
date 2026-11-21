import type { Readable } from 'node:stream';
import { PathRegistry } from './paths';
import type { ExtractLimits } from './errors';

/** Random access to an archive (a file, an object-store object with range reads, or memory) plus a sequential stream of the same bytes. */
export interface ArchiveSource {
  size: number;
  readRange(offset: number, length: number): Promise<Buffer>;
  openStream(): Promise<Readable>;
}
export interface EntryInfo {
  path: string;
  /** Uncompressed size as declared by the archive (verified while reading). */
  size: number;
  compressedSize?: number;
  /** The Unix executable bit was set (ZIP made on Unix, tar mode). */
  unixExecutable: boolean;
}
export type Decision = 'read' | { skip: string };
export interface ExtractHandlers {
  /** Called for every regular file BEFORE any of its data is read. */
  decide(e: EntryInfo): Decision;
  /** Receives the data of a file chosen with `decide`; the extractor drains whatever is left unread so size, CRC and limits are always verified. */
  onFile(e: EntryInfo, data: AsyncIterable<Buffer>): Promise<void>;
  shouldCancel?(): boolean;
}
export interface ExtractSummary {
  format: 'zip' | 'tar.gz';
  entries: number;
  files: number;
  directories: number;
  /** Bytes actually read from files (after decompression). */
  bytes: number;
  skipped: { path: string; reason: string }[];
}
export interface ExtractContext {
  limits: ExtractLimits;
  deadline: number;
  registry: PathRegistry;
  now: () => number;
  /** Bytes read so far across all files. */
  total: number;
}
