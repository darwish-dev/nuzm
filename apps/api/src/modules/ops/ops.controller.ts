import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { AlertService } from './alerts.service';
import { HealthService } from './health.service';
import { IncidentService } from './incidents.service';
import { ProviderIncidentService } from './provider-incidents.service';
import { RecoveryExerciseService } from './recovery-exercises.service';

const idem = (req: FastifyRequest): string => {
  const k = req.headers['idempotency-key'];
  if (typeof k !== 'string' || k.length < 1 || k.length > 255)
    throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
  return k;
};
type B = Record<string, unknown> | undefined;

/** Operations console API (docs/04 §2.12). Admin realm, MFA-verified session; writes need admin:ops:manage and a recent MFA step-up. */
@RealmOnly('admin')
@Controller('v1/admin')
export class OpsController {
  constructor(
    private readonly health: HealthService,
    private readonly incidents: IncidentService,
    private readonly alerts: AlertService,
    private readonly providerIncidents: ProviderIncidentService,
    private readonly exercises: RecoveryExerciseService,
  ) {}

  private manage(who: PlatformContext) {
    if (!who.permissions.has('admin:ops:manage'))
      throw new ProblemException('forbidden', 'permission admin:ops:manage is required');
  }

  @RequirePlatformPermission('admin:ops:read')
  @Get('operations/health')
  getHealth() {
    return this.health.report();
  }

  @RequirePlatformPermission('admin:ops:read')
  @Get('incidents')
  listIncidents(@Query() q: Record<string, string>) {
    return this.incidents.list({
      status: q.status,
      severity: q.severity,
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
  }

  @RequirePlatformPermission('admin:ops:read')
  @StepUp()
  @Post('incidents')
  async openIncident(
    @Platform() who: PlatformContext,
    @Body() b: B,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.manage(who);
    const r = await this.incidents.open(who.userId, idem(req), b ?? {});
    void reply.status(r.created ? 201 : 200);
    return r.incident;
  }

  @RequirePlatformPermission('admin:ops:read')
  @StepUp()
  @Patch('incidents/:id')
  async patchIncident(@Platform() who: PlatformContext, @Param('id') id: string, @Body() b: B) {
    this.manage(who);
    return this.incidents.update(who.userId, id, b ?? {});
  }

  @RequirePlatformPermission('admin:ops:read')
  @Get('alerts')
  listAlerts(@Query() q: Record<string, string>) {
    return this.alerts.list({ state: q.state, limit: parseLimit(q.limit), cursor: q.cursor });
  }

  @RequirePlatformPermission('admin:ops:read')
  @StepUp()
  @Post('alerts')
  async alertAction(
    @Platform() who: PlatformContext,
    @Body() b: B,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.manage(who);
    idem(req); // actions are idempotent by construction (state machine); the key is required by the contract
    const r = await this.alerts.act(who.userId, b ?? {});
    void reply.status(r.created ? 201 : 200);
    return r.alert;
  }

  @RequirePlatformPermission('admin:ops:read')
  @Get('provider-incidents')
  listProviderIncidents(@Query() q: Record<string, string>) {
    return this.providerIncidents.list({
      providerKey: q.providerKey,
      status: q.status,
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
  }

  @RequirePlatformPermission('admin:ops:read')
  @Get('recovery-exercises')
  listExercises(@Query() q: Record<string, string>) {
    return this.exercises.list({ scope: q.scope, limit: parseLimit(q.limit), cursor: q.cursor });
  }

  @RequirePlatformPermission('admin:ops:read')
  @StepUp()
  @Post('recovery-exercises')
  async recordExercise(
    @Platform() who: PlatformContext,
    @Body() b: B,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.manage(who);
    const r = await this.exercises.record(who.userId, idem(req), b ?? {});
    void reply.status(r.created ? 201 : 200);
    return r.exercise;
  }
}
