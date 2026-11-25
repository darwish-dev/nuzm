import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { SecretExistsError, SecretNotFoundError, SecretStore } from './secrets';

/**
 * Field-level encryption (M04 S13d). A value is sealed with AES-256-GCM under a per-column subkey derived (HKDF-SHA256) from a master key that
 * lives in the vault and is referenced by id, never stored in the database or in code. The sealed form is
 * `enc:v1:<keyId>:<base64url(iv | tag | ciphertext)>`; the key id lets old values keep opening after the current key rotates.
 *
 * The authenticated data binds a ciphertext to its COLUMN and ROW (`schema.table.column|rowId`): a value copied to another row or column does not
 * open. Production keys come from the vault (D-12) and a missing key FAILS CLOSED; the development fallback creates a throwaway key in the dev
 * secret store and refuses to run in production.
 */
export interface FieldContext {
  /** `schema.table.column`. */
  column: string;
  /** The row the value belongs to (its id, or the organization id for one-row-per-organization tables). */
  row: string;
}

export abstract class FieldCipher {
  abstract encrypt(plain: string, ctx: FieldContext): Promise<string>;
  abstract decrypt(sealed: string, ctx: FieldContext): Promise<string>;
  /** The id of the key new values are sealed with. */
  abstract currentKeyId(): Promise<string>;
  encryptJson(value: unknown, ctx: FieldContext): Promise<string> {
    return this.encrypt(JSON.stringify(value), ctx);
  }
  async decryptJson<T>(sealed: string, ctx: FieldContext): Promise<T> {
    return JSON.parse(await this.decrypt(sealed, ctx)) as T;
  }
}

export const SEALED = /^enc:v1:([A-Za-z0-9_-]{1,40}):([A-Za-z0-9_-]{38,})$/;
export const isSealed = (v: unknown): v is string => typeof v === 'string' && SEALED.test(v);

export interface FieldKeyConfig {
  id: string;
  /** Vault reference of the master key (32 random bytes, base64). */
  ref: string;
  current?: boolean;
}

/** `FIELD_ENCRYPTION_KEYS` = `[{"id":"k1","ref":"vault://…","current":true}]`. Empty/absent: development fallback only. */
export function fieldKeysFromEnv(env: NodeJS.ProcessEnv = process.env): FieldKeyConfig[] {
  const raw = env.FIELD_ENCRYPTION_KEYS;
  if (!raw) return [];
  const parsed = JSON.parse(raw) as FieldKeyConfig[];
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error('FIELD_ENCRYPTION_KEYS must be a non-empty list');
  const ids = new Set<string>();
  for (const k of parsed) {
    if (
      !/^[A-Za-z0-9_-]{1,40}$/.test(k.id) ||
      typeof k.ref !== 'string' ||
      !k.ref.startsWith('vault://')
    )
      throw new Error('FIELD_ENCRYPTION_KEYS: each key needs an id and a vault:// ref');
    if (ids.has(k.id)) throw new Error(`FIELD_ENCRYPTION_KEYS: duplicate key id ${k.id}`);
    ids.add(k.id);
  }
  if (parsed.filter((k) => k.current).length !== 1)
    throw new Error('FIELD_ENCRYPTION_KEYS: exactly one key must be current');
  return parsed;
}

const DEV_KEY_ID = 'dev1';
const DEV_SECRET = 'field-key-dev1';

export class KeyringFieldCipher extends FieldCipher {
  private ring: Promise<{ current: string; keys: Map<string, Uint8Array> }> | null = null;
  private readonly sub = new Map<string, Uint8Array>();

  constructor(
    private readonly store: SecretStore,
    private readonly config: FieldKeyConfig[] = fieldKeysFromEnv(),
    private readonly production = process.env.NODE_ENV === 'production',
  ) {
    super();
  }

  private load() {
    this.ring ??= (async () => {
      const keys = new Map<string, Uint8Array>();
      let current = '';
      if (this.config.length === 0) {
        if (this.production)
          throw new Error(
            'field encryption keys are not configured (FIELD_ENCRYPTION_KEYS, D-12): refusing to run without them',
          );
        // development fallback: one throwaway key in the dev secret store
        // the dev stores name their refs vault://dev/<id> (file) or vault://mem/<id> (memory): look for an existing key before creating one
        // ONLY "nothing is stored there" may lead to a new key. A key that exists but does not open (wrong seal key, damaged or unreadable file) stops here:
        // replacing it would leave every value sealed with it unreadable for good.
        const find = async () => {
          for (const prefix of ['vault://dev/', 'vault://mem/']) {
            try {
              return await this.store.get(`${prefix}${DEV_SECRET}`);
            } catch (e) {
              if (!(e instanceof SecretNotFoundError)) throw e;
            }
          }
          return null;
        };
        let value = await find();
        if (value === null) {
          try {
            value = await this.store.get(
              await this.store.create(DEV_SECRET, randomBytes(32).toString('base64')),
            );
          } catch (e) {
            if (!(e instanceof SecretExistsError)) throw e;
            value = await find(); // another process created it first: use that one
            if (value === null) throw e;
          }
        }
        keys.set(DEV_KEY_ID, Buffer.from(value, 'base64'));
        current = DEV_KEY_ID;
      } else {
        for (const k of this.config) {
          const key = Buffer.from(await this.store.get(k.ref), 'base64');
          if (key.length !== 32) throw new Error(`field encryption key ${k.id} must be 32 bytes`);
          keys.set(k.id, key);
          if (k.current) current = k.id;
        }
      }
      for (const [id, k] of keys)
        if (k.length !== 32) throw new Error(`field encryption key ${id} must be 32 bytes`);
      return { current, keys };
    })();
    this.ring.catch(() => (this.ring = null)); // a failed load is retried, never cached
    return this.ring;
  }

  private subkey(keyId: string, master: Uint8Array, column: string): Uint8Array {
    const id = `${keyId}|${column}`;
    let k = this.sub.get(id);
    if (!k) {
      k = new Uint8Array(
        hkdfSync('sha256', master, Buffer.alloc(0), `nuzm:field:v1:${column}`, 32),
      );
      this.sub.set(id, k);
    }
    return k;
  }

  async currentKeyId() {
    return (await this.load()).current;
  }

  async encrypt(plain: string, ctx: FieldContext): Promise<string> {
    const { current, keys } = await this.load();
    const iv = randomBytes(12);
    const c = createCipheriv(
      'aes-256-gcm',
      this.subkey(current, keys.get(current)!, ctx.column),
      iv,
    );
    c.setAAD(Buffer.from(`${ctx.column}|${ctx.row}`, 'utf8'));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `enc:v1:${current}:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
  }

  async decrypt(sealed: string, ctx: FieldContext): Promise<string> {
    const m = SEALED.exec(sealed);
    if (!m) throw new Error('not a sealed field value');
    const { keys } = await this.load();
    const master = keys.get(m[1]!);
    if (!master) throw new Error(`unknown field encryption key ${m[1]}`);
    const b = Buffer.from(m[2]!, 'base64url');
    if (b.length < 28) throw new Error('sealed field value is truncated');
    const d = createDecipheriv(
      'aes-256-gcm',
      this.subkey(m[1]!, master, ctx.column),
      b.subarray(0, 12),
    );
    d.setAAD(Buffer.from(`${ctx.column}|${ctx.row}`, 'utf8'));
    d.setAuthTag(b.subarray(12, 28));
    try {
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    } catch {
      throw new Error('sealed field value does not open (wrong key, column or row, or tampered)');
    }
  }
}
