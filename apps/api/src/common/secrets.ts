import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The store holds nothing under this reference. This is the ONLY failure that means "absent": every other failure (an entry that does not open, a file that cannot be
 * read) must propagate, so that nothing ever creates a replacement for something that is still there.
 */
export class SecretNotFoundError extends Error {
  override name = 'SecretNotFoundError';
  constructor(message = 'secret not found') {
    super(message);
  }
}

/** An entry exists but this seal key cannot open it: the seal key is wrong or was replaced, or the file is damaged. It is left exactly as it is. */
export class SecretUnreadableError extends Error {
  override name = 'SecretUnreadableError';
  constructor(ref: string) {
    super(
      `a secret is stored at ${ref} but this seal key does not open it (wrong or replaced seal key, or a damaged file): it was left unchanged`,
    );
  }
}

/** `create` found something already stored under the id. */
export class SecretExistsError extends Error {
  override name = 'SecretExistsError';
  constructor(ref: string) {
    super(`a secret already exists at ${ref}`);
  }
}

/**
 * Secret storage port. Production vault + KMS is BLOCKED on D-12; until then only vault REFERENCES
 * (vault://…) are persisted in the database and these dev-only implementations stand in.
 */
export abstract class SecretStore {
  /** Stores or replaces a value. An existing entry is replaced only when this store can open it. */
  abstract put(id: string, value: string): Promise<string>; // returns a vault:// ref
  /** Stores a NEW value; throws `SecretExistsError` when anything is stored under the id. Use this for keys: a key must never be replaced as a side effect. */
  abstract create(id: string, value: string): Promise<string>;
  /** Throws `SecretNotFoundError` only when nothing is stored under the reference. */
  abstract get(ref: string): Promise<string>;
  /** Removes an entry this store can open; deleting a missing one does nothing. */
  abstract delete(ref: string): Promise<void>;
}

export class MemorySecretStore extends SecretStore {
  private readonly m = new Map<string, string>();
  async put(id: string, value: string) {
    const ref = `vault://mem/${id}`;
    this.m.set(ref, value);
    return ref;
  }
  async create(id: string, value: string) {
    const ref = `vault://mem/${id}`;
    if (this.m.has(ref)) throw new SecretExistsError(ref);
    this.m.set(ref, value);
    return ref;
  }
  async get(ref: string) {
    const v = this.m.get(ref);
    if (v === undefined) throw new SecretNotFoundError();
    return v;
  }
  async delete(ref: string) {
    this.m.delete(ref);
  }
}

const isCode = (e: unknown, code: string) => (e as NodeJS.ErrnoException | null)?.code === code;

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
    // a reference this store did not mint names nothing here
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new SecretNotFoundError('invalid secret ref');
    return join(this.dir, id);
  }
  private seal(value: string) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]);
  }
  /** `null` when there is no file; throws `SecretUnreadableError` when there is one this key cannot open. Other file-system errors propagate as they are. */
  private open(ref: string): string | null {
    let b: Buffer;
    try {
      b = readFileSync(this.path(ref));
    } catch (e) {
      if (isCode(e, 'ENOENT')) return null;
      throw e;
    }
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    } catch {
      throw new SecretUnreadableError(ref);
    }
  }
  async put(id: string, value: string) {
    const ref = `vault://dev/${id}`;
    if (this.open(ref) === null) return this.create(id, value); // `open` throws for an entry this key cannot read: it is never overwritten
    writeFileSync(this.path(ref), this.seal(value), { mode: 0o600 });
    return ref;
  }
  async create(id: string, value: string) {
    const ref = `vault://dev/${id}`;
    try {
      writeFileSync(this.path(ref), this.seal(value), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if (isCode(e, 'EEXIST')) throw new SecretExistsError(ref);
      throw e;
    }
    return ref;
  }
  async get(ref: string) {
    const v = this.open(ref);
    if (v === null) throw new SecretNotFoundError();
    return v;
  }
  async delete(ref: string) {
    if (this.open(ref) === null) return;
    rmSync(this.path(ref), { force: true });
  }
}

const SEAL_KEY_FILE = 'dev-seal-key';
const isSealKey = (v: string) => Buffer.from(v, 'base64').length === 32;

/**
 * DEV ONLY: the key the file vault is sealed with. It is read from `<dir>/dev-seal-key`, and generated ONLY for an empty vault. A vault that already holds entries
 * but has no key (or an unusable one) is refused: a new key would orphan every entry in it.
 */
export function loadOrCreateDevSealKey(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, SEAL_KEY_FILE);
  let existing: string | null = null;
  try {
    existing = readFileSync(file, 'utf8').trim();
  } catch (e) {
    if (!isCode(e, 'ENOENT')) throw e;
  }
  if (existing !== null) {
    if (!isSealKey(existing))
      throw new Error(
        `${file} does not hold a 32-byte seal key: it was left unchanged. Restore the key that sealed this vault.`,
      );
    return existing;
  }
  const entries = readdirSync(dir).filter((f) => !f.startsWith('.'));
  if (entries.length > 0)
    throw new Error(
      `the dev vault ${dir} holds ${entries.length} sealed entries but no ${SEAL_KEY_FILE}: refusing to create a new key, which would orphan them. ` +
        'Restore the key that sealed them, or move the folder aside to start an empty vault.',
    );
  const key = randomBytes(32).toString('base64');
  writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  return key;
}

/**
 * DEV ONLY, at start-up: a vault whose field-encryption key does not open with this seal key means the seal key is the wrong one. Fail before serving anything
 * rather than on the first record that needs it. A vault without that entry (a new one) passes.
 */
export async function assertSealKeyOpensVault(
  key: Uint8Array,
  dir: string,
  probeRef = 'vault://dev/field-key-dev1',
): Promise<void> {
  try {
    await new FileDevSecretStore(key, dir).get(probeRef);
  } catch (e) {
    if (e instanceof SecretNotFoundError) return;
    throw e;
  }
}
