import { describe, expect, it } from 'vitest';
import { WEBAPP_ARTIFACTS, WEBAPP_GRAPH, validateGraph, type AgentGraph } from './dag';

const clone = (): AgentGraph => JSON.parse(JSON.stringify(WEBAPP_GRAPH)) as AgentGraph;

describe('agent graph validation (DAG, M10 §4 S42.1)', () => {
  it('the shipped web-app graph is valid and ordered requirements -> ... -> devops', () => {
    const r = validateGraph(WEBAPP_GRAPH);
    expect(r.errors).toEqual([]);
    expect(r.order[0]).toBe('requirements');
    expect(r.order.at(-1)).toBe('devops');
    for (const n of WEBAPP_GRAPH.nodes)
      for (const d of n.dependsOn) expect(r.order.indexOf(d)).toBeLessThan(r.order.indexOf(n.id));
  });
  it('covers all seven agents of FR-APP-01', () => {
    expect(new Set(WEBAPP_GRAPH.nodes.map((n) => n.agent))).toEqual(
      new Set(['requirements', 'architecture', 'database', 'backend', 'frontend', 'qa', 'devops']),
    );
  });
  it('rejects a cycle', () => {
    const g = clone();
    g.nodes.find((n) => n.id === 'requirements')!.dependsOn = ['devops'];
    expect(validateGraph(g).errors).toContain('graph has a cycle');
  });
  it('rejects an unknown dependency, a self dependency and duplicates', () => {
    const g = clone();
    g.nodes[1]!.dependsOn = ['ghost', 'architecture'];
    g.nodes.push({ ...g.nodes[0]! });
    const e = validateGraph(g).errors.join('|');
    expect(e).toMatch(/unknown dependency "ghost"/);
    expect(e).toMatch(/depends on itself/);
    expect(e).toMatch(/duplicate node id/);
  });
  it('rejects an unknown agent and an undefined artifact kind', () => {
    const g = clone();
    (g.nodes[0] as { agent: string }).agent = 'wizard';
    g.nodes[0]!.produces = 'nothing';
    const e = validateGraph(g).errors.join('|');
    expect(e).toMatch(/unknown agent "wizard"/);
    expect(e).toMatch(/undefined artifact kind "nothing"/);
  });
  it('rejects consuming an artifact whose producer is not an ancestor', () => {
    const g = clone();
    g.nodes.find((n) => n.id === 'database')!.consumes = ['api_contract']; // produced later by backend
    expect(validateGraph(g).errors.join('|')).toMatch(
      /consumes "api_contract" but "backend" is not an ancestor/,
    );
  });
  it('rejects consuming an artifact nobody produces, and two producers of one kind', () => {
    const g = clone();
    g.nodes.find((n) => n.id === 'qa')!.consumes = ['ghost_kind'];
    g.nodes.find((n) => n.id === 'devops')!.produces = 'test_plan';
    const e = validateGraph(g).errors.join('|');
    expect(e).toMatch(/no node produces/);
    expect(e).toMatch(/produced by both/);
  });
  it('has a schema with a type for every artifact', () => {
    for (const d of Object.values(WEBAPP_ARTIFACTS)) expect(d.schema.type).toBe('object');
  });
});
