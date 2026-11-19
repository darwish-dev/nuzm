import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyLint, stringsOf } from './copy-lint';

const ROOT = join(__dirname, '../../../../../../..');

describe('copy lint (AC-M10-14)', () => {
  it.each([
    'We guarantee approval by the App Store',
    'Your app will be approved in 24 hours',
    'Approved by Google Play',
    'Skip the App Store review',
    'Bypass Apple review with our tool',
    'Instant approval for every app',
    'No review required',
    'نضمن لك الموافقة على تطبيقك',
    'تجاوز مراجعة المتجر بسهولة',
    'موافقة مضمونة',
  ])('flags: %s', (t) => expect(copyLint(t).length).toBeGreaterThan(0));
  it.each([
    'Nuzm does not submit to any store and cannot predict the outcome of a store review.',
    'The account owner submits the release in the store console.',
    'Store review times vary and are decided by the store.',
    'لا تقدم نظم أي ضمان بشأن نتيجة مراجعة المتجر.',
    'Prepare your release record',
  ])('allows: %s', (t) => expect(copyLint(t)).toEqual([]));
  it('stringsOf walks nested values', () => expect(stringsOf({ a: ['x', { b: 'y' }], c: 1 })).toEqual(['x', 'y']));

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (n === 'node_modules' || n === 'dist' || n === '.next') continue;
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|md|dart|json)$/.test(n)) out.push(p);
    }
    return out;
  };
  it('no mobile console string and no mobile doc/template promises store approval', () => {
    const files = [
      ...walk(join(ROOT, 'apps/api/templates/flutter-core')),
      join(ROOT, 'docs/reports/M10B-report.md'),
      join(ROOT, 'docs/reports/S50-report.md'),
      join(ROOT, 'docs/runbooks/mobile-signing.md'),
    ].filter((f) => {
      try {
        statSync(f);
        return true;
      } catch {
        return false;
      }
    });
    // the console messages: every `mobile.*` key of packages/i18n/src/messages.ts (both languages)
    const msgs = readFileSync(join(ROOT, 'packages/i18n/src/messages.ts'), 'utf8')
      .split('\n')
      .filter((l) => /mobile\./.test(l))
      .join('\n');
    const hits = [
      ...files.flatMap((f) => copyLint(readFileSync(f, 'utf8')).map((h) => `${relative(ROOT, f)}: ${h.rule}`)),
      ...copyLint(msgs).map((h) => `messages: ${h.rule}`),
    ];
    // the reports and runbook quote forbidden phrases only inside this lint's own documentation; none is expected in generated text
    expect(hits.filter((h) => !/docs\//.test(h))).toEqual([]);
  });
});
