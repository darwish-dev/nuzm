import { describe, expect, it } from 'vitest';
import { ProblemException } from '../../../common/errors';
import {
  ALLOWED_UPLOAD_SUFFIXES,
  UPLOAD_LIMITS,
  oneOf,
  slugify,
  stringList,
  text,
  validateFilename,
} from './model';

describe('validateFilename: a package name is data, never a path or an executable', () => {
  it.each([
    'theme.zip',
    'Theme Pack.ZIP',
    'a.b.tar.gz',
    'spec.yaml',
    'نظام.zip',
    'guide.pdf',
    'shot.webp',
  ])('accepts %s', (n) => {
    expect(validateFilename(n)).toBe(n);
  });
  it.each([
    ['', 'validation_failed'],
    ['x'.repeat(256) + '.zip', 'validation_failed'],
    ['../up.zip', 'knowledge_archive_rejected'],
    ['a/b.zip', 'knowledge_archive_rejected'],
    ['a\\b.zip', 'knowledge_archive_rejected'],
    ['.env.zip', 'knowledge_archive_rejected'],
    ['a..zip', 'knowledge_archive_rejected'],
    ['a\nb.zip', 'knowledge_archive_rejected'],
    ['tool.exe', 'knowledge_archive_rejected'],
    ['run.sh', 'knowledge_archive_rejected'],
    ['logo.svg', 'knowledge_archive_rejected'],
    ['noextension', 'knowledge_archive_rejected'],
  ])('refuses %j with %s', (n, code) => {
    try {
      validateFilename(n);
      expect.unreachable();
    } catch (e) {
      expect((e as ProblemException).code).toBe(code);
    }
  });
  it('refuses a non-string', () => {
    expect(() => validateFilename(5)).toThrow(ProblemException);
  });
  it('never allows a script or executable suffix', () => {
    for (const bad of [
      '.exe',
      '.sh',
      '.bat',
      '.js',
      '.svg',
      '.html',
      '.dll',
      '.jar',
      '.apk',
      '.ps1',
    ])
      expect(ALLOWED_UPLOAD_SUFFIXES).not.toContain(bad);
  });
});

describe('limits are sane and consistent', () => {
  it('the part size range allows at least one part and the largest upload fits in the part count', () => {
    expect(UPLOAD_LIMITS.defaultPartSize).toBeGreaterThanOrEqual(UPLOAD_LIMITS.minPartSize);
    expect(UPLOAD_LIMITS.defaultPartSize).toBeLessThanOrEqual(UPLOAD_LIMITS.maxPartSize);
    expect(Math.ceil(UPLOAD_LIMITS.maxBytes / UPLOAD_LIMITS.defaultPartSize)).toBeLessThanOrEqual(
      UPLOAD_LIMITS.maxParts,
    );
  });
});

describe('field helpers', () => {
  it('slugify gives a url-safe stem and a neutral fallback for names with no latin letters', () => {
    expect(slugify('Modern SaaS Dashboard!')).toBe('modern-saas-dashboard');
    expect(slugify('  --A__B--  ')).toBe('a-b');
    expect(slugify('نظام إدارة')).toBe('resource');
    expect(slugify('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
  it('oneOf, text and stringList validate and normalise', () => {
    expect(oneOf(['A', 'B'] as const, 'A', 'f')).toBe('A');
    expect(oneOf(['A'] as const, undefined, 'f', true)).toBeUndefined();
    expect(() => oneOf(['A'] as const, 'Z', 'f')).toThrow(ProblemException);
    expect(() => oneOf(['A'] as const, undefined, 'f')).toThrow(ProblemException);
    expect(text('  hi ', 'f', 10)).toBe('hi');
    expect(text(undefined, 'f', 10)).toBeNull();
    expect(() => text('   ', 'f', 10)).toThrow(ProblemException);
    expect(() => text('x'.repeat(11), 'f', 10)).toThrow(ProblemException);
    expect(stringList(['a', 'a', 'b'], 'f')).toEqual(['a', 'b']);
    expect(() => stringList('a', 'f')).toThrow(ProblemException);
    expect(() => stringList([1], 'f')).toThrow(ProblemException);
    expect(() => stringList(new Array(31).fill('x'), 'f')).toThrow(ProblemException);
  });
});
