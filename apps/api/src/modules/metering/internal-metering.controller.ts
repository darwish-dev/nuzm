import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ProblemException } from '../../common/errors';
import { Public } from '../identity';
import { MeteringIngestService } from './internal/ingest.service';
import { ProducerAuthenticator } from './internal/producer-auth';

/**
 * INTERNAL interface for producers that have no database access (node agents, sandbox runners). Authenticated by a
 * per-source service key, not by a user session: the key fixes the `source` and optionally the organizations the producer
 * may report for. `orgId` in an event is accepted only if the key permits it.
 */
@Controller('v1/internal/metering')
export class InternalMeteringController {
  constructor(
    private readonly auth: ProducerAuthenticator,
    private readonly ingest: MeteringIngestService,
  ) {}

  @Public() // not a user route: the handler authenticates the service key and refuses everything else
  @Post('events')
  @HttpCode(200)
  async events(
    @Headers('authorization') authz: string | undefined,
    @Body() body: { events?: unknown } | undefined,
    @Req() req: FastifyRequest,
  ) {
    if (!this.auth.configured)
      throw new ProblemException('service_unavailable', 'metering producers are not configured');
    const m = /^Bearer\s+(\S+)$/i.exec(authz ?? '');
    const producer = this.auth.authenticate(m?.[1]);
    if (!producer) throw new ProblemException('unauthenticated');
    req.log?.debug?.({ source: producer.source }, 'metering ingest');
    return this.ingest.ingest(body?.events, producer);
  }
}
