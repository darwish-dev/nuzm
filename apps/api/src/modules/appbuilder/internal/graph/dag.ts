import { AGENTS, type AgentId } from '../core';
import { APP_SPEC_SCHEMA } from '../spec/app-spec';
import type { Schema } from '../schema';

/** One node of the agent task graph: an agent, what it consumes/produces (artifact kinds with schemas) and its dependencies. */
export interface GraphNode {
  id: string;
  agent: AgentId;
  dependsOn: string[];
  /** Artifact kinds this node reads: each must be produced by an ANCESTOR (transitive dependency). */
  consumes: string[];
  /** The single artifact kind this node writes (its output is validated against `artifacts[produces].schema` before the checkpoint). */
  produces: string;
}
export interface ArtifactDef {
  kind: string;
  schema: Schema;
}
export interface AgentGraph {
  name: string;
  nodes: GraphNode[];
  artifacts: Record<string, ArtifactDef>;
}
export interface GraphCheck {
  ok: boolean;
  errors: string[];
  /** A topological order (stable: ties broken by declaration order). Empty when invalid. */
  order: string[];
}

const NODE_ID = /^[a-z][a-z0-9_-]{0,40}$/;
export const MAX_NODES = 40;

/** The DAG is validated BEFORE any run starts (M10 §4 S42.1): unique ids, known agents, existing dependencies, no cycle, every consumed artifact produced by an ancestor, every produced kind defined once. */
export function validateGraph(g: AgentGraph): GraphCheck {
  const errors: string[] = [];
  if (g.nodes.length === 0) errors.push('graph has no nodes');
  if (g.nodes.length > MAX_NODES) errors.push(`graph has more than ${MAX_NODES} nodes`);
  const byId = new Map<string, GraphNode>();
  for (const n of g.nodes) {
    if (!NODE_ID.test(n.id)) errors.push(`node id "${n.id}" is not valid`);
    if (byId.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
    byId.set(n.id, n);
    if (!(AGENTS as readonly string[]).includes(n.agent))
      errors.push(`node "${n.id}": unknown agent "${n.agent}"`);
    if (new Set(n.dependsOn).size !== n.dependsOn.length)
      errors.push(`node "${n.id}": duplicate dependency`);
    if (n.dependsOn.includes(n.id)) errors.push(`node "${n.id}" depends on itself`);
  }
  for (const n of g.nodes)
    for (const d of n.dependsOn)
      if (!byId.has(d)) errors.push(`node "${n.id}": unknown dependency "${d}"`);
  // producers: one node per artifact kind
  const producer = new Map<string, string>();
  for (const n of g.nodes) {
    if (!g.artifacts[n.produces])
      errors.push(`node "${n.id}": produces undefined artifact kind "${n.produces}"`);
    else if (g.artifacts[n.produces]!.kind !== n.produces)
      errors.push(`artifact "${n.produces}" declares another kind`);
    if (producer.has(n.produces))
      errors.push(
        `artifact "${n.produces}" is produced by both "${producer.get(n.produces)}" and "${n.id}"`,
      );
    else producer.set(n.produces, n.id);
  }
  for (const [k, def] of Object.entries(g.artifacts))
    if (!def.schema.type) errors.push(`artifact "${k}": schema has no type`);
  // cycle detection (Kahn) + order
  const indeg = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  for (const n of g.nodes)
    for (const d of n.dependsOn) if (byId.has(d)) indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
  const order: string[] = [];
  const ready = g.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const m of g.nodes)
      if (m.dependsOn.includes(id)) {
        indeg.set(m.id, indeg.get(m.id)! - 1);
        if (indeg.get(m.id) === 0) ready.push(m.id);
      }
  }
  if (order.length !== g.nodes.length) errors.push('graph has a cycle');
  else {
    // ancestors for consumed-artifact checks
    const anc = new Map<string, Set<string>>();
    for (const id of order) {
      const s = new Set<string>();
      for (const d of byId.get(id)!.dependsOn) {
        s.add(d);
        for (const a of anc.get(d) ?? []) s.add(a);
      }
      anc.set(id, s);
    }
    for (const n of g.nodes)
      for (const kind of n.consumes) {
        const p = producer.get(kind);
        if (!p) errors.push(`node "${n.id}": consumes "${kind}" which no node produces`);
        else if (!anc.get(n.id)!.has(p))
          errors.push(`node "${n.id}": consumes "${kind}" but "${p}" is not an ancestor`);
      }
  }
  return { ok: errors.length === 0, errors, order: errors.length === 0 ? order : [] };
}

