import { describe, expect, it } from 'vitest';
import { loadPurposes, parsePurposes } from './purposes';

const ok = (extra = '') => `
version: 1
status: PROPOSAL
purposes:
  - id: marketing_email
    category: marketing
    textVersion: v1
    label: { ar: تسويق, en: Marketing }
    text: { ar: نص, en: Text }${extra}
`;

describe('consent purposes (spec/compliance/purposes.yaml)', () => {
  it('parses a valid catalogue and indexes it by id', () => {
    const c = parsePurposes(ok());
    expect(c.purposes).toHaveLength(1);
    expect(c.byId.get('marketing_email')).toMatchObject({
      textVersion: 'v1',
      pendingCounsel: false,
    });
  });
  it('flags a placeholder text as pending counsel', () => {
    const c = parsePurposes(
      ok().replace(
        '{ ar: نص, en: Text }',
        '{ ar: COUNSEL-TEXT-REQUIRED, en: COUNSEL-TEXT-REQUIRED }',
      ),
    );
    expect(c.byId.get('marketing_email')!.pendingCounsel).toBe(true);
  });
  it.each([
    ['a bad id', ok().replace('marketing_email', 'Marketing Email'), /bad purpose id/],
    [
      'a missing Arabic text',
      ok().replace('text: { ar: نص, en: Text }', 'text: { en: Text }'),
      /text.ar is required/,
    ],
    [
      'an empty English label',
      ok().replace('{ ar: تسويق, en: Marketing }', '{ ar: تسويق, en: "" }'),
      /label.en is required/,
    ],
    ['no textVersion', ok().replace('    textVersion: v1\n', ''), /textVersion is required/],
    [
      'a bad textVersion',
      ok().replace('textVersion: v1', 'textVersion: "v 1!"'),
      /textVersion is required/,
    ],
    ['no category', ok().replace('    category: marketing\n', ''), /category is required/],
    ['an empty list', 'version: 1\nstatus: PROPOSAL\npurposes: []\n', /non-empty/],
    ['no version', ok().replace('version: 1', 'version: 0'), /version/],
  ])('refuses %s', (_n, text, re) => {
    expect(() => parsePurposes(text)).toThrow(re);
  });
  it('refuses a duplicate purpose', () => {
    const dup =
      ok() +
      `  - id: marketing_email\n    category: x\n    textVersion: v1\n    label: { ar: a, en: b }\n    text: { ar: a, en: b }\n`;
    expect(() => parsePurposes(dup)).toThrow(/duplicate purpose/);
  });
  it('the committed catalogue loads; every wording is still a counsel placeholder (HG-04-01)', () => {
    const c = loadPurposes();
    expect(c.purposes.length).toBeGreaterThanOrEqual(6);
    expect(c.status).toBe('PROPOSAL');
    for (const p of c.purposes) expect(p.pendingCounsel, p.id).toBe(true);
  });
});
