/* MIRROR of @nuzm/adapter-contracts (M05 S16, contractVersion 1.0.0) vault.ts, copied READ-ONLY on 2026-11-18 so M07 can build before M05 lands.
 * Integration: replace this file by `export * from "@nuzm/adapter-contracts"`-style re-exports (docs/reports/M07-m05-interface-assumptions.md §1). */
/**
 * Vault client interface (docs/09 §1 rule 1; D-12 open). Adapters receive a `vault://…` reference and resolve it here; the platform
 * stores references only. Implementations: the non-production file-backed stub (@nuzm/adapter-runtime) and, once D-12 + HG-01-02
 * are decided, the real client. Production use of the stub is BLOCKED by construction.
 */
export const VAULT_REF = /^vault:\/\/[A-Za-z0-9][A-Za-z0-9._\-/]{1,200}$/;
export const isVaultRef = (s: unknown): s is string => typeof s === 'string' && VAULT_REF.test(s);

export interface SecretMaterial {
  ref: string;
  /** Named secret fields, e.g. { accessKeyId, accessKeySecret }. Never logged, stored or returned by any API. */
  fields: Readonly<Record<string, string>>;
  version: string;
}
export interface VaultClient {
  resolve(ref: string): Promise<SecretMaterial>;
}

export class VaultError extends Error {
  constructor(
    readonly code: 'invalid_ref' | 'not_found' | 'blocked',
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}
