import { describe, expect, it } from 'vitest';
import { PRODUCT_LINE_OF_PROVIDER, productLineOf } from './offer.service';

describe('Nuzm Cloud product lines', () => {
  it('each infrastructure provider maps to one Nuzm product line, and an unmapped one is the generic line', () => {
    expect(productLineOf('alibaba')).toBe('nova');
    expect(productLineOf('huawei')).toBe('atlas');
    expect(productLineOf('contabo')).toBe('orbit');
    expect(productLineOf('mock')).toBe('spark');
    expect(productLineOf('some-new-vendor')).toBe('core');
  });
  it('a product line never contains the name of the provider it stands for', () => {
    for (const [provider, line] of Object.entries(PRODUCT_LINE_OF_PROVIDER))
      expect(line).not.toContain(provider);
    expect(new Set(Object.values(PRODUCT_LINE_OF_PROVIDER)).size).toBe(
      Object.keys(PRODUCT_LINE_OF_PROVIDER).length,
    ); // one line per provider
  });
});
