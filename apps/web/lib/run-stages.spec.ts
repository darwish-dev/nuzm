import { describe, expect, it } from 'vitest';
import { runStages, type RunEvent } from './builder';

let n = 0;
const ev = (type: string, data: Record<string, unknown> = {}): RunEvent => ({
  seq: ++n,
  type,
  data,
  at: '2026-11-19T10:00:00Z',
});
const states = (s: ReturnType<typeof runStages>) => s.map((x) => `${x.id}:${x.state}`);

describe('runStages: the run as a few human steps', () => {
  it('a new website run is at "requirements" and nothing after it is claimed', () => {
    expect(
      states(
        runStages(
          'website',
          'running',
          [ev('created'), ev('step_started', { task: 'requirements' })],
          null,
        ),
      ),
    ).toEqual([
      'requirements:active',
      'plan:pending',
      'approval:pending',
      'pages:pending',
      'build:pending',
    ]);
  });
  it('planning, then waiting for the person: the approval step is the active one', () => {
    const events = [
      ev('step_started', { task: 'requirements' }),
      ev('step_completed', { task: 'requirements' }),
      ev('step_started', { task: 'architecture' }),
      ev('approval_requested', { kind: 'plan' }),
    ];
    expect(states(runStages('website', 'waiting_approval', events, 5))).toEqual([
      'requirements:done',
      'plan:done',
      'approval:active',
      'pages:pending',
      'build:pending',
    ]);
  });
  it('writing pages shows how many of the planned pages exist so far', () => {
    const events = [
      ev('approval_requested'),
      ev('approval_approved'),
      ev('page_generated', { pageId: 'home' }),
      ev('page_generated', { pageId: 'about' }),
    ];
    const s = runStages('website', 'running', events, 5);
    expect(states(s)).toEqual([
      'requirements:done',
      'plan:done',
      'approval:done',
      'pages:active',
      'build:pending',
    ]);
    expect(s[3]!.detail).toBe('2/5');
    // total unknown: just the count
    expect(runStages('website', 'running', events, null)[3]!.detail).toBe('2');
  });
  it('a finished run is all done; a failed one marks the step it stopped at', () => {
    const events = [ev('approval_requested'), ev('approval_approved'), ev('version_created')];
    expect(
      states(runStages('website', 'succeeded', events, 3)).every((x) => x.endsWith(':done')),
    ).toBe(true);
    const failed = runStages(
      'website',
      'failed',
      [ev('step_started', { task: 'requirements' })],
      null,
    );
    expect(states(failed)[0]).toBe('requirements:failed');
    expect(states(failed)[1]).toBe('plan:pending');
  });
  it('an edit has three steps and a chat reply one', () => {
    expect(states(runStages('edit', 'waiting_approval', [ev('approval_requested')], null))).toEqual(
      ['prepare:done', 'approval:active', 'apply:pending'],
    );
    expect(states(runStages('chat', 'running', [], null))).toEqual(['reply:active']);
    expect(states(runStages('other-kind', 'running', [], null))).toEqual(['work:active']);
  });
});
