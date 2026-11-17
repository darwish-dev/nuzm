import { describe, expect, it } from 'vitest';
import {
  aggregate,
  canTransition,
  loadDsrConfig,
  parseDsrConfig,
  parseSubject,
  REASONS,
  REASON_PRIORITY,
  slaState,
  type TaskOutcome,
} from './types';
import { DsrRegistry, done, NOT_APPLICABLE, refused, type DsrHandler } from './handlers';

const t = (
  handler: string,
  status: TaskOutcome['status'],
  reason: TaskOutcome['reason'] = null,
): TaskOutcome => ({ handler, action: 'erase', status, reason });
const U = '0192f1c0-7a52-7c3e-9d65-1f0e2a4b5c6d';

describe('aggregate: the final state of a request from its tasks', () => {
  it('everything succeeded (including "nothing to do") is fulfilled', () => {
    expect(aggregate([t('a', 'succeeded'), t('b', 'succeeded')])).toEqual({
      status: 'fulfilled',
      reasonCode: null,
    });
  });
  it('some succeeded and some refused or failed is partially fulfilled', () => {
    expect(aggregate([t('a', 'succeeded'), t('b', 'refused', 'retention_mandatory')]).status).toBe(
      'partially_fulfilled',
    );
    expect(aggregate([t('a', 'succeeded'), t('b', 'failed')]).status).toBe('partially_fulfilled');
  });
  it('nothing succeeded is rejected with the most specific reason', () => {
    expect(
      aggregate([t('a', 'refused', 'last_owner'), t('b', 'refused', 'retention_mandatory')]),
    ).toEqual({ status: 'rejected', reasonCode: 'retention_mandatory' });
    expect(
      aggregate([t('a', 'refused', 'retention_mandatory'), t('b', 'refused', 'legal_hold_active')])
        .reasonCode,
    ).toBe('legal_hold_active');
  });
  it('"nothing of this kind about the subject" is neutral: it does not turn a refusal into a partial result', () => {
    const na = (h: string) => t(h, 'succeeded', 'not_applicable');
    expect(aggregate([na('a'), na('b')]).status).toBe('fulfilled');
    expect(aggregate([na('a'), t('b', 'refused', 'last_owner')])).toEqual({
      status: 'rejected',
      reasonCode: 'last_owner',
    });
    expect(aggregate([na('a'), t('b', 'succeeded'), t('c', 'refused', 'last_owner')]).status).toBe(
      'partially_fulfilled',
    );
  });
  it('only technical failures are rejected as processing_failed (needs a person)', () => {
    expect(aggregate([t('a', 'failed'), t('b', 'failed')])).toEqual({
      status: 'rejected',
      reasonCode: 'processing_failed',
    });
  });
  it('no tasks at all is rejected, never silently fulfilled', () => {
    expect(aggregate([]).status).toBe('rejected');
  });
  it('every reason code has Arabic and English wording and a priority slot', () => {
    for (const [code, text] of Object.entries(REASONS)) {
      expect(text.ar.length, code).toBeGreaterThan(5);
      expect(text.en.length, code).toBeGreaterThan(5);
      expect(REASON_PRIORITY, code).toContain(code);
    }
  });
});

describe('state machine', () => {
  it('moves forward only; terminal states have no exits', () => {
    expect(canTransition('received', 'identity_verified')).toBe(true);
    expect(canTransition('received', 'in_progress')).toBe(false);
    expect(canTransition('in_progress', 'partially_fulfilled')).toBe(true);
    for (const s of ['fulfilled', 'rejected', 'partially_fulfilled'] as const) {
      expect(canTransition(s, 'in_progress')).toBe(false);
      expect(canTransition(s, 'received')).toBe(false);
    }
  });
});

describe('SLA timers', () => {
  const cfg = { warnAt: 0.7, escalateAt: 0.9 };
  const rec = new Date('2026-01-01T00:00:00Z');
  const due = new Date('2026-01-31T00:00:00Z'); // 30 days
  const at = (day: number) => new Date(rec.getTime() + day * 86_400_000);
  it('is ok until 70%, a warning from 70%, escalated from 90%, overdue at the deadline', () => {
    expect(slaState(rec, due, at(20), cfg)).toBe('ok');
    expect(slaState(rec, due, at(21), cfg)).toBe('warning'); // exactly 70%
    expect(slaState(rec, due, at(26.9), cfg)).toBe('warning');
    expect(slaState(rec, due, at(27), cfg)).toBe('escalated'); // exactly 90%
    expect(slaState(rec, due, at(29.99), cfg)).toBe('escalated');
    expect(slaState(rec, due, at(30), cfg)).toBe('overdue');
    expect(slaState(rec, due, at(45), cfg)).toBe('overdue');
  });
});

describe('subjects', () => {
  it('parses member, org and opaque references', () => {
    expect(parseSubject('org')).toEqual({ kind: 'org' });
    expect(parseSubject(`member:${U.toUpperCase()}`)).toEqual({ kind: 'member', userId: U });
    expect(parseSubject('enduser-123')).toEqual({ kind: 'opaque', ref: 'enduser-123' });
  });
});

describe('configuration (spec/compliance/defaults.yaml)', () => {
  it('loads the committed proposal', () => {
    const c = loadDsrConfig();
    expect(c.fulfilDays).toEqual({ access: 30, correction: 30, deletion: 30, portability: 30 });
    expect(c.warnAt).toBe(0.7);
    expect(c.escalateAt).toBe(0.9);
    expect(c.maxConcurrentExports).toBe(5);
    expect(c.linkTtlSeconds).toBe(900);
  });
  it('refuses a bad file instead of guessing', () => {
    const ok = `
dsr: { fulfil_days: { access: 30, correction: 30, deletion: 30, portability: 30 }, warn_at: 0.7, escalate_at: 0.9, task_max_attempts: 3 }
exports: { max_concurrent: 5, archive_ttl_hours: 72, link_ttl_seconds: 900 }`;
    expect(() => parseDsrConfig(ok)).not.toThrow();
    expect(() => parseDsrConfig(ok.replace('warn_at: 0.7', 'warn_at: 0.95'))).toThrow(/warn_at/);
    expect(() => parseDsrConfig(ok.replace('access: 30', 'access: 0'))).toThrow(/access/);
    expect(() => parseDsrConfig(ok.replace('max_concurrent: 5', 'max_concurrent: 0'))).toThrow(
      /max_concurrent/,
    );
    expect(() => parseDsrConfig('dsr: {}')).toThrow(/required/);
  });
});

describe('handler registry', () => {
  const h = (name: string): DsrHandler => ({
    name,
    datasets: [],
    export: async () => NOT_APPLICABLE,
    erase: async () => refused('unsupported'),
    rectify: async () => done({ n: 1 }),
  });
  it('keeps registration order and refuses a duplicate name', () => {
    const r = new DsrRegistry();
    r.register(h('a'));
    r.register(h('b'));
    expect(r.all().map((x) => x.name)).toEqual(['a', 'b']);
    expect(() => r.register(h('a'))).toThrow(/already registered/);
    expect(r.get('b')?.name).toBe('b');
  });
});
