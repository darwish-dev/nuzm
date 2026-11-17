import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_IDS,
  ERROR_CATEGORIES,
  ERROR_CATEGORY_RETRYABLE,
  EgressDeniedError,
  Redactor,
  REDACTED,
  assertEgressAllowed,
  completeCapabilities,
  idempotencyToken,
  isSupported,
  isVaultRef,
  orgTag,
} from './index';

const root = join(__dirname, '../../../..');

describe('capability vocabulary', () => {
  it('matches spec/providers/capabilities.schema.json exactly', () => {
    const schema = JSON.parse(
      readFileSync(join(root, 'spec/providers/capabilities.schema.json'), 'utf8'),
    ) as {
      $defs: { capabilityId: { enum: string[] } };
    };
    expect([...schema.$defs.capabilityId.enum].sort()).toEqual([...CAPABILITY_IDS].sort());
  });
  it('treats unknown and missing as unsupported', () => {
    const caps = completeCapabilities({
      'compute.provision': 'supported',
      'compute.metrics': 'unsupported',
    });
    expect(isSupported(caps, 'compute.provision')).toBe(true);
    expect(isSupported(caps, 'compute.metrics')).toBe(false);
    expect(caps['compute.action.resize']).toBe('unknown');
    expect(isSupported(caps, 'compute.action.resize')).toBe(false);
    expect(isSupported(undefined, 'compute.provision')).toBe(false);
  });
});

describe('error normalization table', () => {
  it('has a retryable default for every category', () => {
    expect(ERROR_CATEGORIES.sort()).toEqual(
      [
        'auth',
        'capacity',
        'conflict',
        'not_found',
        'provider_outage',
        'quota',
        'rate_limit',
        'unknown',
        'unsupported',
        'validation',
      ].sort(),
    );
    expect(ERROR_CATEGORY_RETRYABLE.rate_limit).toBe(true);
    expect(ERROR_CATEGORY_RETRYABLE.auth).toBe(false);
  });
});

describe('vault references', () => {
  it('accepts only vault:// references', () => {
    expect(isVaultRef('vault://dev/alibaba/sandbox')).toBe(true);
    for (const bad of [
      'not-a-vault-reference-0001',
      'vault:/x',
      'https://vault/x',
      'vault://',
      '',
      'vault://a b',
      'vault://../etc/passwd ',
    ])
      expect(isVaultRef(bad)).toBe(false);
  });
});

describe('Redactor (canary secret)', () => {
  const canary = 'CANARY-8c1d-SECRET-VALUE';
  it('removes a registered value under an innocent key, in nested data, and in encoded forms', () => {
    const r = new Redactor().register(canary);
    const out = r.deep({
      note: `hello ${canary}`,
      nested: [{ x: Buffer.from(canary).toString('base64') }],
      url: `https://x/?q=${encodeURIComponent(canary)}`,
    });
    expect(JSON.stringify(out)).not.toContain(canary);
    expect(r.leaks(out)).toBe(false);
    expect(r.leaks({ a: canary })).toBe(true);
  });
  it('redacts by key name even for unregistered values', () => {
    const out = new Redactor().deep({
      Authorization: 'Bearer abc',
      accessKeySecret: 'zzzzzzzz',
      ok: 1,
    });
    expect(out).toEqual({ Authorization: REDACTED, accessKeySecret: REDACTED, ok: 1 });
  });
});

describe('egress allow-list / SSRF guard', () => {
  const p = { adapterId: 'x', hosts: ['api.example.com', '*.cloud.example'] };
  it('allows listed https hosts only', () => {
    expect(assertEgressAllowed('https://api.example.com/v1', p).hostname).toBe('api.example.com');
    expect(assertEgressAllowed('https://eu.cloud.example/x', p).hostname).toBe('eu.cloud.example');
  });
  it.each([
    'http://api.example.com/',
    'https://evil.example.com/',
    'https://cloud.example/',
    'https://127.0.0.1/',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/',
    'https://localhost/',
    'https://user:pw@api.example.com/',
    'not a url',
  ])('refuses %s', (u) => {
    expect(() => assertEgressAllowed(u, p)).toThrow(EgressDeniedError);
  });
  it('an empty allow-list means no outbound calls at all', () => {
    expect(() =>
      assertEgressAllowed('https://api.example.com/', { adapterId: 'x', hosts: [] }),
    ).toThrow(EgressDeniedError);
  });
  it('loopback is reachable only with allowLoopback and still needs a list entry', () => {
    expect(() =>
      assertEgressAllowed('http://127.0.0.1:9/', { adapterId: 'x', hosts: ['127.0.0.1'] }),
    ).toThrow(EgressDeniedError);
    expect(
      assertEgressAllowed('http://127.0.0.1:9/', {
        adapterId: 'x',
        hosts: ['127.0.0.1'],
        allowLoopback: true,
      }).port,
    ).toBe('9');
  });
});

describe('idempotency token', () => {
  it('is deterministic sha256 and org tags are opaque', () => {
    expect(idempotencyToken('o', 'p', 's')).toMatch(/^[0-9a-f]{64}$/);
    expect(orgTag('org-1')).toMatch(/^[0-9a-f]{16}$/);
    expect(orgTag('org-1')).not.toContain('org');
  });
});
