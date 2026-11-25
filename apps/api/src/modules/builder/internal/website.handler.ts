import {
  ARCHITECTURE_SCHEMA,
  PAGE_RESULT_SCHEMA,
  REQUIREMENTS_TURN_SCHEMA,
  validateSiteModel,
  WEBSITE_ARCHITECTURE,
  WEBSITE_REQUIREMENTS_DEFAULTS,
  websitePage,
  type Architecture,
  type Locale,
  type Requirements,
  type RequirementsTurn,
  PROMPT_LIMITS,
  shortOrPointer,
} from '@nuzm/domain';
import { ProblemException } from '../../../common/errors';
import type { RunContext, RunKindHandler } from '../../ai';
import { assembleGenerated, type PageResult } from './assemble';
import { DESIGN_RULES, checkPageResult, sectionGuide } from './page-guide';
import type { VersionArtifactService } from './artifact.service';
import type { ProjectService } from './project.service';
import { repairFindings } from './qa/runner';

const INSTR_ARCH = WEBSITE_ARCHITECTURE;
const INSTR_PAGE = websitePage(sectionGuide(), DESIGN_RULES);

/** `kind=website` (M09 S38/S39): requirements → architecture → **plan approval** → per-page copy/layout → assembled site model → validated → new project version. Resumable per step. */
export class WebsiteRunHandler implements RunKindHandler {
  readonly kind = 'website';
  readonly toolKind = 'website' as const;
  readonly requiresProject = true;
  constructor(
    private readonly projects: ProjectService,
    private readonly artifacts?: VersionArtifactService,
  ) {}
  validateInput(input: Record<string, unknown>): void {
    if (
      input.requirementsArtifactId !== undefined &&
      typeof input.requirementsArtifactId !== 'string'
    )
      throw new ProblemException(
        'validation_failed',
        'input.requirementsArtifactId must be a string',
      );
    if (
      input.description !== undefined &&
      (typeof input.description !== 'string' ||
        input.description.length > PROMPT_LIMITS.projectPromptChars)
    )
      throw new ProblemException(
        'validation_failed',
        `input.description must be up to ${PROMPT_LIMITS.projectPromptChars} characters`,
      );
    if (!input.requirementsArtifactId && !input.description)
      throw new ProblemException(
        'validation_failed',
        'input needs requirementsArtifactId or a description',
      );
  }

