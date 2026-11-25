import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyringFieldCipher } from './field-crypto';
import {
  FileDevSecretStore,
  MemorySecretStore,
  SecretExistsError,
  SecretNotFoundError,
  SecretUnreadableError,
  assertSealKeyOpensVault,
  loadOrCreateDevSealKey,
} from './secrets';

/**
 * Regression: a wrong or missing seal key must never lead to a new key. Before the fix the field cipher read "this key does not open the stored field key" as
 * "there is no field key" and wrote a new one over it, and the dev stack created a new seal key beside a vault full of entries.
 * Every test that provokes a failure also proves the bytes on disk did not change.
 */
const dirs: string[] = [];
const vault = () => {
  const d = mkdtempSync(join(tmpdir(), 'nuzm-vault-spec-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const snapshot = (d: string) =>
  Object.fromEntries(
    readdirSync(d)
      .sort()
      .map((f) => [f, readFileSync(join(d, f)).toString('base64')]),
  );
const ctx = {
  column: 'ai.messages.content_enc',
  row: '0194a1b2-1111-7222-8333-444455556666',
};

describe('field cipher with a wrong seal key', () => {
  it('fails, writes nothing, and the values still open once the right key is back', async () => {
    const dir = vault();
    const right = randomBytes(32);
    const sealed = await new KeyringFieldCipher(new FileDevSecretStore(right, dir)).encrypt(
      'kept',
      ctx,
    );
    const before = snapshot(dir);

    const wrong = new KeyringFieldCipher(new FileDevSecretStore(randomBytes(32), dir));
    await expect(wrong.encrypt('x', ctx)).rejects.toBeInstanceOf(SecretUnreadableError);
    await expect(wrong.decrypt(sealed, ctx)).rejects.toBeInstanceOf(SecretUnreadableError);
    await expect(wrong.currentKeyId()).rejects.toThrow(/left unchanged/);
    expect(snapshot(dir)).toEqual(before);

    const again = new KeyringFieldCipher(new FileDevSecretStore(right, dir));
    expect(await again.decrypt(sealed, ctx)).toBe('kept');
  });

  it('a damaged field key is not replaced either', async () => {
    const dir = vault();
    writeFileSync(join(dir, 'field-key-dev1'), 'short');
    const before = snapshot(dir);
    await expect(
      new KeyringFieldCipher(new FileDevSecretStore(randomBytes(32), dir)).encrypt('x', ctx),
    ).rejects.toBeInstanceOf(SecretUnreadableError);
    expect(snapshot(dir)).toEqual(before);
  });

  it('a file-system error is not read as "no key yet"', async () => {
    const dir = vault();
    mkdirSync(join(dir, 'field-key-dev1')); // reading it raises EISDIR, not ENOENT
    const store = new FileDevSecretStore(randomBytes(32), dir);
    await expect(store.get('vault://dev/field-key-dev1')).rejects.not.toBeInstanceOf(
      SecretNotFoundError,
    );
    await expect(new KeyringFieldCipher(store).encrypt('x', ctx)).rejects.toThrow(/EISDIR/);
  });

  it('any store failure other than "not found" stops the cipher before it creates anything', async () => {
    let created = 0;
    class Failing extends MemorySecretStore {
      override async get(): Promise<string> {
        throw new Error('vault timed out');
      }
      override async create(id: string, value: string) {
        created++;
        return super.create(id, value);
      }
    }
    await expect(new KeyringFieldCipher(new Failing()).encrypt('x', ctx)).rejects.toThrow(
      'vault timed out',
    );
    expect(created).toBe(0);
  });

  it('a missing field key is created once, and two ciphers starting together share it', async () => {
    const dir = vault();
    const seal = randomBytes(32);
    const a = new KeyringFieldCipher(new FileDevSecretStore(seal, dir));
    const b = new KeyringFieldCipher(new FileDevSecretStore(seal, dir));
    const [x, y] = await Promise.all([a.encrypt('from a', ctx), b.encrypt('from b', ctx)]);
    expect(await b.decrypt(x, ctx)).toBe('from a');
    expect(await a.decrypt(y, ctx)).toBe('from b');
    expect(readdirSync(dir)).toEqual(['field-key-dev1']);
  });

  it('when another process creates the key between the look-up and the create, that key is used', async () => {
    const store = new MemorySecretStore();
    const winner = randomBytes(32).toString('base64');
    class Raced extends MemorySecretStore {
      private first = true;
      override async get(ref: string) {
        return store.get(ref);
      }
      override async create(id: string, value: string) {
        if (this.first) {
          this.first = false;
          await store.create(id, winner);
        }
        return store.create(id, value);
      }
    }
    const sealed = await new KeyringFieldCipher(new Raced()).encrypt('shared', ctx);
    expect(await new KeyringFieldCipher(store).decrypt(sealed, ctx)).toBe('shared');
    expect(await store.get('vault://mem/field-key-dev1')).toBe(winner);
  });
});

describe('file secret store', () => {
  it('put and delete refuse an entry this seal key cannot open, and leave it byte for byte', async () => {
    const dir = vault();
    const owner = new FileDevSecretStore(randomBytes(32), dir);
    const ref = await owner.put('ai-claude', 'the stored value');
    const before = snapshot(dir);
    const other = new FileDevSecretStore(randomBytes(32), dir);
    await expect(other.put('ai-claude', 'a replacement')).rejects.toBeInstanceOf(
      SecretUnreadableError,
    );
    await expect(other.create('ai-claude', 'a replacement')).rejects.toBeInstanceOf(
      SecretExistsError,
    );
    await expect(other.delete(ref)).rejects.toBeInstanceOf(SecretUnreadableError);
    expect(snapshot(dir)).toEqual(before);
    expect(await owner.get(ref)).toBe('the stored value');
  });

  it('with the right key, replacing and deleting work as before; deleting a missing entry is a no-op', async () => {
    const s = new FileDevSecretStore(randomBytes(32), vault());
    const ref = await s.put('mfa-1', 'one');
    expect(await s.put('mfa-1', 'two')).toBe(ref);
    expect(await s.get(ref)).toBe('two');
    await s.delete(ref);
    await s.delete(ref);
    await expect(s.get(ref)).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(s.get('vault://dev/../escape')).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it('errors never carry the stored value or the key', async () => {
    const dir = vault();
    const seal = randomBytes(32);
    await new FileDevSecretStore(seal, dir).put('ai-claude', 'VALUE-THAT-MUST-NOT-LEAK');
    const e = await new FileDevSecretStore(randomBytes(32), dir)
      .get('vault://dev/ai-claude')
      .catch((x: unknown) => String((x as Error).stack));
    expect(e).not.toContain('VALUE-THAT-MUST-NOT-LEAK');
    expect(e).not.toContain(seal.toString('base64'));
  });
});

describe('dev seal key', () => {
  it('is generated for an empty vault, then reused and never rewritten', () => {
    const dir = vault();
    const first = loadOrCreateDevSealKey(dir);
    expect(Buffer.from(first, 'base64')).toHaveLength(32);
    const before = snapshot(dir);
    expect(loadOrCreateDevSealKey(dir)).toBe(first);
    expect(snapshot(dir)).toEqual(before);
  });

  it('is NOT generated when the vault already holds entries: it fails and creates no file', async () => {
    const dir = vault();
    await new FileDevSecretStore(randomBytes(32), dir).put('mfa-1', 'enrolled');
    const before = snapshot(dir);
    expect(() => loadOrCreateDevSealKey(dir)).toThrow(/no dev-seal-key: refusing/);
    expect(snapshot(dir)).toEqual(before);
  });

  it('an unusable key file is refused and left unchanged', () => {
    const dir = vault();
    writeFileSync(join(dir, 'dev-seal-key'), 'not a key');
    const before = snapshot(dir);
    expect(() => loadOrCreateDevSealKey(dir)).toThrow(/does not hold a 32-byte seal key/);
    expect(snapshot(dir)).toEqual(before);
  });

  it('the start-up check passes for the right key and a new vault, and fails for a wrong key', async () => {
    const dir = vault();
    const seal = randomBytes(32);
    await expect(assertSealKeyOpensVault(seal, dir)).resolves.toBeUndefined();
    await new KeyringFieldCipher(new FileDevSecretStore(seal, dir)).encrypt('x', ctx);
    const before = snapshot(dir);
    await expect(assertSealKeyOpensVault(seal, dir)).resolves.toBeUndefined();
    await expect(assertSealKeyOpensVault(randomBytes(32), dir)).rejects.toBeInstanceOf(
      SecretUnreadableError,
    );
    expect(snapshot(dir)).toEqual(before);
  });
});
