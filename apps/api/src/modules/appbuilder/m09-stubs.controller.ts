import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { isUuid } from './internal/core';
import { M09StubGuard, AppBuilderEnabledGuard } from './internal/flag.guard';
import { ApprovalService } from './internal/approvals/approval.service';
import { checkPath } from './internal/sandbox/paths';
import { OrgBudgetPort, ProjectsPort, RunStorePort } from './internal/ports/m09';
import { AppRunService } from './internal/run.service';
import { RUN_CEILINGS } from './internal/core';

type Body_ = Record<string, unknown> | undefined;

/** STAND-IN for M09-owned routes (see README.md in this directory): thin wrappers over the M09 ports; delete when M09 is integrated. */
@UseGuards(AppBuilderEnabledGuard, M09StubGuard)
@Controller('v1')
export class M09StubsController {
  constructor(
    private readonly projects: ProjectsPort,
    private readonly runs: AppRunService,
    private readonly runStore: RunStorePort,
    private readonly approvals: ApprovalService,
    private readonly orgBudget: OrgBudgetPort,
  ) {}

  @RequirePermission('builder:write')
  @Idempotent()
  @Post('builder/projects')
  @HttpCode(201)
  async createProject(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    const x = body ?? {};
    if (x.type !== 'webapp' && x.type !== 'mobile')
      throw new ProblemException(
        'unsupported_capability',
        'this stand-in creates webapp and mobile projects; website projects are M09',
      );
    if (typeof x.name !== 'string' || x.name.trim().length < 1 || x.name.length > 80)
      throw new ProblemException('validation_failed', 'name is required (1..80 characters)');
    const region =
      typeof x.dataRegion === 'string' && /^[A-Za-z0-9._-]{2,40}$/.test(x.dataRegion)
        ? x.dataRegion
        : 'sa-central';
    return this.projects.create(orgId, {
      type: x.type,
      name: x.name.trim(),
      dataRegion: region,
      createdBy: a.actor.userId,
      referenceTemplate: typeof x.referenceTemplate === 'string' ? x.referenceTemplate : null,
    });
  }
  @RequirePermission('builder:read')
  @Get('builder/projects')
  async listProjects(@Org() orgId: string, @Query('type') type?: string) {
    return {
      items: await this.projects.list(
        orgId,
        type === 'webapp' || type === 'mobile' ? { type } : {},
      ),
    };
  }
  @RequirePermission('builder:read')
  @Get('builder/projects/:id')
  async getProject(@Org() orgId: string, @Param('id') id: string) {
    const p = isUuid(id) ? await this.projects.get(orgId, id.toLowerCase()) : null;
    if (!p) throw new ProblemException('not_found', 'project not found');
    return { ...p, versions: await this.projects.listVersions(orgId, p.id) };
  }
  @RequirePermission('builder:read')
  @Get('builder/projects/:id/files')
  async files(@Org() orgId: string, @Param('id') id: string) {
    const p = isUuid(id) ? await this.projects.get(orgId, id.toLowerCase()) : null;
    if (!p) throw new ProblemException('not_found', 'project not found');
    const files = p.headVersionId
      ? await this.projects.readFiles(orgId, p.id, p.headVersionId)
      : new Map<string, string>();
    return {
      versionId: p.headVersionId,
      items: [...(files ?? [])]
        .map(([path, c]) => ({ path, size: Buffer.byteLength(c) }))
        .sort((x, y) => x.path.localeCompare(y.path)),
    };
  }
  @RequirePermission('builder:read')
  @Get('builder/projects/:id/files/content')
  async content(@Org() orgId: string, @Param('id') id: string, @Query('path') path: string) {
    const p = isUuid(id) ? await this.projects.get(orgId, id.toLowerCase()) : null;
    const err = checkPath(path);
    if (!p || !p.headVersionId || err) throw new ProblemException('not_found', 'file not found');
    const c = (await this.projects.readFiles(orgId, p.id, p.headVersionId))?.get(path);
    if (c === undefined) throw new ProblemException('not_found', 'file not found');
    return {
      path,
      versionId: p.headVersionId,
      size: Buffer.byteLength(c),
      truncated: Buffer.byteLength(c) > 1_000_000,
      content: c.slice(0, 1_000_000),
    };
  }

  @RequirePermission('ai:run')
  @Idempotent()
  @Post('ai/runs')
  @HttpCode(202)
  async createRun(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.runs.create(orgId, a.actor.userId, body ?? {});
  }
  @RequirePermission('ai:read')
  @Get('ai/runs')
  async listRuns(@Org() orgId: string, @Query('projectId') projectId?: string) {
    return {
      items: await Promise.all(
        (await this.runStore.list(orgId, projectId ? { projectId } : {})).map((r) =>
          this.runs.view(orgId, r.id),
        ),
      ),
    };
  }
  @RequirePermission('ai:read')
  @Get('ai/runs/:id')
  async getRun(@Org() orgId: string, @Param('id') id: string) {
    return this.runs.view(orgId, id.toLowerCase());
  }
  /** Polling form of the event feed (the SSE stream is M09): the steps with their redacted tool calls, in order. */
  @RequirePermission('ai:read')
  @Get('ai/runs/:id/events')
  async events(@Org() orgId: string, @Param('id') id: string) {
    const v = await this.runs.view(orgId, id.toLowerCase());
    return {
      runId: v.id,
      state: v.state,
      events: v.steps.map((s, i) => ({
        seq: i + 1,
        type: `step.${s.status}`,
        data: { node: s.node, agent: s.agent, attempt: s.attempt, toolCalls: s.toolCalls },
      })),
    };
  }
  @RequirePermission('ai:run')
  @Idempotent()
  @Post('ai/runs/:id/cancellation')
  @HttpCode(202)
  async cancel(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string) {
    return this.runs.cancel(orgId, a.actor.userId, id.toLowerCase());
  }
  /** `{approvalId, decision, scopeHash, note?}`: 409 `stale_approval_hash`, 410 expired, 403 role. The approval must belong to THIS run. */
  @RequirePermission('ai:approve')
  @Idempotent()
  @Post('ai/runs/:id/approvals')
  @HttpCode(200)
  async decide(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    const x = body ?? {};
    if (!isUuid(x.approvalId))
      throw new ProblemException('validation_failed', 'approvalId is required');
    const cur = await this.approvals.get(orgId, x.approvalId.toLowerCase());
    if (cur.runId !== id.toLowerCase() && cur.subjectId !== id.toLowerCase())
      throw new ProblemException('not_found', 'approval not found');
    return this.approvals.decide(
      orgId,
      { userId: a.actor.userId, role: a.role, permissions: a.permissions },
      cur.id,
      x as never,
    );
  }
  /** Caps and what is left (read only here: PUT is M09). */
  @RequirePermission('ai:budget')
  @Get('ai/budgets')
  async budgets(@Org() orgId: string) {
    return {
      orgRemainingMinor: await this.orgBudget.remainingMinor(orgId),
      ceilings: {
        maxTokens: RUN_CEILINGS.maxTokens,
        maxMinutes: RUN_CEILINGS.maxMinutes,
        maxSteps: RUN_CEILINGS.maxSteps,
        warnAtPct: RUN_CEILINGS.warnAtPct,
      },
      defaults: { maxTokens: 1_000_000, maxCostMinor: 50_000, maxMinutes: 30 },
    };
  }
}