  async execute(ctx: RunContext): Promise<void> {
    const projectId = ctx.run.projectId!;
    const head = await this.projects.headVersion(ctx.orgId, projectId);
    if (!head) throw new ProblemException('not_found', 'project not found');
    const locales = head.model.locales as Locale[];
    const projectName = (head.model.brand.name as Record<string, string>)[locales[0]!] ?? 'Site';

    // 1. requirements
    if (!ctx.checkpoint.requirements) {
      let req: Requirements | undefined;
      const aid = ctx.run.input.requirementsArtifactId as string | undefined;
      if (aid) {
        const a = await ctx.loadArtifact(aid);
        if (a?.type !== 'requirements')
          throw new ProblemException(
            'validation_failed',
            'requirementsArtifactId is not a requirements artifact',
          );
        req = a.payload as Requirements;
      } else {
        const turn = await ctx.call<RequirementsTurn>({
          task: 'requirements',
          instruction: WEBSITE_REQUIREMENTS_DEFAULTS,
          params: {
            // the whole description travels as the data block below; a short one is repeated here, a long one is never cut
            description: shortOrPointer(String(ctx.run.input.description ?? ''), 'description'),
            skip: true,
            answeredSoFar: 0,
          },
          data: [{ label: 'description', text: String(ctx.run.input.description ?? '') }],
          schema: REQUIREMENTS_TURN_SCHEMA,
          maxTokens: 2000,
        });
        if (!turn.requirements)
          throw new ProblemException('validation_failed', 'the agent did not return requirements');
        req = { ...turn.requirements, usedDefaults: true };
      }
      await ctx.save({ requirements: req }, 'requirements');
    }
    const req = ctx.checkpoint.requirements as Requirements;
    // the site's name is the business the requirements name (e.g. "VERTEX Media"), not the project name, which the start screen derives from the first words of the
    // customer's description; the project name is the fallback only
    const siteName = req.businessName?.trim() ? req.businessName.trim() : projectName;
    const description = String(ctx.run.input.description ?? '');
    const brief = description ? [{ label: 'description', text: description }] : [];

    // 2. architecture
    if (!ctx.checkpoint.architecture) {
      const arch = await ctx.call<Architecture>({
        task: 'architecture',
        instruction: INSTR_ARCH,
        params: { requirements: req, locales },
        // the customer's whole description (DATA) next to its structured summary: details the summary had no field for are not lost
        data: brief,
        schema: ARCHITECTURE_SCHEMA,
        maxTokens: 4000,
      });
      const ids = arch.siteMap.map((p) => p.pageId);
      const slugs = arch.siteMap.map((p) => p.slug);
      if (
        new Set(ids).size !== ids.length ||
        new Set(slugs).size !== slugs.length ||
        !slugs.includes('home') ||
        arch.seoPlan.some((s) => !ids.includes(s.pageId))
      )
        throw new ProblemException(
          'validation_failed',
          'the architecture has duplicate or missing pages',
        );
      const artifactId = await ctx.artifact('architecture', arch);
      await ctx.save({ architecture: arch, architectureArtifactId: artifactId }, 'architecture');
    }
    const arch = ctx.checkpoint.architecture as Architecture;

    // 3. human approval of the plan (approval kind `plan`), bound to the exact architecture
    if (!ctx.checkpoint.planApproved) {
      if (ctx.resumedWith?.kind === 'plan' && ctx.resumedWith.decision === 'approved')
        await ctx.save({ planApproved: true }, 'plan_approved');
      else
        return ctx.requestApproval(
          'plan',
          {
            title: 'Approve the site plan',
            pages: arch.siteMap.map((p) => ({
              pageId: p.pageId,
              slug: p.slug,
              title: p.title,
              sections: p.sections.length,
            })),
            artifactId: ctx.checkpoint.architectureArtifactId,
          },
          { architecture: arch },
        );
    }

    // 4. per-page copy and layout (each page checkpointed: a crash never repeats a finished page)
    const pages = { ...((ctx.checkpoint.pages as Record<string, PageResult>) ?? {}) };
    for (const ap of arch.siteMap) {
      if (pages[ap.pageId]) continue;
      if (await ctx.cancelled()) throw new ProblemException('conflict', 'cancelled');
      const r = await ctx.call<PageResult>({
        task: 'page',
        instruction: INSTR_PAGE,
        params: { architecture: arch, pageId: ap.pageId, requirements: req, locales },
        data: brief,
        schema: PAGE_RESULT_SCHEMA,
        // the same validation the finished site gets, on this one page: what is wrong goes back to the model instead of failing the run at the end
        check: (res) =>
          checkPageResult(
            (page) =>
              assembleGenerated({ name: siteName, locales }, req, arch, [page as PageResult]),
            { ...(res as PageResult), pageId: ap.pageId },
            arch.siteMap.map((x) => x.pageId),
          ),
        maxTokens: 8000,
      });
      if (r.pageId !== ap.pageId)
        throw new ProblemException('validation_failed', 'the page result names another page');
      pages[ap.pageId] = r;
      await ctx.save({ pages }, `page:${ap.pageId}`);
      await ctx.emit('page_generated', { pageId: ap.pageId });
    }

    // 5. assemble, validate, commit as a NEW version
    const model = assembleGenerated({ name: siteName, locales }, req, arch, Object.values(pages));
    const issues = validateSiteModel(model);
    if (issues.length) {
      await ctx.emit('model_invalid', { issues: issues.slice(0, 10) });
      throw new ProblemException(
        'op_invalid',
        `the generated site model is not valid (${issues.length} issues)`,
        issues.slice(0, 10),
      );
    }
    const siteArtifact = await ctx.artifact('site_model', model);
    const v = await this.projects.commitGenerated(ctx.orgId, {
      projectId,
      model,
      runId: ctx.run.id,
      userId: ctx.userId,
    });
    await ctx.emit('version_created', { versionId: v.versionId, seq: v.seq, buildMs: v.buildMs });
    // Quality gates over the files that were just stored (P3-S04). Reporting only: the version already exists and the run's outcome does not depend on it, so the offline
    // pipeline behaves as before; the repair loop (P3-S03) and the publish step read the same report through `VersionArtifactService.qa`. axe needs a DOM and several
    // seconds, so it runs in the QA CLI/CI, not inside a run.
    let qa: Record<string, unknown> | undefined;
    if (this.artifacts) {
      try {
        const r = await this.artifacts.qa(ctx.orgId, projectId, v.versionId, { axe: 'off' });
        qa = {
          passed: r.report.passed,
          errors: r.report.counts.errors,
          warnings: r.report.counts.warnings,
          artifactHash: r.report.rootHash,
          failing: repairFindings(r.report, 10).map((f) => f.code),
        };
        await ctx.emit('qa_report', qa);
      } catch {
        await ctx.emit('qa_unavailable', { versionId: v.versionId });
      }
    }
    return ctx.succeed({
      projectId,
      versionId: v.versionId,
      seq: v.seq,
      siteModelArtifactId: siteArtifact,
      pages: arch.siteMap.length,
      ...(qa ? { qa } : {}),
    });
  }
}
