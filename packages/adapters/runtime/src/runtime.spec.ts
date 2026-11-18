import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Redactor, VaultError } from '@nuzm/adapter-contracts';
import { CircuitBreaker, FileVaultClient, MemoryVaultClient, SimClock, TokenBucket } from './index';

describe('FileVaultClient (non-production stub)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nuzm-vault-'));
  const file = join(dir, 'v.json');
  writeFileSync(
    file,
    JSON.stringify({
      'vault://dev/test/acct': {
        accessKeyId: 'AKID-TEST-0001',
        accessKeySecret: 'CANARY-FILE-VAULT-SECRET',
      },
    }),
  );

  it('resolves a reference and registers the values with the redactor', async () => {
    const red = new Redactor();
    const m = await new FileVaultClient({ path: file, redactor: red, env: 'test' }).resolve(
      'vault://dev/test/acct',
    );
    expect(m.fields.accessKeySecret).toBe('CANARY-FILE-VAULT-SECRET');
    expect(red.string('x CANARY-FILE-VAULT-SECRET y')).toBe('x [REDACTED] y');
  });
  it('refuses unknown refs and non-refs', async () => {
    const v = new FileVaultClient({ path: file, env: 'test' });
    await expect(v.resolve('vault://dev/test/none')).rejects.toMatchObject({ code: 'not_found' });
    await expect(v.resolve('AKID-TEST-0001')).rejects.toMatchObject({ code: 'invalid_ref' });
  });
  it('is BLOCKED in a production profile (D-12 / HG-01-02)', () => {
    expect(() => new FileVaultClient({ path: file, env: 'production' })).toThrow(VaultError);
  });
  it('memory vault works for tests', async () => {
    const m = await new MemoryVaultClient({ 'vault://t/x': { k: 'v-value-123' } }).resolve(
      'vault://t/x',
    );
    expect(m.fields.k).toBe('v-value-123');
  });
});

describe('TokenBucket and CircuitBreaker on a simulated clock', () => {
  it('bucket refills with time', () => {
    const c = new SimClock();
    const b = new TokenBucket(2, 1, c);
    expect([b.tryTake(), b.tryTake(), b.tryTake()]).toEqual([true, true, false]);
    c.advance(1000);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
  });
  it('breaker opens after the threshold, half-opens after the cool-down, one trial at a time', () => {
    const c = new SimClock();
    const br = new CircuitBreaker(c, 3, 10_000);
    for (let i = 0; i < 3; i++) {
      expect(br.allow()).toBe(true);
      br.failure();
    }
    expect(br.snapshot().state).toBe('open');
    expect(br.allow()).toBe(false);
    c.advance(10_000);
    expect(br.allow()).toBe(true); // trial
    expect(br.allow()).toBe(false); // only one trial
    br.failure();
    expect(br.snapshot().state).toBe('open');
    c.advance(10_000);
    expect(br.allow()).toBe(true);
    br.success();
    expect(br.snapshot().state).toBe('closed');
  });
});
