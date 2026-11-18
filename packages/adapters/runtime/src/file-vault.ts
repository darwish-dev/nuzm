import { readFileSync } from 'node:fs';
import {
  VaultError,
  isVaultRef,
  type Redactor,
  type SecretMaterial,
  type VaultClient,
} from '@nuzm/adapter-contracts';

/**
 * NON-PRODUCTION file-backed vault stub (D-12 open). The file maps `vault://…` references to objects of named secret fields:
 *   { "vault://dev/alibaba/sandbox": { "accessKeyId": "...", "accessKeySecret": "..." } }
 * It refuses to run in a production profile: production use is BLOCKED until D-12 (secrets/KMS product) and HG-01-02 are decided.
 * Every resolved value is registered with the shared Redactor so it can never appear in logs or evidence.
 * The agent never creates credentials: the file is supplied by a human (and git-ignored: `.dev-vault/`).
 */
export class FileVaultClient implements VaultClient {
  constructor(private readonly opts: { path: string; redactor?: Redactor; env?: string }) {
    if ((opts.env ?? process.env.NODE_ENV) === 'production')
      throw new VaultError(
        'blocked',
        'the file-backed vault stub is non-production only (production vault is BLOCKED on D-12 / HG-01-02)',
      );
  }

  async resolve(ref: string): Promise<SecretMaterial> {
    if (!isVaultRef(ref)) throw new VaultError('invalid_ref', 'not a vault reference');
    let doc: Record<string, Record<string, string>>;
    try {
      doc = JSON.parse(readFileSync(this.opts.path, 'utf8')) as Record<
        string,
        Record<string, string>
      >;
    } catch {
      throw new VaultError('not_found', 'vault file is missing or unreadable');
    }
    const fields = doc[ref];
    if (!fields || typeof fields !== 'object')
      throw new VaultError('not_found', `no secret for ${ref}`);
    const material: SecretMaterial = {
      ref,
      fields: Object.freeze({ ...fields }),
      version: 'dev-file',
    };
    this.opts.redactor?.register(material);
    return material;
  }
}

/** In-memory vault for tests (same production guard). */
export class MemoryVaultClient implements VaultClient {
  constructor(
    private readonly secrets: Record<string, Record<string, string>>,
    private readonly redactor?: Redactor,
  ) {
    if (process.env.NODE_ENV === 'production')
      throw new VaultError('blocked', 'the in-memory vault is non-production only');
  }
  async resolve(ref: string): Promise<SecretMaterial> {
    if (!isVaultRef(ref)) throw new VaultError('invalid_ref', 'not a vault reference');
    const f = this.secrets[ref];
    if (!f) throw new VaultError('not_found', `no secret for ${ref}`);
    const m: SecretMaterial = { ref, fields: Object.freeze({ ...f }), version: 'memory' };
    this.redactor?.register(m);
    return m;
  }
}
