import { AGENTS, type AgentId, type Row } from '../core';
import { AppSpecService } from '../spec/spec.service';
import { APP_SPEC_SCHEMA, validateAppSpec, type AppSpec } from '../spec/app-spec';
import { WEBAPP_ARTIFACTS } from '../graph/dag';
import type { AgentContext, AgentExecutor, AgentResult, ApprovalNeed } from '../graph/runner';
import { diffSpecs, type GeneratedMigration } from '../gen/sql';
import { generateProject } from '../gen/project';
import {
  evaluateDependencies,
  StaticAdvisoryDb,
  type AdvisoryDbPort,
} from '../policy/dependencies';
import type { ProjectsPort } from '../ports/m09';

/** What the agents need besides the model: the spec store, the project store (for the previous approved spec) and the advisory feed. */
export interface AgentServices {
  specs: AppSpecService;
  projects: ProjectsPort;
  advisories: AdvisoryDbPort;
}
type Files = { path: string; content: string }[];
const pick = (files: ReadonlyMap<string, string>, test: (p: string) => boolean): Files =>
  [...files]
    .filter(([p]) => test(p))
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));

/** Requirements agent: the model turns the user's description into a structured requirements artifact. The user text is DATA inside the input object, never instructions. */
export class RequirementsAgent implements AgentExecutor {
  readonly agent = 'requirements' as const;
  async execute(ctx: AgentContext): Promise<AgentResult> {
    const brief = ctx.inputs['brief'] ?? {};
    const artifact = await ctx.model.ask<unknown>({
      agent: this.agent,
      purpose: 'requirements',
      input: { data: { brief }, task: 'extract_requirements' },
      schema: WEBAPP_ARTIFACTS['requirements']!.schema,
      maxTokens: 8_000,
    });
    return { artifact, toolCalls: [{ tool: 'model.complete', args: { purpose: 'requirements' } }] };
  }
}

/** Architecture agent: requirements -> the application spec (validated structurally AND semantically, repaired up to twice), stored as a new `builder.app_specs` version. */
export class ArchitectureAgent implements AgentExecutor {
  readonly agent = 'architecture' as const;
  constructor(private readonly svc: AgentServices) {}
  async execute(ctx: AgentContext): Promise<AgentResult> {
    const spec = await ctx.model.ask<AppSpec>({
      agent: this.agent,
      purpose: 'app_spec',
      input: { data: { requirements: ctx.inputs['requirements'] }, task: 'design_application' },
      schema: APP_SPEC_SCHEMA,
      maxTokens: 24_000,
      check: (v) => validateAppSpec(v).issues.map((i) => `${i.path}: ${i.message}`),
    });
    const saved = await this.svc.specs.create(ctx.orgId, ctx.projectId, spec, {
      runId: ctx.runId,
      dataRegion: ctx.dataRegion,
    });
    return {
      artifact: spec,
      toolCalls: [
        {
          tool: 'builder.app_spec.save',
          args: { version: saved.version, hash: saved.contentHash },
        },
      ],
    };
  }
}

/** Database agent: spec -> versioned reversible migrations. The first version is the whole schema; a later one is the expand/contract diff against the previous APPROVED spec. Destructive statements need approval. */
export class DatabaseAgent implements AgentExecutor {
  readonly agent = 'database' as const;
  constructor(private readonly svc: AgentServices) {}
  async execute(ctx: AgentContext): Promise<AgentResult> {
    const spec = ctx.inputs['app_spec'] as AppSpec;
    let previous: AppSpec | null;
    try {
      const specs = (await this.svc.specs.list(ctx.orgId, ctx.projectId)).filter(
        (s) => s.status === 'approved',
      );
      previous = specs[0]?.spec ?? null;
    } catch {
      previous = null;
    }
    let extra: GeneratedMigration[] = [];
    if (previous) extra = diffSpecs(previous, spec, 2);
    const project = generateProject(spec, { extraMigrations: extra });
    const migrations = project.migrations;
    const files = pick(project.files, (p) => p.startsWith('db/'));
    const destructive = migrations.flatMap((m) => m.destructive);
    const approvals: ApprovalNeed[] = destructive.length
      ? [
          {
            type: 'destructive_migration',
            action: {
              project: ctx.projectId,
              migrations: migrations.filter((m) => m.destructive.length).map((m) => m.version),
              statements: destructive,
            },
          },
        ]
      : [];
    return {
      artifact: {
        migrations: migrations.map(({ version, name, up, down, destructive }) => ({
          version,
          name,
          up,
          down,
          destructive,
        })),
        tables: spec.entities.map((e) => e.plural),
        files,
      },
      toolCalls: [
        {
          tool: 'schema.generate',
          args: {
            entities: spec.entities.length,
            migrations: migrations.length,
            destructive: destructive.length,
          },
        },
      ],
      ...(approvals.length ? { approvals } : {}),
    };
  }
}

