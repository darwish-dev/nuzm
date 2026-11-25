import { describe, expect, it } from 'vitest';
import { DEV_FEATURE_FLAGS } from './dev-flags';

describe('development feature flags', () => {
  it('never switch the app builder to its in-memory stand-ins (that hides every real project)', () => {
    expect(DEV_FEATURE_FLAGS).not.toContain('app_builder.m09_stubs');
  });
  it('still turn on the app builder and the other capabilities', () => {
    expect(DEV_FEATURE_FLAGS).toEqual(
      expect.arrayContaining(['ai.enabled', 'app_builder.enabled', 'mobile_builder.enabled']),
    );
  });
});
