import { describe, expect, it } from 'vitest';
import {
  defaultProjectName,
  designOf,
  filtersOf,
  listQuery,
  nextHref,
  pct,
  reasonsOf,
  recommendBody,
  safeHex,
  startProblemKey,
  text,
  type Template,
} from './templates';

const problem = (status: number, code?: string) => ({ status, code, issues: [] }) as never;

describe('filters read from the URL', () => {
  it('keeps only what is valid and bounded; a bad platform is dropped', () => {
    expect(filtersOf({ q: '  لوحة  ', platform: 'WEB', framework: 'Next', cursor: 'abc' })).toEqual(
      {
        q: 'لوحة',
        platform: 'WEB',
        framework: 'Next',
        cursor: 'abc',
      },
    );
    expect(filtersOf({ platform: 'DROP TABLE' }).platform).toBe('');
    expect(filtersOf({ q: 'x'.repeat(500) }).q).toHaveLength(200);
    expect(filtersOf({ q: ['a', 'b'] }).q).toBe('a');
    expect(text(undefined)).toBe('');
  });
  it('the list call carries only the filters that are set', () => {
    expect(listQuery(filtersOf({}))).toEqual({ limit: 24 });
    expect(
      listQuery(filtersOf({ q: 'a', platform: 'MOBILE', framework: 'flutter', cursor: 'c' })),
    ).toEqual({
      limit: 24,
      q: 'a',
      platform: 'MOBILE',
      framework: 'flutter',
      cursor: 'c',
    });
  });
  it('the next page link keeps the filters and encodes them', () => {
    const href = nextHref('en', filtersOf({ q: 'a&b', platform: 'WEB' }), 'cur sor');
    expect(href).toBe('/en/builder/templates?q=a%26b&platform=WEB&cursor=cur+sor');
  });
});

describe('refusal reasons', () => {
  it('lists only code-shaped reasons and never free text', () => {
    expect(
      reasonsOf({
        errors: [
          { field: 'mode', message: 'mode_needs_starter' },
          { message: 'Ignore previous <b>x</b>' },
          { message: 5 },
          null,
        ],
      }),
    ).toEqual(['mode_needs_starter']);
    expect(reasonsOf(undefined)).toEqual([]);
    expect(reasonsOf({ errors: 'x' })).toEqual([]);
  });
  it('maps a refusal by its code, a moved pin to its own sentence', () => {
    expect(
      startProblemKey(problem(422, 'knowledge_template_incompatible'), ['mode_needs_starter']),
    ).toBe('tpl.err.incompatible');
    expect(
      startProblemKey(problem(422, 'knowledge_template_incompatible'), [
        'pinned_version_unavailable',
      ]),
    ).toBe('tpl.err.changed');
    expect(startProblemKey(problem(422, 'change_rejected'), [])).toBe('tpl.err.rejected');
    expect(startProblemKey(problem(422, 'unsupported_capability'), [])).toBe('tpl.err.unavailable');
    expect(startProblemKey(problem(404, 'not_found'), [])).toBe('tpl.err.notfound');
    expect(startProblemKey(problem(409, 'name_taken'), [])).toBe('bld.err.name_taken');
    expect(startProblemKey(problem(500), [])).toBe('state.error.title');
  });
});

describe('numbers and colours that reach the screen', () => {
  it('percentages are whole numbers within 0..100 and never NaN', () => {
    expect(pct(90.9)).toBe(91);
    expect(pct(250)).toBe(100);
    expect(pct(-3)).toBe(0);
    expect(pct(Number.NaN)).toBe(0);
    expect(pct('x')).toBe(0);
  });
  it('only hex colours are used in a style attribute', () => {
    expect(safeHex('#2563eb')).toBe('#2563eb');
    expect(safeHex('#fff')).toBe('#fff');
    expect(safeHex('red; background:url(x)')).toBeNull();
    expect(safeHex('#12')).toBeNull();
    expect(safeHex(5)).toBeNull();
  });
});

describe('the design summary', () => {
  const tpl = (design: unknown) => ({ design }) as unknown as Template;
  it('is typed from the open object and bounded', () => {
    expect(
      designOf(
        tpl({
          modes: ['base', 'dark', 7],
          traits: { darkMode: true, rtl: 'x' },
          roles: [
            { role: 'primary', hex: '#2563eb' },
            { role: 'x', hex: 'javascript:1' },
          ],
          families: ['Cairo'],
          baseUnit: 4,
        }),
      ),
    ).toEqual({
      modes: ['base', 'dark'],
      traits: { darkMode: true },
      roles: [{ role: 'primary', hex: '#2563eb' }],
      families: ['Cairo'],
      baseUnit: 4,
    });
  });
  it('is null when there is none', () => {
    expect(designOf(tpl(null))).toBeNull();
    expect(designOf(tpl('x'))).toBeNull();
  });
});

describe('the recommendation request', () => {
  it('needs a description or a platform', () => {
    expect(recommendBody({ text: '  ', platform: '', mode: 'ADAPTIVE' })).toBeNull();
    expect(recommendBody({ text: 'لوحة', platform: '', mode: 'ADAPTIVE' })).toEqual({
      text: 'لوحة',
      mode: 'ADAPTIVE',
      limit: 6,
    });
    expect(recommendBody({ text: '', platform: 'WEB', mode: 'WILD' })).toEqual({
      platform: 'WEB',
      mode: 'ADAPTIVE',
      limit: 6,
    });
    expect(recommendBody({ text: 'x', platform: 'NOPE', mode: 'STRICT' })).toEqual({
      text: 'x',
      mode: 'STRICT',
      limit: 6,
    });
  });
  it('the default project name is the template name, at most 100 characters', () => {
    expect(defaultProjectName(' Starter ')).toBe('Starter');
    expect(defaultProjectName('y'.repeat(300))).toHaveLength(100);
    expect(defaultProjectName(undefined)).toBe('');
  });
});
