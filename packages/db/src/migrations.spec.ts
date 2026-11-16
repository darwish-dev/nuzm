import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checksum, discoverMigrations, parseRange, type Manifest } from './migrations';

const manifest: Manifest = {
  schemas: {
    platform: { owner_module: 'platform', created_by: 'M01', extended_by: ['M02'], tables: [] },
    billing: { owner_module: 'billing', created_by: 'M02', extended_by: [], tables: [] },
  },
  tenant_less: [],
  rls_keyed: [],
  migration_ranges: { M01: '0001-0199', M02: '0200-0299' },
};

function layout(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'nuzm-mig-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

describe('migration discovery', () => {
  it('parses ranges and rejects malformed ones', () => {
    expect(parseRange('0001-0199')).toEqual([1, 199]);
    expect(() => parseRange('1-199')).toThrow();
  });

  it('accepts a valid up/down pair and computes a checksum', () => {
    const dir = layout({
      'platform/0001__platform__init.sql': 'SELECT 1;',
      'platform/0001__platform__init.down.sql': 'SELECT 2;',
    });
    const [m] = discoverMigrations(dir, manifest);
    expect(m?.ordinal).toBe(1);
    expect(m?.checksum).toBe(checksum('SELECT 1;'));
    expect(m?.downSql).toBe('SELECT 2;');
  });

  it.each([
    ['missing down file', { 'platform/0001__platform__a.sql': 'x' }, /missing \.down\.sql/],
    [
      'ordinal outside the owner range',
      { 'platform/0500__platform__a.sql': 'x', 'platform/0500__platform__a.down.sql': 'x' },
      /outside ranges/,
    ],
    [
      'schema not in manifest',
      { 'ghost/0001__ghost__a.sql': 'x', 'ghost/0001__ghost__a.down.sql': 'x' },
      /not a schema in the ownership manifest/,
    ],
    [
      'schema in name differs from directory',
      { 'platform/0001__billing__a.sql': 'x', 'platform/0001__billing__a.down.sql': 'x' },
      /differs from directory/,
    ],
    ['bad file name', { 'platform/migration.sql': 'x' }, /name must match/],
    [
      'duplicate ordinal across schemas',
      {
        'platform/0001__platform__a.sql': 'x',
        'platform/0001__platform__a.down.sql': 'x',
        'billing/0001__billing__b.sql': 'x',
        'billing/0001__billing__b.down.sql': 'x',
      },
      /outside ranges|used twice/,
    ],
  ])('rejects: %s', (_name, files, re) => {
    expect(() => discoverMigrations(layout(files), manifest)).toThrow(re);
  });

  it('allows an extending milestone range on an owner schema', () => {
    const dir = layout({
      'platform/0250__platform__ext.sql': 'x',
      'platform/0250__platform__ext.down.sql': 'x',
    });
    expect(discoverMigrations(dir, manifest)).toHaveLength(1);
  });
});
