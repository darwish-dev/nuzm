import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, firstValueFrom, from } from 'rxjs';
import { IdempotencyService, requestHash } from '@nuzm/platform';
import { ProblemException } from './errors';

export const IDEMPOTENT = 'nuzm:idempotent';
/** Mark a side-effecting POST as requiring an `Idempotency-Key` (docs/04 §1). */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly service: IdempotencyService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.getAllAndOverride<boolean>(IDEMPOTENT, [ctx.getHandler(), ctx.getClass()]))
      return next.handle();

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const reply = ctx.switchToHttp().getResponse<FastifyReply>();
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0)
      throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
    if (!req.orgId) throw new ProblemException('unauthenticated');

    const hash = requestHash(req.method, req.url.split('?')[0] ?? req.url, req.body);
    return from(
      this.service
        .run(req.orgId, key, hash, async () => {
          const body = await firstValueFrom(next.handle());
          return { status: reply.statusCode, body };
        })
        .then((r) => {
          void reply.status(r.status);
          if (r.replayed) void reply.header('idempotent-replayed', 'true');
          return r.body;
        }),
    );
  }
}
