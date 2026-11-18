import { describe, expect, it } from 'vitest';
import { canonicalJson, hashOf } from './core';
import { validate } from './schema';

describe('canonical json and hash', () => {
  it('is independent of key order and rejects non-finite numbers', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });
});
describe('schema subset', () => {
  const s = {
    type: 'object',
    required: ['a'],
    additionalProperties: false,
    properties: {
      a: { type: 'integer', minimum: 1 },
      b: { type: 'array', items: { enum: ['x', 'y'] }, uniqueItems: true },
    },
  } as const;
  it('accepts valid and reports every problem otherwise', () => {
    expect(validate(s, { a: 1, b: ['x'] })).toEqual([]);
    const e = validate(s, { a: 0, b: ['x', 'x', 'z'], c: 1 });
    expect(e.join('|')).toMatch(/\$\.a: below 1/);
    expect(e.join('|')).toMatch(/\$\.b: items must be unique/);
    expect(e.join('|')).toMatch(/\$\.b\[2\]: must be one of x, y/);
    expect(e.join('|')).toMatch(/\$\.c: is not allowed/);
    expect(validate(s, {}).join()).toMatch(/\$\.a: is required/);
    expect(validate(s, [])[0]).toMatch(/expected object, got array/);
  });
});
