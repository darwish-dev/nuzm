import { describe, expect, it } from 'vitest';
import { csvCell, fromMinor, toCsv, toMinor, trimDec } from './billing';

describe('toMinor (money input without floats)', () => {
  it.each([
    ['1', '100'],
    ['1000', '100000'],
    ['1000.5', '100050'],
    ['0.05', '5'],
    ['12.34', '1234'],
    [' 7 ', '700'],
  ])('%s → %s', (i, o) => expect(toMinor(i)).toBe(o));
  it.each([
    '',
    '0',
    '0.00',
    '-1',
    '1.234',
    '1e3',
    '1,5',
    'abc',
    '١٢٣',
    '1.',
    '.5',
    '99999999999999999',
  ])('rejects %j', (i) => expect(toMinor(i)).toBeNull());
  it('round-trips with fromMinor', () => {
    for (const m of ['1', '5', '99', '100', '100050', '123456789'])
      expect(toMinor(fromMinor(m))).toBe(m);
  });
});

describe('trimDec', () => {
  it.each([
    ['2.00000000', '2'],
    ['0.50000000', '0.5'],
    ['0.00000000', '0'],
    ['100', '100'],
    ['10.10', '10.1'],
  ])('%s → %s', (i, o) => expect(trimDec(i)).toBe(o));
});

describe('CSV export safety', () => {
  it.each([
    ['=HYPERLINK("http://evil")', `"'=HYPERLINK(""http://evil"")"`],
    ['+1+1', `'+1+1`],
    ['-2+3', `'-2+3`],
    ['@SUM(A1)', `'@SUM(A1)`],
    ['\tcmd', `'\tcmd`],
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
  ])('%j', (i, o) => expect(csvCell(i)).toBe(o));
  it('builds CRLF rows', () =>
    expect(
      toCsv([
        ['a', 'b'],
        ['=x', '1'],
      ]),
    ).toBe("a,b\r\n'=x,1\r\n"));
});
