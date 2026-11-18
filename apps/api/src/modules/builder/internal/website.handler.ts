import {
  ARCHITECTURE_SCHEMA,
  PAGE_RESULT_SCHEMA,
  REQUIREMENTS_TURN_SCHEMA,
  validateSchema,
  validateSiteModel,
  type Architecture,
  type Locale,
  type Requirements,
  type RequirementsTurn,
} from '@nuzm/domain';
import { ProblemException } from '../../../common/errors';
import type { RunContext, RunKindHandler } from '../../ai';
import { assembleGenerated, type PageResult } from './assemble';
import type { ProjectService } from './project.service';

const INSTR_ARCH =
  'You are the architecture agent of a website builder for businesses in Saudi Arabia. From the approved requirements, design the site: pages (siteMap with sections from the allowed component types), ' +
  'design tokens and colours (readable contrast), and an SEO plan per page. Arabic and English are equal. result = the architecture object.';
const INSTR_PAGE =
  'You write ONE page of the website as structured site-model sections (hero, text, image, gallery, features, pricing, testimonials, faq, contact_form, map) with Arabic and English copy ' +
  'for every text. No HTML, no scripts, no links except {pageId} or https/mailto/tel URLs. Use only placeholder image ids. result = {pageId,title,seo?,sections,assets?,forms?}.';

/** `kind=website` (M09 S38/S39): requirements → architecture → **plan approval** → per-page copy/layout → assembled site model → validated → new project version. Resumable per step. */
export class WebsiteRunHandler implements RunKindHandler {
  readonly kind = 'website';
  readonly toolKind = 'website' as const;
  readonly requiresProject = true;
  constructor(private readonly projects: ProjectService) {}
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
      (typeof input.description !== 'string' || input.description.length > 600)
    )
      throw new ProblemException(
        'validation_failed',
        'input.description must be up to 600 characters',
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
          instruction:
            'Produce the final requirements with sensible defaults; do not ask questions.',
          params: {
            description: String(ctx.run.input.description ?? '').slice(0, 600),
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

    // 2. architecture
    if (!ctx.checkpoint.architecture) {
      const arch = await ctx.call<Architecture>({
        task: 'architecture',
        instruction: INSTR_ARCH,
        params: { requirements: req, locales },
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
        schema: PAGE_RESULT_SCHEMA,
        maxTokens: 6000,
      });
      if (r.pageId !== ap.pageId)
        throw new ProblemException('validation_failed', 'the page result names another page');
      pages[ap.pageId] = r;
      await ctx.save({ pages }, `page:${ap.pageId}`);
      await ctx.emit('page_generated', { pageId: ap.pageId });
    }

    // 5. assemble, validate, commit as a NEW version
    const model = assembleGenerated(
      { name: projectName, locales },
      req,
      arch,
      Object.values(pages),
    );
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
    void validateSchema;
    return ctx.succeed({
      projectId,
      versionId: v.versionId,
      seq: v.seq,
      siteModelArtifactId: siteArtifact,
      pages: arch.siteMap.length,
    });
  }
}