const fileList: Schema = {
  type: 'array',
  maxItems: 600,
  items: {
    type: 'object',
    required: ['path', 'content'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 240 },
      content: { type: 'string', maxLength: 1_000_000 },
    },
  },
};

/** Artifact kinds of the web-app graph. Each schema is the contract between two agents. */
export const WEBAPP_ARTIFACTS: Record<string, ArtifactDef> = {
  requirements: {
    kind: 'requirements',
    schema: {
      type: 'object',
      required: ['summary', 'entities', 'roles', 'locales'],
      additionalProperties: true,
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        entities: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        },
        roles: { type: 'array', minItems: 1, items: { type: 'string' } },
        locales: { type: 'array', minItems: 1, items: { enum: ['ar', 'en'] } },
        features: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  app_spec: { kind: 'app_spec', schema: APP_SPEC_SCHEMA },
  db_schema: {
    kind: 'db_schema',
    schema: {
      type: 'object',
      required: ['migrations', 'tables', 'files'],
      additionalProperties: false,
      properties: {
        migrations: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['version', 'name', 'up', 'down', 'destructive'],
            additionalProperties: false,
            properties: {
              version: { type: 'integer', minimum: 1 },
              name: { type: 'string', pattern: '^[a-z0-9_]{1,60}$' },
              up: { type: 'string' },
              down: { type: 'string' },
              destructive: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        tables: { type: 'array', items: { type: 'string' } },
        files: fileList,
      },
    },
  },
  api_contract: {
    kind: 'api_contract',
    schema: {
      type: 'object',
      required: ['openapi', 'rbac', 'dependencies', 'files'],
      additionalProperties: false,
      properties: {
        openapi: { type: 'object' },
        rbac: { type: 'object' },
        dependencies: { type: 'object' },
        files: fileList,
      },
    },
  },
  frontend_bundle: {
    kind: 'frontend_bundle',
    schema: {
      type: 'object',
      required: ['pages', 'files'],
      additionalProperties: false,
      properties: { pages: { type: 'array', items: { type: 'string' } }, files: fileList },
    },
  },
  test_plan: {
    kind: 'test_plan',
    schema: {
      type: 'object',
      required: ['summary', 'files'],
      additionalProperties: false,
      properties: {
        summary: {
          type: 'object',
          required: ['contractTests', 'unitTests'],
          properties: {
            contractTests: { type: 'integer', minimum: 0 },
            unitTests: { type: 'integer', minimum: 0 },
          },
        },
        files: fileList,
      },
    },
  },
  deploy_plan: {
    kind: 'deploy_plan',
    schema: {
      type: 'object',
      required: ['healthPath', 'env', 'files'],
      additionalProperties: false,
      properties: {
        healthPath: { type: 'string', pattern: '^/' },
        env: { type: 'array', items: { type: 'string' } },
        files: fileList,
      },
    },
  },
};

/** The seven-agent graph of FR-APP-01: requirements -> architecture -> {database, backend, frontend} -> qa -> devops. */
export const WEBAPP_GRAPH: AgentGraph = {
  name: 'webapp',
  artifacts: WEBAPP_ARTIFACTS,
  nodes: [
    {
      id: 'requirements',
      agent: 'requirements',
      dependsOn: [],
      consumes: [],
      produces: 'requirements',
    },
    {
      id: 'architecture',
      agent: 'architecture',
      dependsOn: ['requirements'],
      consumes: ['requirements'],
      produces: 'app_spec',
    },
    {
      id: 'database',
      agent: 'database',
      dependsOn: ['architecture'],
      consumes: ['app_spec'],
      produces: 'db_schema',
    },
    {
      id: 'backend',
      agent: 'backend',
      dependsOn: ['architecture', 'database'],
      consumes: ['app_spec', 'db_schema'],
      produces: 'api_contract',
    },
    {
      id: 'frontend',
      agent: 'frontend',
      dependsOn: ['architecture', 'backend'],
      consumes: ['app_spec', 'api_contract'],
      produces: 'frontend_bundle',
    },
    {
      id: 'qa',
      agent: 'qa',
      dependsOn: ['backend', 'frontend'],
      consumes: ['app_spec', 'api_contract'],
      produces: 'test_plan',
    },
    {
      id: 'devops',
      agent: 'devops',
      dependsOn: ['qa'],
      consumes: ['app_spec', 'db_schema', 'api_contract'],
      produces: 'deploy_plan',
    },
  ],
};
