import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ERROR_REGISTRY } from './errors';

describe('error code registry', () => {
  it('matches spec/openapi/errors.yaml exactly (codes, statuses, titles)', () => {
    const yaml = parse(
      readFileSync(join(__dirname, '../../../../spec/openapi/errors.yaml'), 'utf8'),
    ) as {
      errors: Record<string, { status: number; title: string }>;
    };
    expect(yaml.errors).toEqual(ERROR_REGISTRY);
  });
});
