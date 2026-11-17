import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where encrypted export archives are stored (M04 §2). The real in-region sink arrives with M08 (D-07). Until then: a local directory in
 * development and test, and NO sink in production, so a production request answers 422 `no_export_sink` instead of writing somewhere unreviewed.
 */
export abstract class ExportSink {
  abstract available(): boolean;
  abstract put(key: string, bytes: Buffer): Promise<string>;
  abstract get(ref: string): Promise<Buffer>;
}

export class LocalExportSink extends ExportSink {
  constructor(
    private readonly dir = process.env.EXPORT_LOCAL_DIR ?? join(process.cwd(), '.local', 'exports'),
  ) {
    super();
    if (process.env.NODE_ENV === 'production')
      throw new Error('LocalExportSink must not be used in production (D-07)');
  }
  available() {
    return true;
  }
  private path(ref: string) {
    const id = ref.replace(/^local:\/\//, '');
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error('invalid export reference');
    return join(this.dir, id);
  }
  async put(key: string, bytes: Buffer) {
    const safe = key.replace(/[^A-Za-z0-9_.-]/g, '_');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path(`local://${safe}`), bytes, { mode: 0o600 });
    return `local://${safe}`;
  }
  async get(ref: string) {
    return readFileSync(this.path(ref));
  }
}

export class NoExportSink extends ExportSink {
  available() {
    return false;
  }
  async put(): Promise<string> {
    throw new Error('no export sink is configured');
  }
  async get(): Promise<Buffer> {
    throw new Error('no export sink is configured');
  }
}

/** Test double: in memory. */
export class MemoryExportSink extends ExportSink {
  readonly files = new Map<string, Buffer>();
  available() {
    return true;
  }
  async put(key: string, bytes: Buffer) {
    const ref = `mem://${key}`;
    this.files.set(ref, bytes);
    return ref;
  }
  async get(ref: string) {
    const b = this.files.get(ref);
    if (!b) throw new Error('export not found');
    return b;
  }
}
