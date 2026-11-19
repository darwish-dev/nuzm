import { describe, expect, it } from 'vitest';
import { normalizeSections } from './assemble';

describe('normalizeSections: a model section can never crash an assembled run', () => {
  it('keeps a well-formed section as it is', () => {
    const s = { id: 'hero1', type: 'hero', props: { heading: { ar: 'م', en: 'M' } } };
    expect(normalizeSections('home', [s])).toEqual([s]);
  });
  it('a section with no props gets an empty props object (the failure of a real run: reading imageAssetId of undefined)', () => {
    const out = normalizeSections('contact', [{ id: 'c1', type: 'contact_form' }]);
    expect(out[0]!.props).toEqual({});
    expect(() => (out[0]!.props as Record<string, unknown>).imageAssetId).not.toThrow();
    // props that is not an object is replaced too
    expect(normalizeSections('p', [{ id: 'a', type: 'text', props: 'oops' }])[0]!.props).toEqual(
      {},
    );
    expect(normalizeSections('p', [{ id: 'a', type: 'text', props: [1] }])[0]!.props).toEqual({});
  });
  it('a missing id is made up from the page and position, and duplicates are made unique', () => {
    const out = normalizeSections('about', [
      { type: 'text', props: {} },
      { id: 'x', type: 'text', props: {} },
      { id: 'x', type: 'text', props: {} },
    ]);
    expect(out.map((s) => s.id)).toEqual(['about-1', 'x', 'x-2']);
  });
  it('drops what is not an object, and tolerates a missing list', () => {
    expect(
      normalizeSections('p', [null, 'x', 3, [], { id: 'ok', type: 'text', props: {} }]),
    ).toHaveLength(1);
    expect(normalizeSections('p', undefined)).toEqual([]);
    expect(normalizeSections('p', 'nope')).toEqual([]);
  });
});
