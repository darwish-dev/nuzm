import {
  Body,
  CanActivate,
  Catch,
  Controller,
  Delete,
  ExceptionFilter,
  ArgumentsHost,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SlidingWindowLimiter } from '../../../common/rate-limit';
import { Public } from '../../identity';
import { SCHEMA_ERROR, ScimError, ScimService } from './scim.service';
import { ScimTokenService, type ScimPrincipal } from './scim-tokens.service';

declare module 'fastify' {
  interface FastifyRequest {
    scim?: ScimPrincipal;
  }
}
const SCIM_TYPE = 'application/scim+json';
const send = (reply: FastifyReply, status: number, body: unknown) =>
  reply.status(status).header('content-type', SCIM_TYPE).send(body);

/** RFC 7644 §3.12 error schema. Unknown errors never leak internals. */
@Catch()
export class ScimExceptionFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (e instanceof ScimError)
      return send(reply, e.status, {
        schemas: [SCHEMA_ERROR],
        status: String(e.status),
        ...(e.scimType ? { scimType: e.scimType } : {}),
        detail: e.message,
      });
    const status = (e as { getStatus?: () => number }).getStatus?.() ?? 500;
    const detail =
      status === 401
        ? 'Unauthorized'
        : status === 429
          ? 'Too many requests'
          : status < 500
            ? 'Bad request'
            : 'Internal error';
    return send(reply, status, { schemas: [SCHEMA_ERROR], status: String(status), detail });
  }
}

const limiter = new SlidingWindowLimiter();
export const SCIM_RATE_PER_MINUTE = Number(process.env.SCIM_RATE_PER_MINUTE ?? 600);

@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(private readonly tokens: ScimTokenService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Bearer\s+(nzscim_\S+)$/i.exec(h) : null;
    const p = m ? await this.tokens.authenticate(m[1]!) : null;
    if (!p) throw new ScimError(401, undefined, 'Unauthorized');
    if (!limiter.allow(`scim:${p.tokenId}`, SCIM_RATE_PER_MINUTE, 60_000))
      throw new ScimError(429, undefined, 'Too many requests');
    req.scim = p;
    return true;
  }
}

/** SCIM 2.0 server (RFC 7643/7644). Served at /scim/v2 (outside /v1: docs/04 §1). Auth: org-scoped SCIM bearer token, never a session. */
@Public()
@UseGuards(ScimAuthGuard)
@UseFilters(ScimExceptionFilter)
@Controller('scim/v2')
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  @Get('ServiceProviderConfig') config(@Res() r: FastifyReply) {
    return send(r, 200, this.scim.serviceProviderConfig());
  }
  @Get('ResourceTypes') types(@Res() r: FastifyReply) {
    return send(r, 200, this.scim.resourceTypes());
  }
  @Get('Schemas') schemas(@Res() r: FastifyReply) {
    return send(r, 200, this.scim.schemas());
  }

  @Get('Users')
  async list(
    @Req() req: FastifyRequest,
    @Res() r: FastifyReply,
    @Query() q: Record<string, string>,
  ) {
    return send(
      r,
      200,
      await this.scim.listUsers(req.scim!, {
        filter: q.filter,
        startIndex: q.startIndex ? Number(q.startIndex) : undefined,
        count: q.count !== undefined ? Number(q.count) : undefined,
      }),
    );
  }
  @Post('Users')
  async create(
    @Req() req: FastifyRequest,
    @Res() r: FastifyReply,
    @Body() b: Record<string, unknown>,
  ) {
    const { user, created } = await this.scim.createUser(req.scim!, b ?? {});
    return send(r.header('location', user.meta.location), created ? 201 : 200, user);
  }
  @Get('Users/:id')
  async get(@Req() req: FastifyRequest, @Res() r: FastifyReply, @Param('id') id: string) {
    return send(r, 200, await this.scim.getUser(req.scim!, id));
  }
  @Put('Users/:id')
  async put(
    @Req() req: FastifyRequest,
    @Res() r: FastifyReply,
    @Param('id') id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return send(r, 200, await this.scim.replaceUser(req.scim!, id, b ?? {}));
  }
  @Patch('Users/:id')
  async patch(
    @Req() req: FastifyRequest,
    @Res() r: FastifyReply,
    @Param('id') id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return send(r, 200, await this.scim.patchUser(req.scim!, id, b ?? {}));
  }
  @Delete('Users/:id')
  @HttpCode(204)
  async del(@Req() req: FastifyRequest, @Res() r: FastifyReply, @Param('id') id: string) {
    await this.scim.deleteUser(req.scim!, id);
    return r.status(204).send();
  }

  @Get('Groups') async groups(@Req() req: FastifyRequest, @Res() r: FastifyReply) {
    return send(r, 200, await this.scim.listGroups(req.scim!));
  }
  @Get('Groups/:id') async group(
    @Req() req: FastifyRequest,
    @Res() r: FastifyReply,
    @Param('id') id: string,
  ) {
    return send(r, 200, await this.scim.getGroup(req.scim!, id));
  }
  @Patch('Groups/:id')
  async patchGroup(
    @Req() req: FastifyRequest,
    @Res() r: FastifyReply,
    @Param('id') id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return send(r, 200, await this.scim.patchGroup(req.scim!, id, b ?? {}));
  }
}
