import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Secret VALUES (credential token and secret) live in a vault and are addressed by reference; the database holds the reference only. The vault
 * choice is open (D-12): the only implementation is a development file store, refused in a production profile, writing each value once.
 */
export interface SecretStore {
  /** Store a value once; returns false when the reference already exists with a different value is refused by throwing. */
  put(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string>;
}
const REF = /^vault:\/\/dev\/zatca\/([a-z0-9][a-z0-9_-]{1,60})$/;

export class DevFileSecretStore implements SecretStore {
  private readonly dir: string;
  constructor(
    dir = process.env.ZATCA_DEV_VAULT_DIR ?? '.local/zatca-vault',
    env: NodeJS.ProcessEnv = process.env,
  ) {
    if (env.NODE_ENV === 'production')
      throw new Error(
        'the development secret store is refused in a production profile (the vault choice is D-12)',
      );
    this.dir = resolve(dir);
  }
  private path(ref: string) {
    const m = REF.exec(ref);
    if (!m) throw new Error('not a zatca vault reference');
    return join(this.dir, `${m[1]}.secret`);
  }
  async put(ref: string, value: string): Promise<void> {
    const p = this.path(ref);
    if (existsSync(p)) throw new Error('a secret already exists for this reference');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(p, value, { mode: 0o600, flag: 'wx' });
    chmodSync(p, 0o600);
  }
  async get(ref: string): Promise<string> {
    return readFileSync(this.path(ref), 'utf8');
  }
}
