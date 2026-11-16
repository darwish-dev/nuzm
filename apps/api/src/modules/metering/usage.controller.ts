import { Controller, Get, Query } from '@nestjs/common';
import { Org, RequirePermission } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { SlidingWindowLimiter } from '../../common/rate-limit';
import { UsageService, type Granularity } from './internal/usage.service';

const date = (name: string, v: string | undefined) => {
  if (v === undefined) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new ProblemException('validation_failed', `${name} must be an ISO-8601 timestamp`);
  return d;
};
type Q = {
  meter?: string;
  resource?: string;
  from?: string;
  to?: string;
  limit?: string;
  cursor?: string;
  granularity?: string;
  period?: string;
};

/** Customer usage (docs/04 §2.2). The caller's organization only; `dataRegion` is part of every point. */
@Controller('v1/usage')
export class UsageController {
  private readonly eventsLimiter = new SlidingWindowLimiter();
  constructor(private readonly usage: UsageService) {}

  @RequirePermission('usage:read')
  @Get()
  list(@Org() orgId: string, @Query() q: Q) {
    const g = q.granularity ?? 'day';
    if (g !== 'hour' && g !== 'day' && g !== 'month')
      throw new ProblemException('validation_failed', 'granularity must be hour, day or month');
    return this.usage.list(orgId, {
      meterId: q.meter,
      resourceId: q.resource,
      from: date('from', q.from),
      to: date('to', q.to),
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      granularity: g as Granularity,
    });
  }

  /** `period=YYYY-MM` (default: the current UTC month). */
  @RequirePermission('usage:read')
  @Get('summary')
  summary(@Org() orgId: string, @Query() q: Q) {
    if (q.period !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(q.period))
      throw new ProblemException('validation_failed', 'period must be YYYY-MM');
    return this.usage.summary(orgId, q.period ? new Date(`${q.period}-01T00:00:00Z`) : undefined);
  }

  /** Raw events: owner/admin/billing_admin only (`usage:events:read`), rate limited per organization. */
  @RequirePermission('usage:events:read')
  @Get('events')
  events(@Org() orgId: string, @Query() q: Q) {
    // in-memory limiter: NOT VERIFIED for several API instances (moves to Redis with D-03)
    if (!this.eventsLimiter.allow(`usage-events:${orgId}`, 60, 60_000))
      throw new ProblemException('rate_limited', 'too many requests for raw usage events');
    return this.usage.events(orgId, {
      meterId: q.meter,
      resourceId: q.resource,
      from: date('from', q.from),
      to: date('to', q.to),
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
  }
}
