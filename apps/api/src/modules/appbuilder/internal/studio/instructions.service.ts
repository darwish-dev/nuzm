import {
  baselineInstructionLayers,
  composeInstructions,
  renderInstructions,
  validateInstructionLayer,
  type InstructionLayer,
  type InstructionSection,
  type RuleStrength,
  type StudioProjectType,
} from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { newId } from '../core';
import type { ProjectRecord } from '../ports/m09';
import type { StudioFileWriter } from './files';
import { hasFileTree } from './flag';

type Row = Record<string, unknown>;
const STRENGTHS: RuleStrength[] = ['must', 'should', 'never', 'may'];
const MAX_SECTIONS = 30;
const MAX_RULES = 60;

/** Turns untrusted JSON into instruction sections, or the list of what is wrong with it (nothing is guessed). */
export function parseSections(
  raw: unknown,
  field: string,
): { sections: InstructionSection[]; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { sections: [], problems };
  if (!Array.isArray(raw))
    return { sections: [], problems: [`${field} must be a list of sections`] };
  if (raw.length > MAX_SECTIONS) problems.push(`${field}: at most ${MAX_SECTIONS} sections`);
  const sections: InstructionSection[] = [];
  raw.slice(0, MAX_SECTIONS).forEach((s, i) => {
    const o = (s ?? {}) as Row;
    if (typeof o.id !== 'string' || typeof o.title !== 'string' || !Array.isArray(o.rules)) {
      problems.push(`${field}[${i}] needs id, title and rules`);
      return;
    }
    if (o.rules.length > MAX_RULES) problems.push(`${field}[${i}]: at most ${MAX_RULES} rules`);
    const rules = o.rules.slice(0, MAX_RULES).flatMap((r, j) => {
      const x = (r ?? {}) as Row;
      if (typeof x.text !== 'string' || !STRENGTHS.includes(x.strength as RuleStrength)) {
        problems.push(`${field}[${i}].rules[${j}] needs text and strength (must|should|never|may)`);
        return [];
      }
      if (
        x.key !== undefined &&
        (typeof x.key !== 'string' || !/^[a-z][a-z0-9._-]{0,60}$/.test(x.key))
      ) {
        problems.push(`${field}[${i}].rules[${j}].key is invalid`);
        return [];
      }
      return [
        {
          text: x.text,
          strength: x.strength as RuleStrength,
          ...(typeof x.key === 'string' ? { key: x.key } : {}),
          // customers cannot mark their own rules as security rules: that tag protects the platform baseline from being relaxed
        },
      ];
    });
    sections.push({ id: o.id, title: o.title.slice(0, 80), rules });
  });
  return { sections, problems };
}

export interface InstructionsDto {
  projectId: string;
  version: number;
  projectLayer: InstructionSection[];
  customerLayer: InstructionSection[];
  customerBlock: string;
  /** read-only: what Nuzm contributes (platform baseline + the framework of the project type) */
  baseline: InstructionLayer[];
  markdown: string;
  conflicts: ReturnType<typeof composeInstructions>['conflicts'];
  updatedAt: string | null;
  /** whether `CLAUDE.md` can be written into the project's files (web app and mobile projects) */
  canSync: boolean;
}

