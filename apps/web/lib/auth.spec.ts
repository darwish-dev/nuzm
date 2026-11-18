import { describe, expect, it } from 'vitest';
import { clientPasswordIssue, problemCode, problemField, safeNext } from './auth';

describe('client password check', () => {
  it('mirrors the length and email rules', () => {
    expect(clientPasswordIssue('x'.repeat(11))).toBe('too_short');
    expect(clientPasswordIssue('x'.repeat(129))).toBe('too_long');
    expect(clientPasswordIssue('A@Example.test', 'a@example.test')).toBe('same_as_email');
    expect(clientPasswordIssue('long.address@example.test', 'long.address@example.test')).toBe(
      'same_as_email',
    );
    expect(clientPasswordIssue('a perfectly fine phrase')).toBeNull();
  });
});

describe('safeNext', () => {
  it('keeps same-site paths only', () => {
    expect(safeNext('/en/billing', '/en')).toBe('/en/billing');
    for (const bad of [undefined, '', 'https://evil.test', '//evil.test', '/\\evil.test', 'x'])
      expect(safeNext(bad, '/en')).toBe('/en');
  });
});

describe('problem helpers', () => {
  it('read the code and field errors defensively', () => {
    expect(problemCode({ code: 'email_in_use' })).toBe('email_in_use');
    expect(problemCode(undefined)).toBeUndefined();
    expect(problemField({ errors: [{ field: 'email' }] }, 'email')).toBe(true);
    expect(problemField({}, 'email')).toBe(false);
  });
});
