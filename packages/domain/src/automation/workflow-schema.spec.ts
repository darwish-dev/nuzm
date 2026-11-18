import { describe, expect, it } from 'vitest';
import { LIMITS, stepIsIdempotent, validateWorkflowDefinition, type WorkflowDefinition } from './workflow-schema';

const CONN = '0190a000-0000-7000-8000-000000000001';
const ok = (): WorkflowDefinition => ({
  schemaVersion: 1,
  start: 'fetch',
  steps: [
    { id: 'fetch', type: 'http_request', params: { method: 'GET', url: 'https://api.example.com/x', connectorId: CONN }, next: 'check' },
    { id: 'check', type: 'condition', params: { expr: 'steps.fetch.output.status == 200' }, onTrue: 'mail', onFalse: 'wait' },
    { id: 'mail', type: 'send_email', params: { senderId: '0190a000-0000-7000-8000-0000000000aa', to: ['{{ input.email }}'], subject: 'Hi', text: 'Body {{ input.name }}' } },
    { id: 'wait', type: 'delay', params: { seconds: 60 } },
  ],
});
const codes = (d: unknown) => validateWorkflowDefinition(d).errors.map((e) => e.code);

describe('workflow definition validation', () => {
  it('accepts a valid DAG and reports the connectors it uses', () => {
    const r = validateWorkflowDefinition(ok());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.connectorIds).toEqual([CONN]);
    expect(r.stepCount).toBe(4);
  });
  it('rejects non-objects, unknown properties, bad schema version and empty steps', () => {
    expect(codes(null)).toContain('invalid_definition');
    expect(codes([])).toContain('invalid_definition');
    expect(codes({ ...ok(), extra: 1 })).toContain('invalid_definition');
    expect(codes({ ...ok(), schemaVersion: 2 })).toContain('invalid_definition');
    expect(codes({ schemaVersion: 1, start: 'a', steps: [] })).toContain('invalid_definition');
  });
  it('rejects cycles, unknown successors, unreachable steps, duplicate ids', () => {
    const cyc = ok();
    cyc.steps[3]!.next = 'fetch';
    expect(codes(cyc)).toContain('cycle');
    const unk = ok();
    unk.steps[0]!.next = 'nope';
    expect(codes(unk)).toContain('invalid_graph');
    const unr = ok();
    unr.steps.push({ id: 'orphan', type: 'delay', params: { seconds: 1 } });
    expect(codes(unr)).toContain('unreachable_step');
    const dup = ok();
    dup.steps.push({ id: 'fetch', type: 'delay', params: { seconds: 1 } });
    expect(codes(dup)).toContain('duplicate_step_id');
    const self = ok();
    self.steps[3]!.next = 'wait';
    expect(codes(self)).toContain('cycle');
  });
  it('allows branches to rejoin (a DAG, not a tree)', () => {
    const d = ok();
    d.steps[2]!.next = 'wait';
    expect(validateWorkflowDefinition(d).ok).toBe(true);
  });
  it('bounds loops (<= 100 iterations) and forbids nesting', () => {
    const loop = (max: unknown, body: unknown[]) => ({ schemaVersion: 1, start: 'l', steps: [{ id: 'l', type: 'loop', params: { over: 'input.items', maxIterations: max }, body }] });
    const b = [{ id: 'b1', type: 'transform', params: { output: { v: '{{ item }}' } } }];
    expect(validateWorkflowDefinition(loop(100, b)).ok).toBe(true);
    expect(codes(loop(101, b))).toContain('invalid_params');
    expect(codes(loop(0, b))).toContain('invalid_params');
    expect(codes(loop('x', b))).toContain('invalid_params');
    expect(codes(loop(5, []))).toContain('invalid_step');
    expect(codes(loop(5, [{ id: 'n', type: 'loop', params: { over: 'input.x', maxIterations: 2 }, body: b }]))).toContain('invalid_step');
    expect(codes(loop(5, [{ id: 'd', type: 'delay', params: { seconds: 1 } }]))).toContain('invalid_step');
  });
  it('rejects unparsable expressions and unknown names at publish time', () => {
    const e1 = ok();
    e1.steps[1]!.params.expr = 'steps.fetch.output.status ==';
    expect(codes(e1)).toContain('invalid_expression');
    const e2 = ok();
    e2.steps[1]!.params.expr = 'eval("1")';
    expect(codes(e2)).toContain('invalid_expression');
    const e3 = ok();
    e3.steps[1]!.params.expr = 'secrets.token == 1';
    expect(codes(e3)).toContain('invalid_expression');
    const e4 = ok();
    e4.steps[2]!.params.subject = 'Hi {{ input.name ';
    expect(codes(e4)).toContain('invalid_expression');
  });
  it('refuses literal credentials in a definition (secrets are vault references held by connectors)', () => {
    const a = ok();
    (a.steps[0]!.params as Record<string, unknown>).headers = { Authorization: 'Bearer abcdefghijklmnop' };
    expect(codes(a)).toContain('secret_in_definition');
    const b = ok();
    (b.steps[0]!.params as Record<string, unknown>).headers = { 'X-Api-Key': 'plainvalue123' };
    expect(codes(b)).toContain('secret_in_definition');
    const c = ok();
    c.steps[2]!.params.text = 'key nzk_abcdefghijkl';
    expect(codes(c)).toContain('secret_in_definition');
    const templ = ok();
    (templ.steps[0]!.params as Record<string, unknown>).headers = { 'X-Token': '{{ input.token }}' };
    expect(validateWorkflowDefinition(templ).ok).toBe(true);
  });
  it('requires https URLs and valid step parameters', () => {
    const http = ok();
    http.steps[0]!.params.url = 'http://example.com';
    expect(codes(http)).toContain('invalid_params');
    const m = ok();
    m.steps[0]!.params.method = 'TRACE';
    expect(codes(m)).toContain('invalid_params');
    const d = ok();
    d.steps[3]!.params.seconds = LIMITS.maxDelaySeconds + 1;
    expect(codes(d)).toContain('invalid_params');
    const api = { schemaVersion: 1, start: 'a', steps: [{ id: 'a', type: 'nuzm_api', params: { method: 'GET', path: '/v1/../admin', connectorId: CONN } }] };
    expect(codes(api)).toContain('invalid_params');
    const api2 = { schemaVersion: 1, start: 'a', steps: [{ id: 'a', type: 'nuzm_api', params: { method: 'GET', path: '/v1/projects' } }] };
    expect(codes(api2)).toContain('invalid_params');
  });
  it('classifies idempotency: POST is non-idempotent unless a key mapping is given', () => {
    expect(stepIsIdempotent({ type: 'http_request', params: { method: 'GET' } })).toBe(true);
    expect(stepIsIdempotent({ type: 'http_request', params: { method: 'PUT' } })).toBe(true);
    expect(stepIsIdempotent({ type: 'http_request', params: { method: 'POST' } })).toBe(false);
    expect(stepIsIdempotent({ type: 'http_request', params: { method: 'POST' }, idempotencyKey: '{{ execution.id }}-1' })).toBe(true);
    const d: WorkflowDefinition = { schemaVersion: 1, start: 'p', steps: [{ id: 'p', type: 'http_request', params: { method: 'POST', url: 'https://a.example.com' } }] };
    expect(validateWorkflowDefinition(d).warnings.map((w) => w.code)).toContain('non_idempotent');
  });
  it('limits the size of a definition', () => {
    const many = { schemaVersion: 1, start: 's0', steps: Array.from({ length: LIMITS.maxSteps + 1 }, (_, i) => ({ id: `s${i}`, type: 'delay', params: { seconds: 1 } })) };
    expect(codes(many)).toContain('too_large');
  });
});