/** Backend agent: spec + schema -> OpenAPI (linted like the Nuzm API in tests), RBAC matrix, API runtime, and the dependency-policy verdict on the manifest. */
export class BackendAgent implements AgentExecutor {
  readonly agent = 'backend' as const;
  constructor(private readonly svc: AgentServices) {}
  async execute(ctx: AgentContext): Promise<AgentResult> {
    const spec = ctx.inputs['app_spec'] as AppSpec;
    const project = generateProject(spec);
    const manifest = JSON.parse(project.files.get('package.json')!) as Parameters<
      typeof evaluateDependencies
    >[0]['manifest'];
    const policy = await evaluateDependencies({
      manifest,
      lockfile: null,
      advisories: this.svc.advisories,
      lockfileRequired: false,
    });
    if (!policy.ok)
      throw new Error(
        'dependency policy blocked the manifest: ' +
          policy.findings
            .filter((f) => f.level === 'block')
            .map((f) => f.message)
            .join('; '),
      );
    const rbacDoc = project.files.get('docs/RBAC.md')!;
    void rbacDoc;
    return {
      artifact: {
        openapi: project.openapi,
        rbac: {
          roles: spec.roles.map((r) => ({
            name: r.name,
            scope: r.scope,
            permissions: r.permissions,
          })),
        },
        dependencies: { manifest, policy: { ok: policy.ok, findings: policy.findings } },
        files: pick(
          project.files,
          (p) => p.startsWith('src/') || p === 'openapi.json' || p === 'docs/RBAC.md',
        ),
      },
      toolCalls: [
        {
          tool: 'openapi.generate',
          args: { paths: Object.keys(project.openapi['paths'] as object).length },
        },
        { tool: 'dependency.policy', args: { ok: policy.ok, findings: policy.findings.length } },
      ],
    };
  }
}

/** Frontend agent: spec + API contract -> the Arabic (RTL) / English single-page application. */
export class FrontendAgent implements AgentExecutor {
  readonly agent = 'frontend' as const;
  async execute(ctx: AgentContext): Promise<AgentResult> {
    const spec = ctx.inputs['app_spec'] as AppSpec;
    const project = generateProject(spec);
    return {
      artifact: {
        pages: spec.pages.map((p) => p.path),
        files: pick(project.files, (p) => p.startsWith('public/')),
      },
      toolCalls: [{ tool: 'frontend.scaffold', args: { pages: spec.pages.length } }],
    };
  }
}

/** QA agent: contract, access-control and validation tests generated from the spec (synthetic data only). */
export class QaAgent implements AgentExecutor {
  readonly agent = 'qa' as const;
  async execute(ctx: AgentContext): Promise<AgentResult> {
    const spec = ctx.inputs['app_spec'] as AppSpec;
    const project = generateProject(spec);
    const files = pick(project.files, (p) => p.startsWith('tests/'));
    const contract = files
      .filter((f) => /contract|rbac|scope/.test(f.path))
      .reduce((n, f) => n + (f.content.match(/\btest\(|for \(/g)?.length ?? 0), 0);
    const unit = files
      .filter((f) => /auth|validation/.test(f.path))
      .reduce((n, f) => n + (f.content.match(/\btest\(/g)?.length ?? 0), 0);
    return {
      artifact: { summary: { contractTests: contract, unitTests: unit }, files },
      toolCalls: [{ tool: 'tests.generate', args: { files: files.length } }],
    };
  }
}

/** DevOps agent: runtime manifest (start/migrate/health/env), README, package manifest and TypeScript configuration. */
export class DevopsAgent implements AgentExecutor {
  readonly agent = 'devops' as const;
  async execute(ctx: AgentContext): Promise<AgentResult> {
    const spec = ctx.inputs['app_spec'] as AppSpec;
    const project = generateProject(spec);
    const manifest = JSON.parse(project.files.get('nuzm.app.json')!) as {
      deploy: { healthPath: string; env: string[] };
    };
    const files = pick(
      project.files,
      (p) => !/^(src|public|tests|db)\//.test(p) && p !== 'openapi.json' && p !== 'docs/RBAC.md',
    );
    return {
      artifact: { healthPath: manifest.deploy.healthPath, env: manifest.deploy.env, files },
      toolCalls: [{ tool: 'deploy.plan', args: { files: files.length } }],
    };
  }
}

/** The seven executors of the web-app graph. */
export function webappExecutors(svc: AgentServices): Map<AgentId, AgentExecutor> {
  const list: AgentExecutor[] = [
    new RequirementsAgent(),
    new ArchitectureAgent(svc),
    new DatabaseAgent(svc),
    new BackendAgent(svc),
    new FrontendAgent(),
    new QaAgent(),
    new DevopsAgent(),
  ];
  void AGENTS;
  return new Map(list.map((a) => [a.agent, a]));
}

/** Merges the file lists of every artifact into one project snapshot (later artifacts do not override earlier ones: a duplicate path is an error, never a silent overwrite). */
export function assembleFiles(artifacts: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const kind of [
    'db_schema',
    'api_contract',
    'frontend_bundle',
    'test_plan',
    'deploy_plan',
  ] as const) {
    const a = artifacts[kind] as { files?: Files } | undefined;
    for (const f of a?.files ?? []) {
      if (out.has(f.path)) throw new Error(`two agents produced ${f.path}`);
      out.set(f.path, f.content);
    }
  }
  return out;
}
export { StaticAdvisoryDb };
export type { Row };
