import { describe, expect, it } from 'vitest';
import {
  BUILDER_TOOLS,
  LIFECYCLE_STEP_IDS,
  STEP_DEFS,
  authorizeTool,
  beginInvocation,
  finishInvocation,
  modelTools,
  toolNames,
} from './index';

const actor = (...p: string[]) => ({ permissions: new Set(p) as ReadonlySet<string> });
const all = actor('builder:read', 'builder:write', 'builder:test', 'deploy:create');

describe('the registry is closed and read-only toward models', () => {
  it('a model is only ever offered read-only tools', () => {
    expect(modelTools().length).toBeGreaterThan(0);
    for (const n of modelTools()) expect(BUILDER_TOOLS[n]!.class).toBe('read');
    for (const d of Object.values(BUILDER_TOOLS)) if (d.modelExposed) expect(d.class).toBe('read');
  });
  it('no tool name suggests it can run code', () => {
    for (const n of toolNames())
      expect(n).not.toMatch(/(^|_)(exec|execute|run|shell|spawn|eval|command)(_|$)/);
  });
  it('every tool a step lists exists, and every tool is used by some step', () => {
    for (const id of LIFECYCLE_STEP_IDS)
      for (const t of STEP_DEFS[id].tools) expect(BUILDER_TOOLS[t], `${id}:${t}`).toBeDefined();
    const used = new Set(LIFECYCLE_STEP_IDS.flatMap((id) => [...STEP_DEFS[id].tools]));
    for (const n of toolNames()) expect(used.has(n), n).toBe(true);
  });
  it('execution, change and approval tools are runner-only', () => {
    for (const d of Object.values(BUILDER_TOOLS))
      if (['change', 'execution_request', 'approval_request', 'proposal'].includes(d.class))
        expect(d.modelExposed, d.name).toBe(false);
  });
});

describe('authorizeTool', () => {
  it('allows a permitted runner call from a step that lists the tool', () => {
    expect(
      authorizeTool({
        tool: 'read_file',
        step: 'project_analysis',
        caller: 'model',
        actor: actor('builder:read'),
        args: { path: 'src/a.ts' },
      }),
    ).toMatchObject({ allowed: true });
    expect(
      authorizeTool({
        tool: 'request_execution',
        step: 'build',
        caller: 'runner',
        actor: all,
        args: { profile: 'build' },
      }),
    ).toMatchObject({ allowed: true });
  });
  it('denies in this order: unknown tool, not in step, model not allowed, permission, arguments', () => {
    const a = (o: Partial<Parameters<typeof authorizeTool>[0]>) =>
      authorizeTool({
        tool: 'read_file',
        step: 'project_analysis',
        caller: 'runner',
        actor: all,
        args: { path: 'a.ts' },
        ...o,
      });
    expect(a({ tool: 'rm_rf' })).toMatchObject({ allowed: false, code: 'unknown_tool' });
    expect(a({ tool: 'constructor' })).toMatchObject({ allowed: false, code: 'unknown_tool' });
    expect(a({ step: 'preview' })).toMatchObject({ allowed: false, code: 'not_in_step' });
    expect(
      a({
        tool: 'apply_change',
        step: 'change_apply',
        caller: 'model',
        args: { ops: [], label: 'x' },
      }),
    ).toMatchObject({ allowed: false, code: 'model_not_allowed' });
    expect(
      a({ tool: 'request_execution', step: 'build', caller: 'model', args: { profile: 'build' } }),
    ).toMatchObject({ allowed: false, code: 'model_not_allowed' });
    expect(a({ actor: actor('builder:write') })).toMatchObject({
      allowed: false,
      code: 'permission_denied',
    });
    expect(a({ args: { path: '../../etc/passwd' } })).toMatchObject({
      allowed: false,
      code: 'invalid_arguments',
    });
    expect(a({ args: {} })).toMatchObject({ allowed: false, code: 'invalid_arguments' });
  });
  it('a viewer cannot apply a change or request an execution; a developer without deploy cannot request a deployment approval', () => {
    const viewer = actor('builder:read');
    expect(
      authorizeTool({
        tool: 'apply_change',
        step: 'change_apply',
        caller: 'runner',
        actor: viewer,
        args: { ops: [], label: 'x' },
      }),
    ).toMatchObject({ allowed: false, code: 'permission_denied' });
    expect(
      authorizeTool({
        tool: 'request_execution',
        step: 'tests',
        caller: 'runner',
        actor: viewer,
        args: { profile: 'unit-tests' },
      }),
    ).toMatchObject({ allowed: false, code: 'permission_denied' });
    expect(
      authorizeTool({
        tool: 'request_deploy_approval',
        step: 'deployment_approval',
        caller: 'runner',
        actor: actor('builder:read', 'builder:write'),
        args: { summary: {} },
      }),
    ).toMatchObject({ allowed: false, code: 'permission_denied' });
  });
  it('an execution profile outside the three fixed ones is refused', () => {
    expect(
      authorizeTool({
        tool: 'request_execution',
        step: 'build',
        caller: 'runner',
        actor: all,
        args: { profile: 'sh -c "id"' },
      }),
    ).toMatchObject({ allowed: false, code: 'invalid_arguments' });
  });
});

describe('the invocation lifecycle', () => {
  const ok = {
    tool: 'read_file',
    step: 'project_analysis' as const,
    caller: 'runner' as const,
    actor: all,
    args: { path: 'a.ts' },
  };
  it('records a denial without running anything', () => {
    const { invocation, authorization } = beginInvocation(
      'project_analysis:1',
      { ...ok, tool: 'nope' },
      '2026-11-24T00:00:00Z',
    );
    expect(authorization.allowed).toBe(false);
    expect(invocation).toMatchObject({ status: 'denied', code: 'unknown_tool' });
    expect(finishInvocation(invocation, 'x', { ok: true, resultBytes: 5 })).toBe(invocation);
  });
  it('hashes the arguments (same arguments, same hash, key order irrelevant) and never keeps them', () => {
    const a = beginInvocation('i1', { ...ok, args: { path: 'a.ts', extra: 1 } }, 't').invocation;
    const b = beginInvocation('i2', { ...ok, args: { extra: 1, path: 'a.ts' } }, 't').invocation;
    expect(a.argsHash).toBe(b.argsHash);
    expect(a.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(a)).not.toContain('a.ts');
  });
  it('running → succeeded caps the kept result, running → failed keeps only a short code', () => {
    const { invocation } = beginInvocation('i', ok, 't0');
    expect(invocation.status).toBe('running');
    const s = finishInvocation(invocation, 't1', { ok: true, resultBytes: 10_000_000 });
    expect(s).toMatchObject({ status: 'succeeded', truncated: true, resultBytes: 100_000 });
    const f = finishInvocation(invocation, 't1', { ok: false, code: 'x'.repeat(200) });
    expect(f.status).toBe('failed');
    expect(f.code).toHaveLength(60);
  });
});
