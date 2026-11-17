import { describe, expect, it } from 'vitest';
import { ProblemException } from '../../../common/errors';
import { parseRopaInput } from './ropa.service';

const ok = (over: Record<string, unknown> = {}) => ({
  entryKey: 'activity:support',
  kind: 'activity',
  activity: 'Customer support',
  purpose: 'Answer customer questions',
  dataClasses: ['personal'],
  processors: [],
  regions: ['SA'],
  ...over,
});
const fields = (raw: Record<string, unknown>) => {
  try {
    parseRopaInput(raw);
    return [];
  } catch (e) {
    return ((e as ProblemException).errors as { field: string }[]).map((x) => x.field);
  }
};

describe('ROPA input validation', () => {
  it('accepts a complete entry and defaults the status to draft', () => {
    const r = parseRopaInput(ok());
    expect(r).toMatchObject({
      entryKey: 'activity:support',
      status: 'draft',
      baseVersion: null,
      retentionRef: null,
      changeNote: null,
    });
  });
  it('accepts processors with ISO and group regions and an optional contract reference', () => {
    const r = parseRopaInput(
      ok({
        processors: [
          {
            name: 'Example PSP',
            role: 'processor',
            region: 'SA',
            dataClasses: ['financial'],
            contractRef: 'DPA-2026-01',
          },
          {
            name: 'Sub vendor',
            role: 'sub-processor',
            region: 'gcc',
            dataClasses: ['financial', 'personal'],
          },
        ],
        regions: ['SA', 'AE', 'eu'],
      }),
    );
    expect(r.processors).toHaveLength(2);
    expect(r.processors[1]!.contractRef).toBeNull();
  });
  it.each([
    ['a bad key', { entryKey: 'Activity Support' }, 'entryKey'],
    ['a too-short key', { entryKey: 'ab' }, 'entryKey'],
    ['no activity', { activity: '' }, 'activity'],
    ['a purpose over 500 characters', { purpose: 'x'.repeat(501) }, 'purpose'],
    ['no data classes', { dataClasses: [] }, 'dataClasses'],
    ['a repeated data class', { dataClasses: ['personal', 'personal'] }, 'dataClasses'],
    ['a non-list of processors', { processors: 'none' }, 'processors'],
    [
      'a processor without a name',
      { processors: [{ name: '', role: 'processor', region: 'SA', dataClasses: ['personal'] }] },
      'processors[0].name',
    ],
    [
      'a processor with a bad role',
      { processors: [{ name: 'x', role: 'controller', region: 'SA', dataClasses: ['personal'] }] },
      'processors[0].role',
    ],
    [
      'a processor with a lowercase country',
      { processors: [{ name: 'x', role: 'processor', region: 'sa', dataClasses: ['personal'] }] },
      'processors[0].region',
    ],
    [
      'a processor with no data classes',
      { processors: [{ name: 'x', role: 'processor', region: 'SA', dataClasses: [] }] },
      'processors[0].dataClasses',
    ],
    ['a bad region', { regions: ['Saudi Arabia'] }, 'regions'],
    ['a bad kind', { kind: 'other' }, 'kind'],
    ['an adapter entry without an adapter kind', { kind: 'adapter' }, 'adapterKind'],
    ['an adapter kind on an activity', { adapterKind: 'psp' }, 'adapterKind'],
    ['status placeholder (only the seed has it)', { status: 'placeholder' }, 'status'],
    ['a zero base version', { baseVersion: 0 }, 'baseVersion'],
  ])('rejects %s', (_n, over, field) => {
    expect(fields(ok(over))).toContain(field);
  });
  it('reports every bad field at once', () => {
    expect(fields({}).sort()).toEqual([
      'activity',
      'dataClasses',
      'entryKey',
      'processors',
      'purpose',
      'regions',
    ]);
  });
});
