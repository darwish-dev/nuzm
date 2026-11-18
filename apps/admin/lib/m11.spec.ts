import { describe, expect, it } from 'vitest';
import { isProgramOrg, isUuid, moderationBody, moderationErrors, validReasonCode } from './m11';

describe('admin M11 helpers', () => {
  it('reason codes are snake_case', () => {
    expect(validReasonCode('scan_override')).toBe(true);
    expect(validReasonCode('policy_violation')).toBe(true);
    expect(validReasonCode('Scan Override')).toBe(false);
    expect(validReasonCode('x')).toBe(false);
  });
  it('validates the decision form', () => {
    const ok = {
      listingId: '018f0000-0000-7000-8000-000000000001',
      decision: 'approve' as const,
      reasonCode: 'reviewed',
      notes: '',
      versionId: '',
    };
    expect(moderationErrors(ok)).toEqual({});
    expect(moderationErrors({ ...ok, listingId: 'abc' }).listingId).toBe('listing');
    expect(moderationErrors({ ...ok, reasonCode: 'Bad Code' }).reasonCode).toBe('reason');
    expect(moderationErrors({ ...ok, versionId: 'nope' }).versionId).toBe('version');
    expect(moderationErrors({ ...ok, notes: 'x'.repeat(4001) }).notes).toBe('notes');
  });
  it('builds the body without empty optionals', () => {
    expect(
      moderationBody({
        decision: 'reject',
        reasonCode: ' policy_violation ',
        notes: ' ',
        versionId: '',
      }),
    ).toEqual({ decision: 'reject', reasonCode: 'policy_violation' });
    expect(
      moderationBody({
        decision: 'suspend',
        reasonCode: 'abuse',
        notes: 'n',
        versionId: '018F0000-0000-7000-8000-000000000001',
      }),
    ).toEqual({
      decision: 'suspend',
      reasonCode: 'abuse',
      notes: 'n',
      versionId: '018f0000-0000-7000-8000-000000000001',
    });
  });
  it('recognises agency and reseller organizations', () => {
    expect(isProgramOrg({ type: 'agency' })).toBe(true);
    expect(isProgramOrg({ type: 'reseller' })).toBe(true);
    expect(isProgramOrg({ type: 'business' })).toBe(false);
    expect(isUuid('018f0000-0000-7000-8000-000000000001')).toBe(true);
  });
});
