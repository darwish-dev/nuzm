import { PINNED_TOOLCHAIN } from './flutter/toolchain';
import { MOBILE_SPEC_SCHEMA, validateMobileSpec, type MobileSpec } from './flutter/spec';
import { analyzeProject } from './flutter/analysis';
import { generateFlutterProject } from './flutter/templates';
import { ProblemException } from '../../../common/errors';
import type { RunContext, RunKindHandler } from '../../ai';
import type { MobileProjectService } from '../../builder';

const INSTR_DESIGN =
  'You are the mobile design agent of an app builder for businesses in Saudi Arabia. From the description, design a Flutter mobile app as a STRUCTURED SPEC: screens (kind home, list, form, detail or settings), ' +
  'bilingual Arabic and English texts for every label (Arabic is a first-class language, not a translation), a bottom navigation of 1-5 tabs, a primary colour with readable contrast, whether sign-in is needed, ' +
  'and the few Android permissions the app really needs (default none beyond internet). Use only the allowed enumerations. No code, no URLs, no credentials. result = the spec object.';

/**
 * `kind=mobile` (M10 S48): description -> structured mobile spec (design agent) -> human approval of the design (`plan`, bound to the exact spec) -> the trusted template renderer writes the
 * Flutter project -> static analysis gate -> new immutable project version. The model never writes Dart: it returns data, validated here, rendered by `templates.ts` with every string escaped.
 * Resumable per step. Model quality is NOT VERIFIED (scripted/mock adapter only; HG-09-01 / D-18).
 */
export class MobileRunHandler implements RunKindHandler {
  readonly kind = 'mobile';
  /** no tool exists for this kind: the `chat` allow-list is empty, so every tool call a model proposes is denied and recorded */
  readonly toolKind = 'chat' as const;
  readonly requiresProject = true;
  constructor(private readonly projects: MobileProjectService) {}

  validateInput(input: Record<string, unknown>): void {
    const d = input.description;
    if (typeof d !== 'string' || d.trim().length < 3 || d.length > 600)
      throw new ProblemException('validation_failed', 'input.description must be 3 to 600 characters');
    const extra = Object.keys(input).filter((k) => k !== 'description');
    if (extra.length)
      throw new ProblemException('validation_failed', `unknown input members: ${extra.slice(0, 5).join(', ')}`);
  }

  async execute(ctx: RunContext): Promise<void> {
    const projectId = ctx.run.projectId!;
    if (!(await this.projects.mobileEnabled(ctx.orgId)))
      throw new ProblemException('not_found', 'the mobile builder is not enabled for this organization');
    const src = await this.projects.sourceOf(ctx.orgId, projectId);
    if (!src) throw new ProblemException('validation_failed', 'a mobile run needs a project of type mobile');

    // 1. the design agent
    if (!ctx.checkpoint.spec) {
      const description = String(ctx.run.input.description ?? '');
      const spec = await ctx.call<MobileSpec>({
        task: 'mobile_design',
        instruction: INSTR_DESIGN,
        params: { toolchain: PINNED_TOOLCHAIN.templateSet },
        data: [{ label: 'description', text: description }],
        schema: MOBILE_SPEC_SCHEMA,
        maxTokens: 6000,
      });
      const errs = validateMobileSpec(spec);
      if (errs.length)
        throw new ProblemException('validation_failed', 'the design is not a valid mobile spec', errs);
      const artifactId = await ctx.artifact('architecture', spec);
      await ctx.save({ spec, specArtifactId: artifactId }, 'design');
    }
    const spec = ctx.checkpoint.spec as MobileSpec;

    // 2. the human approves the exact design before any project is written
    if (!ctx.checkpoint.planApproved) {
      if (ctx.resumedWith?.kind === 'plan' && ctx.resumedWith.decision === 'approved')
        await ctx.save({ planApproved: true }, 'plan_approved');
      else
        return ctx.requestApproval(
          'plan',
          {
            title: 'Approve the mobile app design',
            appName: spec.app.name,
            applicationId: spec.app.packageId,
            screens: spec.screens.map((s) => ({ id: s.id, kind: s.kind, title: s.title })),
            tabs: spec.navigation.tabs,
            permissions: ['internet', ...spec.permissions.filter((p) => p !== 'internet')],
            artifactId: ctx.checkpoint.specArtifactId,
          },
          { spec },
        );
    }

    // 3. render, analyse, commit (a replay after a crash finds the version by run id)
    if (!ctx.checkpoint.versionId) {
      if (await ctx.cancelled()) throw new ProblemException('conflict', 'cancelled');
      const files = generateFlutterProject(spec);
      const issues = analyzeProject(files);
      if (issues.length)
        throw new ProblemException('validation_failed', 'the generated project failed the analysis gate', issues);
      const v = await this.projects.commit({
        orgId: ctx.orgId,
        projectId,
        files,
        manifest: {
          generator: { ...PINNED_TOOLCHAIN, source: 'nuzm-flutter-core' },
          spec,
        },
        source: 'ai',
        runId: ctx.run.id,
        label: 'AI generated Flutter project',
        userId: ctx.userId,
      });
      await ctx.save({ versionId: v.versionId, versionSeq: v.seq, fileCount: v.fileCount }, 'committed');
    }
    return ctx.succeed({
      projectId,
      versionId: ctx.checkpoint.versionId,
      fileCount: ctx.checkpoint.fileCount,
      toolchain: PINNED_TOOLCHAIN,
      note: 'preview is not a guarantee of device behaviour; model quality NOT VERIFIED',
    });
  }
}
