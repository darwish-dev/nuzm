import { describe, expect, it } from 'vitest';
import { t, tDynamic } from '@nuzm/i18n';
import { HANDBOOK_GROUPS } from './handbook';
import {
  createReviewBody,
  decisionBody,
  defineAlertBody,
  formatDuration,
  measuredRto,
  nextIncidentStatuses,
  openIncidentBody,
  publishPolicyBody,
  putRetentionBody,
  readDryRun,
  readHealth,
  readReviewItems,
  readTimeline,
  recoveryExerciseBody,
  silenceUntil,
  splitRefs,
  updateIncidentBody,
} from './ops';

const ID = '0194a1b2-1111-7222-8333-444455556666';
const ID2 = '0194a1b2-1111-7222-8333-444455557777';

describe('incident bodies (UI-M12-05/06)', () => {
  const f = {
    severity: 'SEV2',
    title: 'Queue lag',
    summary: '',
    components: 'api, worker',
    breachCaseId: '',
  };
  it('builds a create body from valid fields and omits empty optionals', () => {
    expect(openIncidentBody(f).body).toEqual({
      severity: 'SEV2',
      title: 'Queue lag',
      components: ['api', 'worker'],
    });
  });
  it('names the first invalid field', () => {
    expect(openIncidentBody({ ...f, title: 'ab' }).error).toBe('title');
    expect(openIncidentBody({ ...f, severity: 'SEV9' }).error).toBe('severity');
    expect(openIncidentBody({ ...f, components: 'Bad Key' }).error).toBe('components');
    expect(openIncidentBody({ ...f, breachCaseId: 'nope' }).error).toBe('breachCaseId');
  });
  it('closed is terminal and a resolved incident can only close or reopen', () => {
    expect(nextIncidentStatuses('closed')).toEqual([]);
    expect(nextIncidentStatuses('resolved')).toEqual(['closed', 'investigating']);
    expect(nextIncidentStatuses('unknown-status')).toEqual([]);
  });
  it('sends only what changed and refuses an empty update', () => {
    const cur = { status: 'open', severity: 'SEV3', breachCaseId: null };
    const none = { status: '', severity: '', note: '', commsDraft: '', breachCaseId: '' };
    expect(updateIncidentBody(cur, none).error).toBe('nothing');
    expect(updateIncidentBody(cur, { ...none, status: 'open' }).error).toBe('nothing'); // same status = no change
    expect(
      updateIncidentBody(cur, {
        ...none,
        status: 'investigating',
        note: ' looking ',
        breachCaseId: ID,
      }).body,
    ).toEqual({ status: 'investigating', note: 'looking', breachCaseId: ID });
    expect(updateIncidentBody(cur, { ...none, breachCaseId: 'x' }).error).toBe('breachCaseId');
  });
  it('reads a timeline defensively', () => {
    const rows = readTimeline([
      { id: 'a', kind: 'note', body: 'x', author: 'u', at: '2026-11-18T10:00:00Z' },
      { kind: 'note' }, // no id or time: dropped
      null,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a', statusTo: null });
  });
});

describe('alerts (UI-M12-07)', () => {
  const NOW = Date.parse('2026-11-18T10:00:00Z');
  it('a silence expiry must be in the future and within 30 days', () => {
    expect(silenceUntil('2026-11-18T09:00', NOW).error).toBe('until');
    expect(silenceUntil('', NOW).error).toBe('until');
    expect(silenceUntil('2027-02-01T10:00', NOW).error).toBe('until');
    expect(silenceUntil('2026-11-25T10:00', NOW).until).toMatch(/^2026-11-25T/);
  });
  it('defines a rule with a runbook and an owner role, never a person', () => {
    const f = {
      ruleKey: 'queue.lag',
      title: 'Queue lag high',
      severity: 'warning',
      ownerRole: 'platform_admin',
      runbookUrl: 'docs/runbooks/queue-recovery.md',
      metric: 'queue.max_lag_seconds',
      op: '>',
      threshold: '300',
    };
    expect(defineAlertBody(f).body).toMatchObject({
      action: 'define',
      ruleKey: 'queue.lag',
      rule: { metric: 'queue.max_lag_seconds', op: '>', threshold: 300 },
    });
    expect(defineAlertBody({ ...f, runbookUrl: 'http://x' }).error).toBe('runbookUrl');
    expect(defineAlertBody({ ...f, ownerRole: 'Sara' }).error).toBe('ownerRole');
    expect(defineAlertBody({ ...f, threshold: '' }).error).toBe('threshold');
    expect(defineAlertBody({ ...f, op: '!=' }).error).toBe('op');
  });
});

describe('recovery exercises (UI-M12-09): RTO is measured, never typed', () => {
  it('computes the RTO from the two timestamps', () => {
    const r = measuredRto(
      '2026-11-01T10:00',
      '2026-11-01T11:05',
      Date.parse('2026-11-18T00:00:00Z'),
    );
    expect('seconds' in r && r.seconds).toBe(3900);
  });
  it('refuses a restore before the start, a missing time and a restore in the future', () => {
    const now = Date.parse('2026-11-18T00:00:00Z');
    expect(measuredRto('2026-11-01T11:00', '2026-11-01T10:00', now)).toEqual({
      error: 'restoredAt',
    });
    expect(measuredRto('', '2026-11-01T10:00', now)).toEqual({ error: 'startedAt' });
    expect(measuredRto('2026-11-01T10:00', '2030-01-01T10:00', now)).toEqual({
      error: 'restoredAt',
    });
  });
  it('formats HH:MM:SS', () => {
    expect(formatDuration(3900)).toBe('01:05:00');
    expect(formatDuration(14_400)).toBe('04:00:00');
    expect(formatDuration(360_000)).toBe('100:00:00');
  });
  it('splits evidence references by line or comma', () => {
    expect(splitRefs('a/b.log\nsha256:abc, a/b.log')).toEqual(['a/b.log', 'sha256:abc']);
  });
  it('the body carries the measured rtoSeconds and no result (the API decides it)', () => {
    const b = recoveryExerciseBody({
      scope: 'control_plane_db',
      environment: 'staging',
      startedAt: '2026-11-01T10:00',
      restoredAt: '2026-11-01T11:00',
      rpoSeconds: '120',
      evidence: 'evidence/restore-2026-11-01.log',
      notes: '',
    });
    expect(b.body).toMatchObject({ rtoSeconds: 3600, rpoSeconds: 120, environment: 'staging' });
    expect(b.body).not.toHaveProperty('result');
    expect(
      recoveryExerciseBody({
        scope: 'control_plane_db',
        environment: 'staging',
        startedAt: '2026-11-01T10:00',
        restoredAt: '2026-11-01T11:00',
        rpoSeconds: '12.5',
        evidence: 'x/y',
        notes: '',
      }).error,
    ).toBe('rpoSeconds');
  });
});

describe('health reader (UI-M12-04): nothing unmeasured becomes healthy', () => {
  it('keeps missing measurements as null and unknown', () => {
    const h = readHealth({
      status: 'degraded',
      components: [{ key: 'probes', status: 'unknown', detail: { configured: 0 } }, { nokey: 1 }],
      sloBurn: [
        {
          sloKey: 'api.availability',
          objective: 99.5,
          unit: 'percent',
          measured: null,
          status: 'not_measured',
        },
      ],
    });
    expect(h.components).toEqual([
      { key: 'probes', status: 'unknown', detail: [['configured', '0']] },
    ]);
    expect(h.outboxLagSeconds).toBeNull();
    expect(h.financialLastRunAt).toBeNull();
    expect(h.openFinancialBreaks).toBeNull();
    expect(h.probes).toEqual([]);
    expect(h.sloBurn[0]).toMatchObject({ measured: null, status: 'not_measured' });
    expect(h.alerts).toEqual({ firing: null, acknowledged: null, silenced: null });
  });
});

describe('access reviews (UI-M12-10/11)', () => {
  it('reads the items and decisions from the campaign payload', () => {
    const items = readReviewItems([
      { itemId: ID, userId: ID2, email: 'a@example.test', role: 'viewer', decision: null },
      {
        itemId: ID2,
        userId: ID,
        email: 'b@example.test',
        role: 'admin',
        decision: 'revoke',
        reason: 'left',
        decidedBy: ID,
        decidedAt: '2026-11-18T10:00:00Z',
      },
      { email: 'no-id' },
    ]);
    expect(items.map((i) => i.decision)).toEqual([null, 'revoke']);
  });
  it('needs a UUID organization, 1 to 20 reviewers and a future due date', () => {
    const now = Date.parse('2026-11-18T00:00:00Z');
    const ok = { orgId: ID, reviewers: `${ID2}, ${ID}`, dueAt: '2026-12-01T10:00' };
    expect(createReviewBody(ok, now).body).toMatchObject({
      scope: { orgId: ID, kinds: ['members'] },
    });
    expect(createReviewBody({ ...ok, orgId: 'x' }, now).error).toBe('orgId');
    expect(createReviewBody({ ...ok, reviewers: '' }, now).error).toBe('reviewers');
    expect(createReviewBody({ ...ok, dueAt: '2026-11-01T10:00' }, now).error).toBe('dueAt');
  });
  it('a decision needs a reason', () => {
    expect(decisionBody(ID, 'revoke', ' ').error).toBe('reason');
    expect(decisionBody(ID, 'keep', ' still needed ').body).toEqual({
      itemId: ID,
      decision: 'keep',
      reason: 'still needed',
    });
  });
});

describe('policy versions (UI-M12-12): never approves on anyone’s behalf', () => {
  const f = {
    policyKey: 'security',
    title: 'Security policy',
    bodyRef: 'dataroom://policies/security-v2.pdf',
    effectiveFrom: '2026-12-01',
    approvedBy: '',
    approvalRef: '',
    changeNote: '',
  };
  it('without an approver the version is a draft (no approval fields are sent)', () => {
    const b = publishPolicyBody(f).body!;
    expect(b).not.toHaveProperty('approvedBy');
    expect(b).not.toHaveProperty('approvalRef');
  });
  it('an approver and an approval reference go together', () => {
    expect(publishPolicyBody({ ...f, approvedBy: ID }).error).toBe('approvalRef');
    expect(publishPolicyBody({ ...f, approvalRef: 'ticket-1' }).error).toBe('approvalRef');
    expect(publishPolicyBody({ ...f, approvedBy: ID, approvalRef: 'ticket-1' }).body).toMatchObject(
      { approvedBy: ID, approvalRef: 'ticket-1' },
    );
    expect(publishPolicyBody({ ...f, approvedBy: 'nope', approvalRef: 'ticket-1' }).error).toBe(
      'approvedBy',
    );
  });
  it('checks key, date and references', () => {
    expect(publishPolicyBody({ ...f, policyKey: 'Bad Key' }).error).toBe('policyKey');
    expect(publishPolicyBody({ ...f, effectiveFrom: '01/12/2026' }).error).toBe('effectiveFrom');
    expect(publishPolicyBody({ ...f, bodyRef: 'x' }).error).toBe('bodyRef');
  });
});

describe('audit retention (UI-M12-14)', () => {
  const f = {
    dataClass: 'security',
    retainDays: '400',
    archiveAfterDays: '300',
    basis: 'docs/10 §5 proposal',
    status: 'proposal',
    documentRef: '',
    changeNote: '',
  };
  it('refuses a period below the minimum before asking the API', () => {
    expect(
      putRetentionBody({ ...f, retainDays: '100', archiveAfterDays: '50' }, 395, null).error,
    ).toBe('minimum');
    expect(putRetentionBody(f, 395, 2).body).toMatchObject({ retainDays: 400, baseVersion: 2 });
    expect(putRetentionBody(f, 395, null).body).not.toHaveProperty('baseVersion');
  });
  it('archive cannot outlast retention and an approved policy needs a document', () => {
    expect(putRetentionBody({ ...f, archiveAfterDays: '500' }, 395, null).error).toBe(
      'archiveAfterDays',
    );
    expect(putRetentionBody({ ...f, status: 'approved' }, 395, null).error).toBe('documentRef');
    expect(
      putRetentionBody(
        { ...f, status: 'approved', documentRef: 'dataroom://counsel/memo.pdf' },
        395,
        null,
      ).body,
    ).toMatchObject({ status: 'approved' });
  });
  it('reads a missing dry run as null, not as zero', () => {
    expect(readDryRun(null)).toBeNull();
    expect(
      readDryRun({ archiveCandidates: 4, heldCandidates: 1, eligibleToArchive: 3 }),
    ).toMatchObject({
      archiveCandidates: 4,
      expiryCandidates: null,
    });
  });
});

describe('support handbook data (UI-M12-17)', () => {
  it('every runbook has a purpose in Arabic and English, and the lists have no duplicates', () => {
    const slugs = HANDBOOK_GROUPS.flatMap((g) => [...g.slugs]);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      for (const l of ['en', 'ar'] as const)
        expect(tDynamic(l, `m12.hb.e.${slug}`, '__MISSING__'), `${slug} (${l})`).not.toBe(
          '__MISSING__',
        );
    }
    for (const g of HANDBOOK_GROUPS) {
      expect(t('en', `m12.hb.cat.${g.key}`)).toBeTruthy();
    }
  });
});
