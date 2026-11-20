import { describe, expect, it } from 'vitest';
import type { RunEvent } from './builder';
import {
  committedFiles,
  producedItems,
  runsByMessage,
  timeText,
  timelineOf,
} from './webapp-events';

let n = 0;
const ev = (
  type: string,
  data: Record<string, unknown> = {},
  at = '2026-11-20T09:00:00Z',
): RunEvent => ({
  seq: ++n,
  type,
  data,
  at,
});

describe('timelineOf: the run events as a readable list', () => {
  it('turns each agent step into started / finished entries with tokens and a link to its result', () => {
    const t = timelineOf([
      ev('created', { kind: 'webapp' }),
      ev('node_started', { node: 'database', agent: 'database', attempt: 1 }),
      ev('node_succeeded', {
        node: 'database',
        artifact: 'db_schema',
        tokensIn: 700,
        tokensOut: 300,
      }),
    ]);
    expect(t.map((x) => x.key)).toEqual([
      'wsp.ev.created',
      'wsp.ev.nodeStarted',
      'wsp.ev.nodeDone',
    ]);
    expect(t[2]).toMatchObject({
      tone: 'ok',
      params: { agent: 'database' },
      detail: { key: 'wsp.ev.tokens', params: { n: 1000 } },
      open: { tab: 'design', view: 'migrations' },
    });
    expect(t[1]!.detail).toBeUndefined();
  });
  it('says an agent was retried, and where each artifact opens', () => {
    const t = timelineOf([
      ev('node_started', { node: 'backend', attempt: 2 }),
      ev('node_succeeded', { node: 'backend', artifact: 'api_contract' }),
      ev('node_succeeded', { node: 'frontend', artifact: 'frontend_bundle' }),
      ev('node_succeeded', { node: 'qa', artifact: 'test_plan' }),
      ev('node_succeeded', { node: 'architecture', artifact: 'app_spec' }),
    ]);
    expect(t[0]!.detail).toEqual({ key: 'wsp.ev.attempt', params: { n: 2 } });
    expect(t.slice(1).map((x) => x.open)).toEqual([
      { tab: 'design', view: 'api' },
      { tab: 'code' },
      { tab: 'tests' },
      { tab: 'spec' },
    ]);
  });
  it('shows files written, approvals asked and decided, and budget warnings', () => {
    const t = timelineOf([
      ev('approval_requested', {
        node: 'database',
        types: ['destructive_migration', 'dependency'],
      }),
      ev('approval_approve', { kind: 'destructive_migration' }),
      ev('approval_deny', { kind: 'dependency' }),
      ev('approval_decided'),
      ev('budget_warn', { pct: 82 }),
      ev('project_committed', { versionId: 'v2', files: 36 }),
    ]);
    expect(t.map((x) => x.key)).toEqual([
      'wsp.ev.approvalAsked',
      'wsp.ev.approvalYes',
      'wsp.ev.approvalNo',
      'wsp.ev.resumed',
      'wsp.ev.budgetWarn',
      'wsp.ev.committed',
    ]);
    expect(t[0]!.params.kinds).toBe('destructive_migration, dependency');
    expect(t[0]!.tone).toBe('wait');
    expect(t[5]).toMatchObject({ params: { n: 36 }, open: { tab: 'code' } });
  });
  it('a failure carries its code and the reasons the run gave (masked)', () => {
    const t = timelineOf([
      ev('node_failed', { node: 'architecture', reason: 'ArtifactInvalid' }),
      ev('failed', {
        error: {
          code: 'run_failed',
          details: ['Entity "Patient" is declared twice.', 'x'.repeat(40)],
        },
      }),
    ]);
    expect(t[0]).toMatchObject({
      tone: 'danger',
      detail: { params: { reason: 'ArtifactInvalid' } },
    });
    expect(t[1]!.params.code).toBe('run_failed');
    expect(t[1]!.reasons).toEqual(['Entity "Patient" is declared twice.', '[REDACTED]']);
  });
  it('leaves out bookkeeping events, orders by sequence and keeps an unknown type by its code', () => {
    const early = ev('created');
    const late = ev('succeeded');
    const t = timelineOf([
      late,
      ev('checkpoint', { step: 'x' }),
      ev('artifact', {}),
      ev('segment_started'),
      early,
      ev('weird_event'),
    ]);
    expect(t.map((x) => x.key)).toEqual([
      'wsp.ev.created',
      'wsp.ev.succeeded',
      'bld.ev.weird_event',
    ]);
    expect(t[2]!.params.code).toBe('weird_event');
  });
});

describe('what was produced', () => {
  const base = {
    artifactTypes: [
      'requirements',
      'app_spec',
      'db_schema',
      'api_contract',
      'frontend_bundle',
      'test_plan',
    ],
    spec: { entities: [{}, {}], roles: [{}, {}, {}] } as never,
    tables: 5,
    migrations: 2,
    destructive: true,
    endpoints: 20,
    files: 36,
  };
  it('counts what the artifacts hold and flags a destructive migration', () => {
    const items = producedItems(base);
    expect(items.map((i) => [i.id, i.count])).toEqual([
      ['spec', 2],
      ['tables', 5],
      ['migrations', 2],
      ['endpoints', 20],
      ['roles', 3],
      ['files', 36],
      ['tests', null],
    ]);
    expect(items.find((i) => i.id === 'migrations')).toMatchObject({
      warn: true,
      open: { tab: 'design', view: 'migrations' },
    });
    expect(items.find((i) => i.id === 'files')!.open).toEqual({ tab: 'code' });
  });
  it('lists only what exists so far (a run in progress)', () => {
    const items = producedItems({
      ...base,
      artifactTypes: ['requirements', 'app_spec'],
      tables: null,
      migrations: null,
      endpoints: null,
      files: null,
      destructive: false,
    });
    expect(items.map((i) => i.id)).toEqual(['spec', 'roles']);
  });
  it('reads the files of a build from its commit event', () => {
    expect(committedFiles([ev('project_committed', { files: 12 })])).toBe(12);
    expect(committedFiles([ev('created')])).toBeNull();
  });
});

describe('runsByMessage: earlier runs in the conversation', () => {
  const messages = [
    { id: 'm1', createdAt: '2026-11-19T08:00:00Z' },
    { id: 'm2', createdAt: '2026-11-20T09:00:00Z' },
  ];
  it('puts each run after the last message written before it and leaves the current run out', () => {
    const runs = [
      { id: 'r3', createdAt: '2026-11-21T10:00:00Z' },
      { id: 'r2', createdAt: '2026-11-20T09:00:10Z' },
      { id: 'r1', createdAt: '2026-11-19T08:00:10Z' },
    ];
    const g = runsByMessage(messages, runs, 'r3');
    expect(g.before).toEqual([]);
    expect(g.after.get('m1')!.map((r) => r.id)).toEqual(['r1']);
    expect(g.after.get('m2')!.map((r) => r.id)).toEqual(['r2']);
  });
  it('a run older than every message goes to the start', () => {
    const g = runsByMessage(messages, [{ id: 'r0', createdAt: '2026-11-01T00:00:00Z' }], null);
    expect(g.before.map((r) => r.id)).toEqual(['r0']);
  });
});

describe('timeText', () => {
  it('shows the clock time in the platform time zone, and nothing for a bad date', () => {
    expect(timeText('2026-11-20T09:04:31Z', 'en')).toBe('12:04:31');
    expect(timeText('not a date', 'en')).toBe('');
  });
});
