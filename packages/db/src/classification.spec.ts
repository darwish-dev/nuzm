import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateClassification } from './classification';
import { loadManifest, type Manifest } from './migrations';

const base = (
  cols: Record<string, Record<string, string>>,
  ex: Record<string, string> = {},
  protection: Record<string, string> = {},
): Manifest => ({
  schemas: {},
  tenant_less: [],
  rls_keyed: [],
  migration_ranges: {},
  classification: {
    classes: ['public', 'internal', 'customer-content', 'personal', 'financial', 'credentials'],
    columns: cols,
    exceptions: ex,
    protection,
  },
});
const cat = (...x: [string, string][]) => x.map(([table, column]) => ({ table, column }));

describe('classification coverage rules (compliance:classification-coverage)', () => {
  it('passes when every column is classified with a known class', () => {
    const m = base({ 'a.t': { id: 'internal', email: 'personal' } });
    expect(evaluateClassification(cat(['a.t', 'id'], ['a.t', 'email']), m)).toEqual([]);
  });
  it('fails an unclassified column, including a whole new table', () => {
    const m = base({ 'a.t': { id: 'internal' } });
    const v = evaluateClassification(cat(['a.t', 'id'], ['a.t', 'phone'], ['a.new', 'id']), m);
    expect(v.map((x) => [x.kind, x.object])).toEqual([
      ['unclassified_column', 'a.t.phone'],
      ['unclassified_column', 'a.new.id'],
    ]);
  });
  it('fails a stale entry (column or table that no longer exists) and an unknown class', () => {
    const m = base({
      'a.t': { id: 'internal', gone: 'internal', x: 'secretish' },
      'a.dropped': { id: 'internal' },
    });
    const v = evaluateClassification(cat(['a.t', 'id'], ['a.t', 'x']), m);
    expect(v.map((x) => [x.kind, x.object]).sort()).toEqual([
      ['stale_column', 'a.dropped.id'],
      ['stale_column', 'a.t.gone'],
      ['unknown_class', 'a.t.x'],
    ]);
  });
  it.each([
    ['email', 'looks personal'],
    ['contact_phone', 'looks personal'],
    ['client_ip', 'looks personal'],
    ['token_hash', 'looks credential-bearing'],
    ['totp_secret', 'looks credential-bearing'],
    ['amount_minor', 'looks financial'],
    ['wallet_balance', 'looks financial'],
  ])('a column named %s may not be classed internal or public', (column, why) => {
    for (const weak of ['internal', 'public']) {
      const v = evaluateClassification(cat(['a.t', column]), base({ 'a.t': { [column]: weak } }));
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ kind: 'weak_class', object: `a.t.${column}` });
      expect(v[0]!.detail).toContain(why);
    }
    // the right class passes
    const ok =
      column.includes('token') || column.includes('secret')
        ? 'credentials'
        : column.includes('minor') || column.includes('balance')
          ? 'financial'
          : 'personal';
    const m = base({ 'a.t': { [column]: ok } });
    if (ok === 'credentials') m.classification.protection = { [`a.t.${column}`]: 'hash' };
    // the protection naming rule is exercised separately: only the class rules are under test here
    expect(
      evaluateClassification(cat(['a.t', column]), m).filter(
        (x) => x.kind !== 'protection_mismatch',
      ),
    ).toEqual([]);
  });
  it('a justified exception allows a weak class; a missing reason or a ghost column is itself a failure', () => {
    const c = cat(['a.t', 'email_verified']);
    const m = base(
      { 'a.t': { email_verified: 'internal' } },
      { 'a.t.email_verified': 'a boolean flag, not the address' },
    );
    expect(evaluateClassification(c, m)).toEqual([]);
    const short = base({ 'a.t': { email_verified: 'internal' } }, { 'a.t.email_verified': 'flag' });
    expect(evaluateClassification(c, short).map((x) => x.kind)).toEqual(['bad_exception']);
    const ghost = base(
      { 'a.t': { email_verified: 'internal' } },
      { 'a.t.nope': 'this column does not exist at all' },
    );
    expect(evaluateClassification(c, ghost).map((x) => x.kind)).toContain('bad_exception');
  });
  it('refuses to run with no classes defined', () => {
    const m = base({});
    m.classification.classes = [];
    expect(evaluateClassification([], m)[0]?.kind).toBe('no_classes');
  });
});

