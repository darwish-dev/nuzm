import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Secret storage port. Production vault + KMS is BLOCKED on D-12; until then only vault REFERENCES
 * (vault://…) are persisted in the database and these dev-only implementations stand in.
 */
export abstract class SecretStore {
  abstract put(id: string, value: string): Promise<string>; // returns a vault:// ref
  abstract get(ref: string): Promise<string>;
  abstract delete(ref: string): Promise<void>;
}

export class MemorySecretStore extends SecretStore {
  private readonly m = new Map<string, string>();
  async put(id: string, value: string) {
    const ref = `vault://mem/${id}`;
    this.m.set(ref, value);
    return ref;
  }
  async get(ref: string) {
    const v = this.m.get(ref);
    if (v === undefined) throw new Error('secret not found');
    return v;
  }
  async delete(ref: string) {
    this.m.delete(ref);
  }
}

/** DEV ONLY: AES-256-GCM files under .dev-vault/. Refuses to run in production. */
export class FileDevSecretStore extends SecretStore {
  constructor(
    private readonly key: Uint8Array,
    private readonly dir = join(process.cwd(), '.dev-vault'),
  ) {
    super();
    if (process.env.NODE_ENV === 'production')
      throw new Error('FileDevSecretStore must not be used in production (D-12)');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  private path(ref: string) {
    const id = ref.replace('vault://dev/', '');
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid secret ref');
    return join(this.dir, id);
  }
  async put(id: string, value: string) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    writeFileSync(this.path(`vault://dev/${id}`), Buffer.concat([iv, c.getAuthTag(), enc]), {
      mode: 0o600,
    });
    return `vault://dev/${id}`;
  }
  async get(ref: string) {
    const b = readFileSync(this.path(ref));
    const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }
  async delete(ref: string) {
    rmSync(this.path(ref), { force: true });
  }
}
