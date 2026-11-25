import { describe, expect, it } from 'vitest';
import {
  executionOf,
  generationProblemKey,
  pct,
  planBody,
  reasonKey,
  statusKey,
  type Plan,
} from './generation';

const problem = (status: number, code?: string) => ({ status, code, issues: [] }) as never;

describe('plan and reason labels', () => {
  it('a known status or reason has its own sentence, anything else is "unknown" and never raw text', () => {
    expect(statusKey('RUNNING')).toBe('gen.plan.status.RUNNING');
    expect(statusKey('<script>')).toBe('gen.plan.status.UNKNOWN');
    expect(reasonKey('over_budget')).toBe('gen.ctx.reason.over_budget');
    expect(reasonKey('anything else')).toBe('gen.ctx.reason.UNKNOWN');
  });
  it('the execution state comes from the plan, defaulting to blocked', () => {
    expect(
      executionOf({ plan: { execution: { status: 'RUNNING', runId: 'r1' } } } as unknown as Plan),
    ).toEqual({ status: 'RUNNING', runId: 'r1' });
    expect(executionOf(null)).toEqual({ status: 'BLOCKED', runId: null });
    expect(
      executionOf({ plan: { execution: { status: 5, runId: {} } } } as unknown as Plan),
    ).toEqual({ status: 'BLOCKED', runId: null });
  });
});

describe('refusals', () => {
  it('a plan that was already started has its own sentence; others fall back to the shared mapping', () => {
    expect(generationProblemKey(problem(409, 'conflict'))).toBe('gen.err.conflict');
    expect(generationProblemKey(problem(409, 'idempotency_in_progress'))).toBe(
      'bld.err.in_progress',
    );
    expect(generationProblemKey(problem(402, 'insufficient_credits'))).toBe(
      'bld.err.insufficient_credits',
    );
    expect(generationProblemKey(problem(500))).toBe('state.error.title');
  });
});

describe('numbers and the plan request', () => {
  it('percentages stay within 0..100', () => {
    expect(pct(40.4)).toBe(40);
    expect(pct(900)).toBe(100);
    expect(pct(Number.NaN)).toBe(0);
  });
  it('a plan needs a requirement text; the mode is checked', () => {
    expect(planBody({ projectId: 'p', text: '  ', mode: 'ADAPTIVE' })).toBeNull();
    expect(planBody({ projectId: 'p', text: 'x'.repeat(3000), mode: 'WILD' })).toMatchObject({
      projectId: 'p',
      platform: 'WEB',
      mode: 'ADAPTIVE',
    });
    // the whole requirement is sent (owner request 2026-11-26): never cut; over the limit is no request at all
    expect(
      (planBody({ projectId: 'p', text: 'x'.repeat(30_000), mode: 'STRICT' })!.text as string)
        .length,
    ).toBe(30_000);
    expect(planBody({ projectId: 'p', text: 'x'.repeat(30_001), mode: 'STRICT' })).toBeNull();
    expect(planBody({ projectId: 'p', text: 'a', mode: 'STRICT' })!.mode).toBe('STRICT');
  });
});
