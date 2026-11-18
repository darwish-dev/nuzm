import { describe, expect, it } from 'vitest';
import { DEBUG_LIMITS, DebugLoopGuard } from './debug-loop';
import { failureSignature, groupOf, parseBuild, parseJunit, parseTsc } from './parsers';

const junit = `<?xml version="1.0" encoding="utf-8"?><testsuites>
<testsuite name="rbac.test.ts" tests="3" failures="1"><testcase name="admin &amp; reads" time="0.012" classname="tests/rbac.test.ts"/>
<testcase name="rep creates" time="0.5" classname="tests/rbac.test.ts"><failure message="expected 201 got 422" type="AssertionError">stack</failure></testcase>
<testcase name="skipped one" time="0" classname="tests/x.test.ts"><skipped/></testcase></testsuite></testsuites>`;

describe('result parsers', () => {
  it('junit: counts, statuses, durations, decoded names, failure messages', () => {
    const r = parseJunit(junit);
    expect(r).toMatchObject({ status: 'failed', tests: 3, failures: 1, skipped: 1, durationMs: 512 });
    expect(r.cases[0]).toMatchObject({ name: 'admin & reads', status: 'passed' });
    expect(r.cases[1]).toMatchObject({ status: 'failed', failure: 'expected 201 got 422' });
    expect(parseJunit('<testsuites/>').status).toBe('errored');
    expect(parseJunit('garbage').status).toBe('errored');
  });
  it('tsc: one failure per error line; a non-zero exit without errors is errored', () => {
    const r = parseTsc("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(9,1): error TS2304: Cannot find name 'x'.\n", 2);
    expect(r).toMatchObject({ status: 'failed', failures: 2 });
    expect(parseTsc('', 0).status).toBe('passed');
    expect(parseTsc('Error: cannot run tsc', 1).status).toBe('errored');
  });
  it('build: exit code and timeout', () => {
    expect(parseBuild('ok', 0, false).status).toBe('passed');
    expect(parseBuild('boom', 1, false).status).toBe('failed');
    expect(parseBuild('', null, true).status).toBe('errored');
  });
  it('signatures ignore line numbers, timings and hashes but not the message', () => {
    expect(failureSignature(['a.ts:10:5 failed in 12ms deadbeefcafe'])).toBe(failureSignature(['a.ts:99:1 failed in 400ms 0123456789ab']));
    expect(failureSignature(['a.ts:10 expected 1'])).not.toBe(failureSignature(['a.ts:10 expected 2']));
  });
  it('the group of a failure is its file', () => {
    expect(groupOf({ suite: 'typecheck', name: 'src/a.ts:3 TS2322', status: 'failed', durationMs: 0 })).toBe('src/a.ts');
    expect(groupOf({ suite: 'tests/rbac.test.ts', name: 'rep creates', status: 'failed', durationMs: 0 })).toBe('tests/rbac.test.ts');
  });
});

describe('debug loop limits (AC-M10-04): 5 per group, 15 per run, 3 identical signatures', () => {
  it('stops after 3 identical failure signatures in a row', () => {
    const g = new DebugLoopGuard();
    expect(g.attempt('a.ts', 's1')).toMatchObject({ proceed: true });
    expect(g.attempt('a.ts', 's1')).toMatchObject({ proceed: true });
    expect(g.attempt('a.ts', 's1')).toEqual({ proceed: false, reason: 'repeated_failure', group: 'a.ts' });
  });
  it('stops at 5 consecutive attempts for one group when the failure keeps changing', () => {
    const g = new DebugLoopGuard();
    for (let i = 0; i < DEBUG_LIMITS.perGroup; i++) expect(g.attempt('a.ts', 'sig' + i).proceed).toBe(true);
    expect(g.attempt('a.ts', 'sig-new')).toEqual({ proceed: false, reason: 'group_limit', group: 'a.ts' });
  });
  it('stops at 15 attempts per run across groups', () => {
    const g = new DebugLoopGuard();
    let n = 0;
    for (let grp = 0; grp < 6; grp++) for (let i = 0; i < 4; i++) { const v = g.attempt('g' + grp, `s${grp}-${i}`); if (v.proceed) n++; }
    expect(n).toBe(15);
    expect(g.attempt('g9', 'x')).toMatchObject({ proceed: false, reason: 'run_limit' });
  });
  it('a group that passes again starts from zero, but the run total never resets', () => {
    const g = new DebugLoopGuard();
    for (let i = 0; i < 4; i++) g.attempt('a.ts', 's' + i);
    g.fixed('a.ts');
    for (let i = 0; i < 5; i++) expect(g.attempt('a.ts', 'n' + i).proceed).toBe(true);
    expect(g.used.total).toBe(9);
  });
});
