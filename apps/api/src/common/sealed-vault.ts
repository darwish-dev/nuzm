import { randomBytes } from 'node:crypto';
import {
  VaultError,
  isVaultRef,
  type SecretMaterial,
  type VaultClient,
} from '@nuzm/adapter-contracts';
import type { SecretStore } from './secrets';

/**
 * A `VaultClient` over the sealed `SecretStore` (AES-256-GCM files in the dev profile; the production store is still D-12). It is what lets an administrator TYPE a
 * provider credential in the admin console: the value goes straight into the store (write-only), only its `vault://…` reference is ever kept in the database, and the
 * adapters resolve that reference here. Entries hold a JSON object of named string fields (`{"apiKey":"…"}`); anything else is refused.
 *
 * It resolves only what its own store holds: any other reference is `not_found` (the store refuses a reference it did not mint), so a typed reference cannot reach another vault's data.
 */
export class SealedVault implements VaultClient {
  constructor(
    private readonly store: SecretStore,
    private readonly redactor?: { register(material: unknown): unknown },
  ) {}

  /** Stores named fields and returns the reference. `id` is `[A-Za-z0-9_-]+`. */
  async putFields(id: string, fields: Record<string, string>): Promise<string> {
    return this.store.put(id, JSON.stringify(fields));
  }

  /** The AuthCodeStore of the registrar contract: a one-time transfer authorization code, stored as `{authCode}`. */
  async put(code: string, label: string): Promise<string> {
    const id = `authcode-${label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}-${randomBytes(6).toString('hex')}`;
    return this.putFields(id, { authCode: code });
  }

  async resolve(ref: string): Promise<SecretMaterial> {
    if (!isVaultRef(ref)) throw new VaultError('invalid_ref', 'not a vault reference');
    let raw: string;
    try {
      raw = await this.store.get(ref);
    } catch {
      throw new VaultError('not_found', `no secret for ${ref}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new VaultError('not_found', `the secret for ${ref} is not a field set`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new VaultError('not_found', `the secret for ${ref} is not a field set`);
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (typeof v === 'string') fields[k] = v;
    const material: SecretMaterial = { ref, fields: Object.freeze(fields), version: 'sealed' };
    this.redactor?.register(material);
    return material;
  }

  async delete(ref: string): Promise<void> {
    try {
      await this.store.delete(ref);
    } catch {
      /* a reference this store did not mint: nothing to delete */
    }
  }
}

/** Tries each vault in order; the first that holds the reference answers. A `blocked` answer is final (it is a policy, not a miss). */
export class ChainedVault implements VaultClient {
  constructor(private readonly vaults: VaultClient[]) {}
  async resolve(ref: string): Promise<SecretMaterial> {
    let last: unknown = new VaultError('not_found', `no secret for ${ref}`);
    for (const v of this.vaults) {
      try {
        return await v.resolve(ref);
      } catch (e) {
        // duck-typed: the registrar contracts carry a mirror copy of VaultError, so `instanceof` would miss it
        if (
          (e as { name?: string }).name === 'VaultError' &&
          (e as { code?: string }).code === 'blocked'
        )
          throw e;
        last = e;
      }
    }
    throw last;
  }
}
