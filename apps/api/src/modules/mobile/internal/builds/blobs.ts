import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../core';

/** Where artifact bytes live (production: the M08 object store bucket in the project's region: NOT CONNECTED, so `UnavailableArtifactStore` fails honestly). */
export abstract class ArtifactBytesPort {
  abstract readonly kind: string;
  abstract put(orgId: string, buildId: string, fileName: string, bytes: Buffer): Promise<{ storageRef: string; sha256: string }>;
  abstract get(storageRef: string): Promise<Buffer | null>;
}
export class MemoryArtifactBytes extends ArtifactBytesPort {
  readonly kind = 'memory';
  readonly blobs = new Map<string, Buffer>();
  async put(orgId: string, buildId: string, fileName: string, bytes: Buffer) {
    const ref = `mem://${orgId}/${buildId}/${fileName}`;
    this.blobs.set(ref, bytes);
    return { storageRef: ref, sha256: sha256(bytes) };
  }
  async get(ref: string) {
    return this.blobs.get(ref) ?? null;
  }
}
/** Dev only: a directory on the API host. Not a retention-managed store. */
export class LocalDirArtifactBytes extends ArtifactBytesPort {
  readonly kind = 'local-dir';
  constructor(private readonly root = join(tmpdir(), 'nuzm-mobile-artifacts')) {
    super();
  }
  async put(orgId: string, buildId: string, fileName: string, bytes: Buffer) {
    const dir = join(this.root, orgId, buildId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName), bytes);
    return { storageRef: `file://${orgId}/${buildId}/${fileName}`, sha256: sha256(bytes) };
  }
  async get(ref: string) {
    const m = /^file:\/\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([A-Za-z0-9._-]+)$/.exec(ref);
    if (!m) return null;
    return readFile(join(this.root, m[1]!, m[2]!, m[3]!)).catch(() => null);
  }
}
export class UnavailableArtifactBytes extends ArtifactBytesPort {
  readonly kind = 'unavailable';
  async put(): Promise<never> {
    throw new Error('artifact storage is not connected (M08 bucket)');
  }
  async get() {
    return null;
  }
}
