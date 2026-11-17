import { describe, expect, it } from 'vitest';
import { ProblemException } from '../../../common/errors';
import { parseHoldRequest } from './legal-hold.service';
import { parsePolicyInput, RETENTION_TARGETS } from './retention.service';

const fields = (fn: () => unknown) => {
  try {
    fn();
    return [];
  } catch (e) {
    return ((e as ProblemException).errors as { field: string }[]).map((x) => x.field);
  }
};
const U1 = '0194a1b2-1111-7222-8333-444455556666';
const U2 = '0194a1b2-2222-7222-8333-444455556666';
const ORG = '0194a1b2-3333-7222-8333-444455556666';

const pol = (over: Record<string, unknown> = {}) => ({
  dataClass: 'personal',
  retainDays: 395,
  archiveAfterDays: 90,
  basis: 'D-34 proposal',
  ...over,
});

describe('retention policy input', () => {
  it('accepts a class policy and a dataset override, defaulting the status to proposal', () => {
    expect(parsePolicyInput(pol())).toMatchObject({
      dataClass: 'personal',
      dataset: null,
      status: 'proposal',
      baseVersion: null,
    });
    expect(parsePolicyInput(pol({ dataset: 'audit.audit_logs' })).dataset).toBe('audit.audit_logs');
  });
  it.each([
    ['archive longer than retain', { archiveAfterDays: 400 }, 'archiveAfterDays'],
    ['zero days', { retainDays: 0 }, 'retainDays'],
    ['fractional days', { retainDays: 1.5 }, 'retainDays'],
    ['more than 100 years', { retainDays: 40000 }, 'retainDays'],
    ['no class', { dataClass: '' }, 'dataClass'],
    ['an upper-case class', { dataClass: 'Personal' }, 'dataClass'],
    ['a bad dataset', { dataset: 'audit' }, 'dataset'],
    ['no basis', { basis: '' }, 'basis'],
    ['approved without a document', { status: 'approved' }, 'documentRef'],
    ['a status that does not exist', { status: 'final' }, 'status'],
    ['a zero base version', { baseVersion: 0 }, 'baseVersion'],
  ])('rejects %s', (_n, over, field) =>
    expect(fields(() => parsePolicyInput(pol(over)))).toContain(field),
  );
  it('accepts an approved policy that names its document', () => {
    expect(
      parsePolicyInput(pol({ status: 'approved', documentRef: 'counsel-memo-2026-11' })),
    ).toMatchObject({ status: 'approved', documentRef: 'counsel-memo-2026-11' });
  });
});

describe('legal hold request', () => {
  const create = (over: Record<string, unknown> = {}) => ({
    scope: { orgId: ORG },
    reason: 'Litigation hold ref 2026/44',
    approvers: [U1, U2],
    ...over,
  });
  it('parses the three request kinds', () => {
    expect(parseHoldRequest(create()).kind).toBe('create');
    expect(parseHoldRequest({ holdId: U1, decision: 'approve' })).toMatchObject({
      kind: 'decide',
      decision: 'approve',
      note: null,
    });
    expect(
      parseHoldRequest({
        holdId: U1,
        action: 'release',
        reason: 'Matter closed, counsel confirmed',
      }).kind,
    ).toBe('release');
  });
  it.each([
    ['no scope', { scope: {} }, 'scope'],
    ['a bad organization id', { scope: { orgId: 'x' } }, 'scope.orgId'],
    ['a bad dataset', { scope: { dataset: 'everything' } }, 'scope.dataset'],
    ['a short reason', { reason: 'short' }, 'reason'],
    ['one approver', { approvers: [U1] }, 'approvers'],
    ['the same person twice', { approvers: [U1, U1] }, 'approvers'],
    ['non-uuid approvers', { approvers: ['a', 'b'] }, 'approvers'],
  ])('rejects a create with %s', (_n, over, field) =>
    expect(fields(() => parseHoldRequest(create(over)))).toContain(field),
  );
  it('rejects a bad decision, a missing release reason and a bad hold id', () => {
    expect(fields(() => parseHoldRequest({ holdId: U1, decision: 'maybe' }))).toContain('decision');
    expect(
      fields(() => parseHoldRequest({ holdId: U1, action: 'release', reason: 'x' })),
    ).toContain('reason');
    expect(fields(() => parseHoldRequest({ holdId: 'nope', decision: 'approve' }))).toContain(
      'holdId',
    );
  });
});

describe('retention targets', () => {
  it('knows the audit log (report only: hash-chained) and the partitioned usage events (detach)', () => {
    expect(RETENTION_TARGETS.map((t) => [t.dataset, t.execution])).toEqual([
      ['audit.audit_logs', 'not-built'],
      ['metering.usage_events', 'partition-detach'],
    ]);
  });
});
