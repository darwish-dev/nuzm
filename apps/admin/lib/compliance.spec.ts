import { describe, expect, it } from 'vitest';
import {
  BREACH_FLOW,
  breachMoveBody,
  controlTone,
  localToIso,
  nextBreachStates,
  severityTone,
  shortHash,
  splitList,
  validationTone,
  type BreachFields,
} from './compliance';

const F = (over: Partial<BreachFields> = {}): BreachFields => ({
  note: '',
  personalData: 'yes',
  scope: '',
  classes: '',
  regions: '',
  orgIds: '',
  tables: '',
  notify: 'yes',
  rationale: '',
  recipients: '',
  notifiedAt: '',
  reference: '',
  severity: '',
  ...over,
});

describe('breach next steps (the API enforces the same edges)', () => {
  it('offers exactly one next state, and after the decision only the branch that was decided', () => {
    expect(nextBreachStates('detected', null)).toEqual(['triaged']);
    expect(nextBreachStates('triaged', null)).toEqual(['assessed']);
    expect(nextBreachStates('assessed', null)).toEqual(['notification_decision']);
    expect(nextBreachStates('notification_decision', { notify: true })).toEqual(['notified']);
    expect(nextBreachStates('notification_decision', { notify: false })).toEqual(['remediation']);
    expect(nextBreachStates('notification_decision', null)).toEqual([]);
    expect(nextBreachStates('notified', null)).toEqual(['remediation']);
    expect(nextBreachStates('remediation', null)).toEqual(['closed']);
    expect(nextBreachStates('closed', null)).toEqual([]);
    expect(nextBreachStates('unknown', null)).toEqual([]);
  });
  it('every state in the flow has a defined answer', () => {
    for (const s of BREACH_FLOW)
      expect(Array.isArray(nextBreachStates(s, { notify: true }))).toBe(true);
  });
});

describe('helpers', () => {
  it('splits lists, trims and drops duplicates and empties', () => {
    expect(splitList(' a, b ,, a ,c')).toEqual(['a', 'b', 'c']);
    expect(splitList('')).toEqual([]);
  });
  it('converts a datetime-local value to ISO and rejects anything else', () => {
    expect(localToIso('2026-03-01T10:30')).toMatch(/^2026-03-01T\d{2}:30:00.000Z$/);
    expect(localToIso('2026-03-01')).toBeNull();
    expect(localToIso('')).toBeNull();
    expect(localToIso('2026-13-45T99:99')).toBeNull();
  });
  it('shortens a hash for display', () => {
    expect(shortHash('0123456789abcdef0123')).toBe('0123456789ab');
  });
  it('tones never call anything good beyond what exists', () => {
    expect(controlTone('reviewed')).toBe('success');
    expect(controlTone('mapped')).toBeUndefined();
    expect(controlTone('not_mapped')).toBe('warn');
    expect(severityTone('critical')).toBe('danger');
    expect(severityTone('low')).toBeUndefined();
    expect(validationTone('validated')).toBe('success');
    expect(validationTone('open')).toBe('warn');
  });
});

describe('the body of a breach move', () => {
  it('triage: severity optional', () => {
    expect(breachMoveBody('triaged', F())).toEqual({ data: {} });
    expect(breachMoveBody('triaged', F({ severity: 'high', note: ' n ' }))).toEqual({
      data: { severity: 'high' },
      note: 'n',
    });
  });
  it('assessment: scope, classes when personal data is affected, uuid org ids', () => {
    const ok = F({
      scope: 'One export job read rows',
      classes: 'personal, financial',
      orgIds: '0192f1c0-7a52-7c3e-9d65-1f0e2a4b5c6d',
      tables: 'billing.subscriptions',
    });
    expect(breachMoveBody('assessed', ok).data).toMatchObject({
      personalDataAffected: true,
      dataClasses: ['personal', 'financial'],
      orgIds: ['0192f1c0-7a52-7c3e-9d65-1f0e2a4b5c6d'],
      tables: ['billing.subscriptions'],
    });
    expect(breachMoveBody('assessed', F({ scope: 'short' })).error).toBe('scope');
    expect(breachMoveBody('assessed', F({ scope: 'long enough scope here' })).error).toBe(
      'classes',
    );
    expect(
      breachMoveBody('assessed', F({ scope: 'long enough scope here', personalData: 'no' })).data,
    ).toMatchObject({ personalDataAffected: false, dataClasses: [] });
    expect(breachMoveBody('assessed', { ...ok, orgIds: 'nope' }).error).toBe('orgIds');
  });
  it('decision: a rationale, and recipients when notifying', () => {
    expect(breachMoveBody('notification_decision', F({ rationale: 'x' })).error).toBe('rationale');
    expect(
      breachMoveBody('notification_decision', F({ rationale: 'Counsel advised notification' }))
        .error,
    ).toBe('recipients');
    expect(
      breachMoveBody(
        'notification_decision',
        F({ rationale: 'Counsel advised notification', recipients: 'regulator' }),
      ).data,
    ).toEqual({
      notify: true,
      rationale: 'Counsel advised notification',
      recipients: ['regulator'],
    });
    expect(
      breachMoveBody(
        'notification_decision',
        F({ rationale: 'No personal data involved', notify: 'no' }),
      ).data,
    ).toMatchObject({ notify: false, recipients: [] });
  });
  it('notified: a time and a reference; remediation and closing need a note', () => {
    expect(breachMoveBody('notified', F({ reference: 'Letter 77' })).error).toBe('notifiedAt');
    expect(breachMoveBody('notified', F({ notifiedAt: '2026-03-01T10:00' })).error).toBe(
      'reference',
    );
    expect(
      breachMoveBody('notified', F({ notifiedAt: '2026-03-01T10:00', reference: 'Letter 77' }))
        .data,
    ).toMatchObject({ reference: 'Letter 77' });
    expect(breachMoveBody('remediation', F()).error).toBe('note');
    expect(breachMoveBody('closed', F({ note: 'Fixed' }))).toEqual({ note: 'Fixed' });
  });
});
