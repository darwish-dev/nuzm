import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PlatformError } from '@nuzm/platform';
import { ERROR_REGISTRY, ProblemException, isErrorCode, type ErrorCode } from './errors';

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string;
    /** Set by the auth layer (S03) from verified credentials; never from request input. */
    orgId?: string;
  }
}

/** Renders every error as RFC 9457 problem+json with a registry code and the request trace id. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    let code: ErrorCode = 'internal_error';
    let detail: string | undefined;
    let errors: unknown[] | undefined;
    let extra: Record<string, unknown> | undefined;

    if (exception instanceof ProblemException) {
      code = exception.code;
      detail = exception.detail;
      errors = exception.errors;
      extra = exception.extra;
    } else if (exception instanceof PlatformError) {
      code = isErrorCode(exception.code) ? exception.code : 'internal_error';
      detail = code === 'internal_error' ? undefined : exception.message;
    } else if (exception instanceof HttpException) {
      const s = exception.getStatus();
      code =
        s === 404
          ? 'not_found'
          : s === 401
            ? 'unauthenticated'
            : s === 403
              ? 'forbidden'
              : s === 429
                ? 'rate_limited'
                : s >= 400 && s < 500
                  ? 'validation_failed'
                  : 'internal_error';
      detail = s === 404 ? undefined : exception.message;
    }

    const { status, title } = ERROR_REGISTRY[code];
    if (status >= 500)
      this.log.error(
        `${req.method} ${req.url} trace=${req.traceId} ${exception instanceof Error ? exception.stack : String(exception)}`,
      );

    void reply
      .status(status)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .send({
        type: `urn:nuzm:error:${code}`,
        title,
        status,
        code,
        ...(detail ? { detail } : {}),
        traceId: req.traceId,
        ...(errors ? { errors } : {}),
        ...(extra ?? {}),
      });
  }
}
