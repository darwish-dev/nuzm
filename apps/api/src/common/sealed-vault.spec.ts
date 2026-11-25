import { describe, expect, it } from 'vitest';
import { VaultError } from '@nuzm/adapter-contracts';
import { ChainedVault, SealedVault } from './sealed-vault';
import { MemorySecretStore } from './secrets';

/** MemorySecretStore refs are `vault://mem/…`; the sealed vault only answers for the refs its dev store mints (`vault://dev/…`). */
class DevMemory extends MemorySecretStore {
  override async put(id: string, value: string) {
    await super.put(id, value);
    return `vault://dev/${id}`;
  }
  override async get(ref: string) {
    return super.get(ref.replace('vault://dev/', 'vault://mem/'));
  }
}

describe('SealedVault', () => {
  it('resolves the fields an administrator typed, by the reference that was returned', async () => {
    const v = new SealedVault(new DevMemory());
    const ref = await v.putFields('provider-1', { accessKey: 'AK', secretKey: 'SK' });
    expect(ref).toBe('vault://dev/provider-1');
    const m = await v.resolve(ref);
    expect(m.fields).toEqual({ accessKey: 'AK', secretKey: 'SK' });
  });
  it('stores a transfer authorization code as {authCode}', async () => {
    const v = new SealedVault(new DevMemory());
    const ref = await v.put('AUTH-123', 'transfer-example.com');
    expect((await v.resolve(ref)).fields.authCode).toBe('AUTH-123');
  });
  it('answers not_found for references it did not mint, unknown ones and non-field-set entries', async () => {
    const store = new DevMemory();
    const v = new SealedVault(store);
    await expect(v.resolve('vault://prod/x')).rejects.toMatchObject({ code: 'not_found' });
    await expect(v.resolve('vault://dev/missing')).rejects.toMatchObject({ code: 'not_found' });
    await store.put('plain', 'not json');
    await expect(v.resolve('vault://dev/plain')).rejects.toMatchObject({ code: 'not_found' });
    await expect(v.resolve('not-a-ref')).rejects.toMatchObject({ code: 'invalid_ref' });
  });
  it('registers resolved material with the redactor', async () => {
    const seen: unknown[] = [];
    const v = new SealedVault(new DevMemory(), { register: (m) => void seen.push(m) });
    await v.resolve(await v.putFields('r1', { k: 'secret-value' }));
    expect(JSON.stringify(seen)).toContain('secret-value');
  });
});

describe('ChainedVault', () => {
  it('uses the first vault that holds the reference and passes a blocked answer straight through', async () => {
    const store = new DevMemory();
    const sealed = new SealedVault(store);
    const ref = await sealed.putFields('a', { k: 'v' });
    const miss = { resolve: async () => Promise.reject(new VaultError('not_found', 'no')) };
    expect((await new ChainedVault([miss, sealed]).resolve(ref)).fields.k).toBe('v');
    const blocked = { resolve: async () => Promise.reject(new VaultError('blocked', 'policy')) };
    await expect(new ChainedVault([blocked, sealed]).resolve(ref)).rejects.toMatchObject({
      code: 'blocked',
    });
    await expect(new ChainedVault([miss]).resolve('vault://dev/zzz')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
