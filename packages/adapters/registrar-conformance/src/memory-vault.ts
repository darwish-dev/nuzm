import { VaultError, type SecretMaterial, type VaultClient } from '@nuzm/registrar-contracts';

/** In-memory vault for tests and the dev stack only. Production use of any in-memory vault is wrong by construction (D-12 open). */
export class MemoryVault implements VaultClient {
  private readonly secrets = new Map<string, Record<string, string>>();
  private n = 0;
  set(ref: string, fields: Record<string, string>): this {
    this.secrets.set(ref, fields);
    return this;
  }
  async resolve(ref: string): Promise<SecretMaterial> {
    const f = this.secrets.get(ref);
    if (!f) throw new VaultError('not_found', `no secret for ${ref}`);
    return { ref, fields: f, version: '1' };
  }
  /** Used as the AuthCodeStore: stores a one-time code and returns its reference. */
  async put(code: string, label: string): Promise<string> {
    const ref = `vault://test/authcodes/${label.replace(/[^a-z0-9._-]/gi, '_')}-${++this.n}`;
    this.secrets.set(ref, { authCode: code });
    return ref;
  }
}
