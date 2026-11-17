import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { ZatcaOnboardingService } from './internal/zatca/onboarding.service';
import { ZatcaSubmissionService } from './internal/zatca/submission.service';

/**
 * E-invoicing administration (docs/04). SIMULATED environments only; nothing here talks to ZATCA. Onboarding: finance requests a step
 * (`admin:zatca:manage`), and for credential steps a DIFFERENT person with `admin:zatca:approve` (security) approves it and supplies the
 * one-time password from the portal. The OTP is never stored or logged. Production is not enabled by this code.
 */
@RealmOnly('admin')
@Controller('v1/admin/billing/zatca')
export class AdminZatcaController {
  constructor(
    private readonly onboarding: ZatcaOnboardingService,
    private readonly submissions: ZatcaSubmissionService,
  ) {}

  @RequirePlatformPermission('admin:billing:read')
  @Get('onboarding')
  async onboardingState(@Query() q: { environment?: string }) {
    return { items: await this.onboarding.view(q.environment) };
  }

  @RequirePlatformPermission('admin:billing:read')
  @StepUp()
  @Post('onboarding')
  @HttpCode(201)
  async step(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const b = body ?? {};
    if ('stepId' in b) {
      if (!who.permissions.has('admin:zatca:approve'))
        throw new ProblemException('forbidden', 'permission admin:zatca:approve is required');
      void reply.status(200);
      return this.onboarding.decide(who.userId, b);
    }
    if (!who.permissions.has('admin:zatca:manage'))
      throw new ProblemException('forbidden', 'permission admin:zatca:manage is required');
    return this.onboarding.request(who.userId, b);
  }

  @RequirePlatformPermission('admin:billing:read')
  @Get('submissions')
  list(
    @Query()
    q: {
      limit?: string;
      cursor?: string;
      state?: string;
      org?: string;
      deadLetter?: string;
    },
  ) {
    if (q.deadLetter !== undefined && q.deadLetter !== 'true' && q.deadLetter !== 'false')
      throw new ProblemException('validation_failed', 'deadLetter must be true or false');
    return this.submissions.list({
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      state: q.state,
      org: q.org,
      deadLetter: q.deadLetter === undefined ? undefined : q.deadLetter === 'true',
    });
  }

  @RequirePlatformPermission('admin:billing:read')
  @StepUp()
  @Post('submissions/:id/retry')
  @HttpCode(200)
  retry(@Platform() who: PlatformContext, @Param('id') id: string) {
    if (!who.permissions.has('admin:zatca:manage'))
      throw new ProblemException('forbidden', 'permission admin:zatca:manage is required');
    return this.submissions.retry(who.userId, id);
  }
}
