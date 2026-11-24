import { createHash } from 'node:crypto';
import type { Db } from '@nuzm/platform';
import type { SealedVault } from '../../../../common/sealed-vault';
import type { SecretStore } from '../../../../common/secrets';
import type { VaultPort } from '../ports';
import type { HestiaConnection, HestiaConnections, HestiaKeys } from './client';

/** Reads a node's panel connection from the registry (platform scope: the control plane's own, never a customer's). */
export class DbHestiaConnections implements HestiaConnections {
  constructor(private readonly db: Db) {}
  async resolve(nodeId: string): Promise<HestiaConnection | null> {
    const r = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT panel_host, panel_port, panel_key_ref, panel_tls_pin FROM hosting.nodes WHERE id = $1 AND status <> 'retired'`,
            [nodeId],
          )
        ).rows[0],
    );
    if (!r?.panel_host || !r.panel_key_ref) return null;
    return {
      host: r.panel_host as string,
      port: Number(r.panel_port ?? 8083),
      accessKeyRef: r.panel_key_ref as string,
      tlsPinSha256: (r.panel_tls_pin as string | null) ?? null,
    };
  }
}

/** The panel access key (`ACCESS_KEY_ID:SECRET_ACCESS_KEY`) from the sealed store; the value is read at call time and never kept. */
export class SealedHestiaKeys implements HestiaKeys {
  constructor(private readonly vault: SealedVault) {}
  async accessKey(ref: string): Promise<string> {
    const m = await this.vault.resolve(ref);
    const k = m.fields.accessKey;
    if (!k) throw new Error('the vault entry holds no accessKey');
    return k;
  }
}

/**
 * The hosting module's `VaultPort` over the sealed secret store (non-production profiles): per-site credentials survive a restart, unlike the in-memory vault. Each `vault://…`
 * reference maps to one sealed entry. Production has no store until D-12 and keeps the blocking port.
 */
export class SealedVaultPort implements VaultPort {
  constructor(private readonly store: SecretStore) {}
  private id(ref: string) {
    return `hs-${createHash('sha256').update(ref).digest('hex').slice(0, 40)}`;
  }
  async put(ref: string, secret: Buffer | string): Promise<void> {
    await this.store.put(
      this.id(ref),
      JSON.stringify({ v: Buffer.from(secret).toString('base64') }),
    );
  }
  async get(ref: string): Promise<Buffer | undefined> {
    try {
      const raw = await this.store.get(`vault://dev/${this.id(ref)}`);
      const v = (JSON.parse(raw) as { v?: string }).v;
      return v === undefined ? undefined : Buffer.from(v, 'base64');
    } catch {
      return undefined;
    }
  }
  async exists(ref: string): Promise<boolean> {
    try {
      await this.store.get(`vault://dev/${this.id(ref)}`);
      return true;
    } catch {
      return false;
    }
  }
  async delete(ref: string): Promise<void> {
    try {
      await this.store.delete(`vault://dev/${this.id(ref)}`);
    } catch {
      /* nothing to delete */
    }
  }
}
