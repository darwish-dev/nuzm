import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adapterKindsFromDocs,
  classesInUse,
  evaluateRopaCoverage,
  type RopaEntryRef,
} from './ropa-coverage';
import { loadManifest } from './migrations';

const root = join(__dirname, '../../..');
const entry = (
  adapterKind: string | null,
  dataClasses: string[],
  key = adapterKind ? `adapter:${adapterKind}` : 'activity:x',
): RopaEntryRef => ({
  entryKey: key,
  kind: adapterKind ? 'adapter' : 'activity',
  adapterKind,
  dataClasses,
});

describe('adapter kinds in docs/09', () => {
  const kinds = adapterKindsFromDocs(
    readFileSync(join(root, 'docs/09-provider-adapter-interfaces.md'), 'utf8'),
  );
  it('reads all eleven kinds of §1', () => {
    expect(kinds).toEqual([
      'compute',
      'hosting',
      'registrar',
      'database',
      'cache',
      'object-storage',
      'transactional-email',
      'mailbox',
      'psp',
      'einvoice',
      'model',
    ]);
  });
  it('returns nothing for text without the contract', () => {
    expect(adapterKindsFromDocs('no adapters here')).toEqual([]);
  });
});

describe('ROPA coverage rules (compliance:ropa-coverage, AC-M04-04)', () => {
  it('passes when every adapter kind has an entry and every class in use is listed', () => {
    expect(
      evaluateRopaCoverage(
        ['psp', 'model'],
        ['personal', 'financial'],
        [entry('psp', ['financial']), entry('model', ['personal'])],
      ),
    ).toEqual([]);
  });
  it('reports an adapter kind without an entry and a stale entry for a kind that is gone', () => {
    const v = evaluateRopaCoverage(
      ['psp', 'model'],
      [],
      [entry('psp', ['financial']), entry('fax', ['personal'])],
    );
    expect(v.map((x) => [x.kind, x.object])).toEqual([
      ['adapter_kind_without_entry', 'model'],
      ['entry_for_unknown_adapter_kind', 'fax'],
    ]);
  });
  it('reports a data class in use that no entry lists', () => {
    const v = evaluateRopaCoverage(
      ['psp'],
      ['personal', 'credentials'],
      [entry('psp', ['personal'])],
    );
    expect(v.map((x) => [x.kind, x.object])).toEqual([['data_class_without_entry', 'credentials']]);
  });
  it('an activity entry covers data classes but not an adapter kind', () => {
    const v = evaluateRopaCoverage(['psp'], ['personal'], [entry(null, ['personal'])]);
    expect(v.map((x) => x.kind)).toEqual(['adapter_kind_without_entry']);
  });
  it('refuses to pass when no adapter kinds could be read', () => {
    expect(evaluateRopaCoverage([], [], []).map((x) => x.kind)).toEqual(['no_adapter_kinds_found']);
  });
  it('classes in use come from the committed classification manifest and are all six', () => {
    expect(classesInUse(loadManifest(join(root, 'spec/db/ownership.yaml')))).toEqual([
      'credentials',
      'customer-content',
      'financial',
      'internal',
      'personal',
      'public',
    ]);
  });
});