describe('credential protection (M04 S13d)', () => {
  it('a credentials column must declare how it is protected', () => {
    const m = base(
      { 'a.t': { token_hash: 'credentials', secret_ref: 'credentials' } },
      {},
      { 'a.t.token_hash': 'hash' },
    );
    const v = evaluateClassification(cat(['a.t', 'token_hash'], ['a.t', 'secret_ref']), m);
    expect(v.map((x) => [x.kind, x.object])).toEqual([
      ['credential_unprotected', 'a.t.secret_ref'],
    ]);
  });
  it('accepts hash, vault_ref, lookup and encrypted on matching names', () => {
    const m = base(
      {
        'a.t': {
          token_hash: 'credentials',
          key_ref: 'credentials',
          prefix: 'credentials',
          pii_enc: 'personal',
        },
      },
      {},
      {
        'a.t.token_hash': 'hash',
        'a.t.key_ref': 'vault_ref',
        'a.t.prefix': 'lookup',
        'a.t.pii_enc': 'encrypted',
      },
    );
    expect(
      evaluateClassification(
        cat(['a.t', 'token_hash'], ['a.t', 'key_ref'], ['a.t', 'prefix'], ['a.t', 'pii_enc']),
        m,
      ),
    ).toEqual([]);
  });
  it('refuses a plaintext-looking secret declared as a hash, an unknown protection and a stale entry', () => {
    const m = base(
      { 'a.t': { api_secret: 'credentials', token: 'credentials' } },
      {},
      { 'a.t.api_secret': 'hash', 'a.t.token': 'rot13', 'a.t.gone': 'hash' },
    );
    const v = evaluateClassification(cat(['a.t', 'api_secret'], ['a.t', 'token']), m);
    expect(v.map((x) => `${x.kind} ${x.object}`).sort()).toEqual([
      'protection_mismatch a.t.api_secret',
      'stale_protection a.t.gone',
      'unknown_protection a.t.token',
    ]);
  });
});

describe('the committed manifest (spec/db/ownership.yaml)', () => {
  const m = loadManifest(join(__dirname, '../../../spec/db/ownership.yaml'));
  it('defines the six D-14 proposal classes', () => {
    expect(m.classification.classes).toEqual([
      'public',
      'internal',
      'customer-content',
      'personal',
      'financial',
      'credentials',
    ]);
  });
  it('uses only defined classes and gives every exception a reason', () => {
    const known = new Set(m.classification.classes);
    for (const [t, cols] of Object.entries(m.classification.columns))
      for (const [c, k] of Object.entries(cols)) expect(known.has(k), `${t}.${c}: ${k}`).toBe(true);
    for (const [fq, why] of Object.entries(m.classification.exceptions))
      expect(why.length, fq).toBeGreaterThanOrEqual(10);
  });
  it('classes credential and personal identifiers strongly', () => {
    const c = m.classification.columns;
    expect(c['identity.sessions']!.token_hash).toBe('credentials');
    expect(c['identity.api_keys']!.secret_hash).toBe('credentials');
    expect(c['identity.users']!.email).toBe('personal');
    expect(c['payments.payment_methods']!.token_ref).toBe('credentials');
    expect(c['compliance.consents']!.subject_ref).toBe('personal');
  });
  it('protects every credentials column and seals the tax profile', () => {
    const creds = Object.entries(m.classification.columns).flatMap(([t, cols]) =>
      Object.entries(cols)
        .filter(([, k]) => k === 'credentials')
        .map(([c]) => `${t}.${c}`),
    );
    expect(creds.length).toBeGreaterThanOrEqual(12);
    for (const fq of creds) expect(m.classification.protection[fq], fq).toBeDefined();
    expect(m.classification.protection['invoicing.tax_profiles.pii_enc']).toBe('encrypted');
    // today no credentials column is "encrypted": they are hashes, vault references or a lookup prefix (no recoverable secret is stored)
    for (const fq of creds) expect(m.classification.protection[fq]).not.toBe('encrypted');
  });
});
