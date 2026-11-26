import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ProductionFileSecretStore, SecretExistsError, SecretUnreadableError } from './secrets';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nuzm-production-secrets-'));
  roots.push(root);
  const dir = join(root, 'vault');
  const keyFile = join(root, 'key');
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
  return { dir, keyFile };
}

it('persists encrypted values across restarts and refuses replacement with the wrong key', async () => {
  const { dir, keyFile } = fixture();
  const store = new ProductionFileSecretStore(dir, keyFile);
  const ref = await store.create('mfa-test', 'private-value');
  expect(await new ProductionFileSecretStore(dir, keyFile).get(ref)).toBe('private-value');
  const original = readFileSync(join(dir, 'mfa-test'));
  expect(original.includes(Buffer.from('private-value'))).toBe(false);
  await expect(store.create('mfa-test', 'replacement')).rejects.toBeInstanceOf(SecretExistsError);
  writeFileSync(keyFile, randomBytes(32).toString('base64'));
  await expect(
    new ProductionFileSecretStore(dir, keyFile).put('mfa-test', 'replacement'),
  ).rejects.toBeInstanceOf(SecretUnreadableError);
  expect(readFileSync(join(dir, 'mfa-test'))).toEqual(original);
});

it('refuses public permissions and path traversal', async () => {
  const { dir, keyFile } = fixture();
  chmodSync(keyFile, 0o644);
  expect(() => new ProductionFileSecretStore(dir, keyFile)).toThrow('protected regular file');
  chmodSync(keyFile, 0o600);
  const store = new ProductionFileSecretStore(dir, keyFile);
  await expect(store.create('../outside', 'value')).rejects.toThrow('invalid secret ref');
  chmodSync(dir, 0o755);
  expect(() => new ProductionFileSecretStore(dir, keyFile)).toThrow('private directory');
});
