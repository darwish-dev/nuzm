import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ProblemException } from '../../common/errors';
import { SlidingWindowLimiter } from '../../common/rate-limit';
import { Public } from '../identity';
import { PanelInstallService } from './internal/hestia-vps/panel-install.service';

/**
 * The server's own callbacks while HestiaCP installs (S04). Unauthenticated by design: the single-use registration secret in `Authorization: Bearer nzr1.…` is the credential, it is
 * bound to ONE order and ONE server, short-lived, and on registration the caller's address must be one of the server's public addresses as the PROVIDER reports them.
 * Nothing here reads a customer, an organization or a session; the organization comes from the install row the secret belongs to.
 */
@Controller('v1/bootstrap/panel')
export class PanelBootstrapController {
  private readonly limiter = new SlidingWindowLimiter();
  constructor(private readonly panel: PanelInstallService) {}

  private limit(req: FastifyRequest, bucket: string, perMinute: number) {
    if (!this.limiter.allow(`${bucket}:${req.ip}`, perMinute, 60_000))
      throw new ProblemException('rate_limited', 'too many requests');
  }

  @Public()
  @Post('events')
  @HttpCode(204)
  async events(
    @Headers('authorization') auth: string | undefined,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    this.limit(req, 'panel-events', 60);
    await this.panel.handleEvent(auth, body);
  }

  @Public()
  @Post('register')
  @HttpCode(200)
  async register(
    @Headers('authorization') auth: string | undefined,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    this.limit(req, 'panel-register', 20);
    return this.panel.handleRegister(auth, body, req.ip ?? '');
  }
}
