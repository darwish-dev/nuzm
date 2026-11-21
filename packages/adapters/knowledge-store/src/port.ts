import type { Readable } from 'node:stream';

/**
 * Object-store port of the AI Intelligence Center (ADR-065, D-42). Archives are content addressed (`archives/<sha256>`), snapshot files too
 * (`snapshots/<sha256>`); an object is never overwritten. Keys are relative, lower-case and slash separated; an adapter refuses anything else.
 */
export interface ComposedObject {
  key: string;
  sha256: string;
  bytes: number;
  deduplicated: boolean;
}
export type ComposeResult = ComposedObject | { mismatch: true; sha256: string; bytes: number };

export abstract class KnowledgeObjectStore {
  /** Stores one part of an upload (idempotent for the same bytes). */
  abstract putPart(uploadId: string, partNumber: number, data: Buffer): Promise<void>;
  /** Concatenates the parts in order into a content-addressed archive; the checksum is verified BEFORE the object becomes visible under its final key. */
  abstract compose(
    uploadId: string,
    partNumbers: number[],
    expectedSha256: string,
  ): Promise<ComposeResult>;
  /** Removes every part and temporary object of one upload. Never touches content-addressed objects. */
  abstract discardUpload(uploadId: string): Promise<void>;

  abstract exists(key: string): Promise<boolean>;
  /** Size in bytes, or null when the object does not exist. */
  abstract size(key: string): Promise<number | null>;
  /** The whole object in memory: for small objects only (callers check `size` first). */
  abstract read(key: string): Promise<Buffer>;
  /** A stream of the whole object. */
  abstract open(key: string): Promise<Readable>;
  /** `length` bytes from `offset` (clamped to the object). */
  abstract readRange(key: string, offset: number, length: number): Promise<Buffer>;
  /** Writes an object; with `ifAbsent` an existing object is left untouched (content-addressed writes). Returns whether it already existed. */
  abstract put(
    key: string,
    data: Buffer,
    opts?: { ifAbsent?: boolean },
  ): Promise<{ existed: boolean }>;
  abstract delete(key: string): Promise<void>;
  /** Short-lived read access for a staff download (the object stays private). */
  abstract signedUrl(
    key: string,
    ttlSeconds: number,
    opts?: { filename?: string },
  ): Promise<string>;
}

export class ObjectStoreError extends Error {
  constructor(
    readonly code:
      | 'invalid_key'
      | 'not_found'
      | 'encryption_not_applied'
      | 'unavailable'
      | 'rejected'
      | 'config',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ObjectStoreError';
  }
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,380}$/;
export const checkKey = (key: string): string => {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//'))
    throw new ObjectStoreError('invalid_key', 'invalid object key');
  return key;
};