/** Project instructions (`CLAUDE.md`, ADR-064 point 3): the project and customer layers on top of the Nuzm baseline, with history. */
export class InstructionsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly files: StudioFileWriter,
  ) {}

  private layers(
    p: ProjectRecord,
    project: InstructionSection[],
    customer: InstructionSection[],
  ): InstructionLayer[] {
    return [
      ...baselineInstructionLayers(p.type as StudioProjectType),
      { source: 'project', sections: project },
      { source: 'customer', sections: customer },
    ];
  }
  private build(p: ProjectRecord, row: Row | undefined): InstructionsDto {
    const project = (row?.project_layer as InstructionSection[] | undefined) ?? [];
    const customer = (row?.customer_layer as InstructionSection[] | undefined) ?? [];
    const block = (row?.customer_block as string | undefined) ?? '';
    const composed = composeInstructions(this.layers(p, project, customer));
    return {
      projectId: p.id,
      version: Number(row?.version ?? 0),
      projectLayer: project,
      customerLayer: customer,
      customerBlock: block,
      baseline: baselineInstructionLayers(p.type as StudioProjectType),
      markdown: renderInstructions(composed, {
        title: `${p.name} — development instructions`,
        customerBlock: block,
      }),
      conflicts: composed.conflicts,
      updatedAt: row?.updated_at ? new Date(row.updated_at as string).toISOString() : null,
      canSync: hasFileTree(p),
    };
  }

  async get(orgId: string, p: ProjectRecord): Promise<InstructionsDto> {
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM builder.project_instructions WHERE project_id = $1`, [p.id]))
          .rows[0] as Row | undefined,
    );
    return this.build(p, row);
  }

  /** Replaces the project and customer layers and the customer block. `ifMatch` is the version the editor loaded (0 before the first save). */
  async put(
    orgId: string,
    actor: string,
    p: ProjectRecord,
    body: Row,
    ifMatch: number | null,
  ): Promise<InstructionsDto> {
    const proj = parseSections(body.projectLayer, 'projectLayer');
    const cust = parseSections(body.customerLayer, 'customerLayer');
    const block = body.customerBlock === undefined ? '' : body.customerBlock;
    const problems = [...proj.problems, ...cust.problems];
    if (typeof block !== 'string') problems.push('customerBlock must be text');
    else if (block.length > 20000) problems.push('customerBlock: at most 20000 characters');
    else if (/<!--\s*nuzm:customer:(start|end)\s*-->/.test(block))
      problems.push('customerBlock cannot contain the block markers');
    for (const e of [
      ...validateInstructionLayer({ source: 'project', sections: proj.sections }),
      ...validateInstructionLayer({ source: 'customer', sections: cust.sections }),
    ])
      problems.push(`${e.source}: ${e.message}`);
    if (problems.length)
      throw new ProblemException(
        'validation_failed',
        'the instructions are invalid',
        problems.map((m) => ({ field: 'instructions', message: m })),
      );
    const dto = await this.db.withOrg(orgId, async (c) => {
      const cur = (
        await c.query(
          `SELECT * FROM builder.project_instructions WHERE project_id = $1 FOR UPDATE`,
          [p.id],
        )
      ).rows[0] as Row | undefined;
      const have = Number(cur?.version ?? 0);
      if (ifMatch === null)
        throw new ProblemException('precondition_required', 'If-Match is required');
      if (ifMatch !== have)
        throw new ProblemException('etag_mismatch', `the instructions are at version ${have}`);
      let row: Row;
      if (!cur)
        row = (
          await c.query(
            `INSERT INTO builder.project_instructions (id, org_id, project_id, project_layer, customer_layer, customer_block, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [
              newId(),
              orgId,
              p.id,
              JSON.stringify(proj.sections),
              JSON.stringify(cust.sections),
              block,
              actor,
            ],
          )
        ).rows[0] as Row;
      else
        row = (
          await c.query(
            `UPDATE builder.project_instructions SET project_layer = $2, customer_layer = $3, customer_block = $4, updated_by = $5
             WHERE project_id = $1 RETURNING *`,
            [p.id, JSON.stringify(proj.sections), JSON.stringify(cust.sections), block, actor],
          )
        ).rows[0] as Row;
      const out = this.build(p, row);
      await c.query(
        `INSERT INTO builder.instruction_versions (id, org_id, project_id, version, project_layer, customer_layer, customer_block, markdown, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          newId(),
          orgId,
          p.id,
          out.version,
          JSON.stringify(proj.sections),
          JSON.stringify(cust.sections),
          block,
          out.markdown,
          actor,
        ],
      );
      return out;
    });
    await this.audit.record({
      action: 'builder.instructions.updated',
      actorUserId: actor,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id: p.id },
      outcome: 'success',
      detail: { version: dto.version, conflicts: dto.conflicts.length },
    });
    return dto;
  }

  async versions(orgId: string, p: ProjectRecord) {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT version, created_by, created_at FROM builder.instruction_versions WHERE project_id = $1 ORDER BY version DESC LIMIT 100`,
            [p.id],
          )
        ).rows as Row[],
    );
    return {
      items: rows.map((r) => ({
        version: Number(r.version),
        createdBy: (r.created_by as string | null) ?? null,
        createdAt: new Date(r.created_at as string).toISOString(),
      })),
    };
  }

  /** Restoring copies an old version forward as a NEW version (history is never rewritten). */
  async restore(
    orgId: string,
    actor: string,
    p: ProjectRecord,
    version: number,
  ): Promise<InstructionsDto> {
    const old = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM builder.instruction_versions WHERE project_id = $1 AND version = $2`,
            [p.id, version],
          )
        ).rows[0] as Row | undefined,
    );
    if (!old) throw new ProblemException('not_found', 'instruction version not found');
    const cur = await this.get(orgId, p);
    return this.put(
      orgId,
      actor,
      p,
      {
        projectLayer: old.project_layer,
        customerLayer: old.customer_layer,
        customerBlock: old.customer_block,
      },
      cur.version,
    );
  }

  /** Writes `CLAUDE.md` into the project's files as a normal, versioned and committed change (web app and mobile projects). */
  async sync(orgId: string, actor: string, p: ProjectRecord) {
    if (!hasFileTree(p))
      throw new ProblemException(
        'unsupported_capability',
        'a website project is a site model without a free file tree; its instructions are used by the AI runs directly',
      );
    const dto = await this.get(orgId, p);
    const r = await this.files.apply(
      orgId,
      actor,
      p,
      new Map([['CLAUDE.md', dto.markdown]]),
      [],
      'Update CLAUDE.md (Nuzm project instructions)',
    );
    return { changed: r !== null, result: r };
  }
}
