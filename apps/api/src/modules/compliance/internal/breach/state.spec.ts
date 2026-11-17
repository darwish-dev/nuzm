import { describe, expect, it } from 'vitest';
import {
  BREACH_STATES,
  canMove,
  EDGES,
  loadBreachConfig,
  parseBreachConfig,
  timersFor,
} from './state';

describe('breach state machine (AC-M04-11): every edge is either allowed or refused', () => {
  const allowed = new Set([
    'detected>triaged',
    'triaged>assessed',
    'assessed>notification_decision',
    'notification_decision>notified',
    'notification_decision>remediation',
    'notified>remediation',
    'remediation>closed',
  ]);
  it('exactly the 7 documented edges are valid, the other 42 of 49 pairs are invalid', () => {
    let valid = 0;
    let invalid = 0;
    for (const a of BREACH_STATES)
      for (const b of BREACH_STATES) {
        const ok = canMove(a, b);
        expect(ok, `${a} -> ${b}`).toBe(allowed.has(`${a}>${b}`));
        if (ok) valid++;
        else invalid++;
      }
    expect([valid, invalid]).toEqual([7, 42]);
  });
  it('nothing leaves closed and nothing goes back', () => {
    expect(EDGES.closed).toEqual([]);
    for (const [i, a] of BREACH_STATES.entries())
      for (const b of BREACH_STATES.slice(0, i + 1))
        expect(canMove(a, b), `${a} -> ${b}`).toBe(false);
  });
});

describe('timers (placeholders)', () => {
  const cfg = { triageHours: 24, assessHours: 48, decisionHours: 72, evidenceLookbackHours: 24 };
  const det = new Date('2026-03-01T00:00:00Z');
  const at = (h: number) => new Date(det.getTime() + h * 3_600_000);
  it('counts from detection and names the step the case is waiting for', () => {
    expect(timersFor(det, 'detected', cfg, at(1)).current).toMatchObject({
      step: 'triage',
      overdue: false,
    });
    expect(timersFor(det, 'detected', cfg, at(24)).current).toMatchObject({
      step: 'triage',
      overdue: true,
    });
    expect(timersFor(det, 'triaged', cfg, at(30)).current).toMatchObject({
      step: 'assess',
      overdue: false,
    });
    expect(timersFor(det, 'assessed', cfg, at(73)).current).toMatchObject({
      step: 'decision',
      overdue: true,
    });
    expect(timersFor(det, 'notification_decision', cfg, at(500)).current).toBeNull();
    expect(timersFor(det, 'detected', cfg, at(0)).decisionDueAt).toBe(at(72).toISOString());
  });
});

describe('configuration', () => {
  it('loads the committed proposal', () => {
    const c = loadBreachConfig();
    expect(c).toMatchObject({ triageHours: 24, assessHours: 48, decisionHours: 72 });
  });
  it('refuses nonsense instead of guessing', () => {
    const ok = 'breach: { triage_hours: 24, assess_hours: 48, decision_hours: 72 }';
    expect(() => parseBreachConfig(ok)).not.toThrow();
    expect(() =>
      parseBreachConfig('breach: { triage_hours: 60, assess_hours: 48, decision_hours: 72 }'),
    ).toThrow(/<=/);
    expect(() =>
      parseBreachConfig('breach: { triage_hours: 0, assess_hours: 48, decision_hours: 72 }'),
    ).toThrow(/triage_hours/);
    expect(() => parseBreachConfig('other: 1')).toThrow(/required/);
  });
});
