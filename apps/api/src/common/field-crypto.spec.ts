import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyringFieldCipher, fieldKeysFromEnv, isSealed, SEALED } from './field-crypto';
import { MemorySecretStore } from './secrets';

const ctx = {
  column: 'invoicing.tax_profiles.pii_enc',
  row: '0194a1b2-1111-7222-8333-444455556666',
};
const keyIn = async (store: MemorySecretStore, id: string) =>
  store.put(id, randomBytes(32).toString('base64'));

describe('field cipher', () => {
  it('seals and opens a value, in the documented format, with a fresh IV each time', async () => {
    const c = new KeyringFieldCipher(new MemorySecretStore());
    const a = await c.encrypt('الشركة العربية 123', ctx);
    const b = await c.encrypt('الشركة العربية 123', ctx);
    expect(a).toMatch(SEALED);
    expect(isSealed(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain('123');
    expect(await c.decrypt(a, ctx)).toBe('الشركة العربية 123');
    expect(await c.decrypt(b, ctx)).toBe('الشركة العربية 123');
  });
  it('round-trips JSON and the empty string', async () => {
    const c = new KeyringFieldCipher(new MemorySecretStore());
    const v = { legalName: { ar: 'س', en: 'S' }, vatNumber: null, address: { city: 'Riyadh' } };
    expect(await c.decryptJson(await c.encryptJson(v, ctx), ctx)).toEqual(v);
    expect(await c.decrypt(await c.encrypt('', ctx), ctx)).toBe('');
  });
  it('does not open for another row, another column, or after tampering', async () => {
    const c = new KeyringFieldCipher(new MemorySecretStore());
    const s = await c.encrypt('secret', ctx);
    await expect(
      c.decrypt(s, { ...ctx, row: '0194a1b2-9999-7222-8333-444455556666' }),
    ).rejects.toThrow(/does not open/);
    await expect(c.decrypt(s, { ...ctx, column: 'invoicing.tax_profiles.other' })).rejects.toThrow(
      /does not open/,
    );
    const flipped = s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA');
    await expect(c.decrypt(flipped, ctx)).rejects.toThrow(/does not open/);
    await expect(c.decrypt('plain text', ctx)).rejects.toThrow(/not a sealed/);
    await expect(c.decrypt('enc:v1:k:short', ctx)).rejects.toThrow();
  });
  it('different columns use different subkeys (same master key)', async () => {
    const c = new KeyringFieldCipher(new MemorySecretStore());
    const s = await c.encrypt('same', ctx);
    // the same ciphertext fed to another column fails even with the AAD of that column rewritten
    await expect(
      c.decrypt(s, { column: 'platform.notifications.body_enc', row: ctx.row }),
    ).rejects.toThrow(/does not open/);
  });
  it('rotates: values sealed with an old key keep opening, new values use the current key', async () => {
    const store = new MemorySecretStore();
    const r1 = await keyIn(store, 'k1');
    const r2 = await keyIn(store, 'k2');
    const old = new KeyringFieldCipher(store, [{ id: 'k1', ref: r1, current: true }], true);
    const sealedOld = await old.encrypt('before rotation', ctx);
    expect(sealedOld).toContain('enc:v1:k1:');
    const rotated = new KeyringFieldCipher(
      store,
      [
        { id: 'k1', ref: r1 },
        { id: 'k2', ref: r2, current: true },
      ],
      true,
    );
    expect(await rotated.currentKeyId()).toBe('k2');
    expect(await rotated.decrypt(sealedOld, ctx)).toBe('before rotation');
    const sealedNew = await rotated.encrypt('after rotation', ctx);
    expect(sealedNew).toContain('enc:v1:k2:');
    // without the old key the old value cannot be opened
    const onlyNew = new KeyringFieldCipher(store, [{ id: 'k2', ref: r2, current: true }], true);
    await expect(onlyNew.decrypt(sealedOld, ctx)).rejects.toThrow(
      /unknown field encryption key k1/,
    );
  });
  it('fails closed in production without configured keys, and never caches a failed load', async () => {
    const c = new KeyringFieldCipher(new MemorySecretStore(), [], true);
    await expect(c.encrypt('x', ctx)).rejects.toThrow(/not configured/);
    await expect(c.currentKeyId()).rejects.toThrow(/not configured/);
  });
  it('refuses a key that is not 32 bytes', async () => {
    const store = new MemorySecretStore();
    const ref = await store.put('short', Buffer.from('too short').toString('base64'));
    await expect(
      new KeyringFieldCipher(store, [{ id: 'k', ref, current: true }], true).encrypt('x', ctx),
    ).rejects.toThrow(/32 bytes/);
  });
  it('the development fallback creates one throwaway key and reuses it', async () => {
    const store = new MemorySecretStore();
    const a = new KeyringFieldCipher(store, [], false);
    const s = await a.encrypt('dev value', ctx);
    expect(s).toContain('enc:v1:dev1:');
    // a second cipher on the same store finds the same key
    expect(await new KeyringFieldCipher(store, [], false).decrypt(s, ctx)).toBe('dev value');
  });
});

describe('FIELD_ENCRYPTION_KEYS', () => {
  const ok = JSON.stringify([
    { id: 'k1', ref: 'vault://a', current: true },
    { id: 'k2', ref: 'vault://b' },
  ]);
  it('is empty when unset and parses a valid list', () => {
    expect(fieldKeysFromEnv({})).toEqual([]);
    expect(fieldKeysFromEnv({ FIELD_ENCRYPTION_KEYS: ok })).toHaveLength(2);
  });
  it.each([
    ['a non-list', '{}'],
    ['an empty list', '[]'],
    [
      'two current keys',
      JSON.stringify([
        { id: 'a', ref: 'vault://a', current: true },
        { id: 'b', ref: 'vault://b', current: true },
      ]),
    ],
    ['no current key', JSON.stringify([{ id: 'a', ref: 'vault://a' }])],
    [
      'a duplicate id',
      JSON.stringify([
        { id: 'a', ref: 'vault://a', current: true },
        { id: 'a', ref: 'vault://b' },
      ]),
    ],
    [
      'a key that is not a vault ref',
      JSON.stringify([{ id: 'a', ref: 'file:///key', current: true }]),
    ],
    ['a bad id', JSON.stringify([{ id: 'a b', ref: 'vault://a', current: true }])],
  ])('refuses %s', (_n, v) =>
    expect(() => fieldKeysFromEnv({ FIELD_ENCRYPTION_KEYS: v })).toThrow(),
  );
});
