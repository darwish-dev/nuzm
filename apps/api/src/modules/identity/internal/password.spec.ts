import { describe, expect, it } from 'vitest';
import { hashPassword, passwordProblem, verifyPassword } from './password';

const cheap = { logN: 12, r: 8, p: 1 };

describe('password hashing', () => {
  it('verifies the right password and rejects others, with salts that differ per hash', async () => {
    const a = await hashPassword('correct horse battery', cheap);
    const b = await hashPassword('correct horse battery', cheap);
    expect(a).not.toBe(b);
    expect(a).not.toContain('correct horse');
    expect(a.startsWith('scrypt$4096$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterz', a)).toBe(false);
    expect(await verifyPassword('', a)).toBe(false);
  });

  it('keeps verifying a hash made with other cost parameters (they live in the string)', async () => {
    const old = await hashPassword('another long passphrase', { logN: 11, r: 8, p: 1 });
    expect(await verifyPassword('another long passphrase', old)).toBe(true);
  });

  it('treats unicode-equivalent forms as the same password (NFKC)', async () => {
    const h = await hashPassword('café au lait 2026', cheap);
    expect(await verifyPassword('café au lait 2026', h)).toBe(true);
  });

  it('refuses malformed or out-of-range stored values instead of throwing or burning memory', async () => {
    for (const bad of [
      '',
      'plain',
      'scrypt$x$8$1$a$b',
      'scrypt$4096$8$1$AAAA',
      'scrypt$1073741824$8$1$AAAA$AAAA', // N far above the cap
      'scrypt$4096$999$1$AAAA$AAAA',
      'bcrypt$4096$8$1$AAAA$AAAA',
    ])
      expect(await verifyPassword('whatever password', bad)).toBe(false);
  });
});

describe('password policy', () => {
  it('requires 12 to 128 characters, counted as characters', () => {
    expect(passwordProblem('x'.repeat(11))).toBe('too_short');
    expect(passwordProblem('هذه كلمة سر طويلة')).toBeNull();
    expect(passwordProblem('ك'.repeat(11))).toBe('too_short');
    expect(passwordProblem('a1'.repeat(64))).toBeNull();
    expect(passwordProblem('a1'.repeat(65))).toBe('too_long');
  });

  it('refuses very common passwords, repeated characters and the email address', () => {
    expect(passwordProblem('Password1234')).toBe('common');
    expect(passwordProblem('zzzzzzzzzzzz')).toBe('common');
    expect(passwordProblem('Layla@Example.test', 'layla@example.test')).toBe('same_as_email');
    expect(passwordProblem('a fine long passphrase', 'layla@example.test')).toBeNull();
  });
});
