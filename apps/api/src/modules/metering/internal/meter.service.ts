import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';

const WINDOWS = ['hour', 'day', 'event'];
const BASIS = ['usage', 'included', 'pass', 'subscription'];

/** Meter catalogue admin (docs/12 §3). The unit is immutable once events exist (database trigger). */
export class MeterService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async list() {
    return this.db.withPlatformScope(async (c) => ({
      items: (
        await c.query(
          `SELECT m.id, m.unit, m.aggregation_window, m.basis, m.dimensions_allowed, m.description, m.created_at,
                  EXISTS (SELECT 1 FROM metering.usage_events e WHERE e.meter_id = m.id) AS has_events
             FROM metering.meters m ORDER BY m.id`,
        )
      ).rows.map((r) => ({
        id: r.id as string,
        unit: r.unit as string,
        aggregationWindow: r.aggregation_window as string,
        basis: r.basis as string,
        dimensionsAllowed: r.dimensions_allowed as string[],
        description: r.description as string,
        hasEvents: r.has_events as boolean,
      })),
      nextCursor: null as string | null,
    }));
  }

  async create(input: Record<string, unknown>, actorUserId: string) {
    const bad = (m: string) => new ProblemException('validation_failed', m);
    const id = input.id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(id))
      throw bad('id must look like group.name (lowercase, digits, underscores)');
    if (typeof input.unit !== 'string' || input.unit.length < 1 || input.unit.length > 40)
      throw bad('unit is required (1..40 characters)');
    if (typeof input.aggregationWindow !== 'string' || !WINDOWS.includes(input.aggregationWindow))
      throw bad('aggregationWindow must be hour, day or event');
    if (typeof input.basis !== 'string' || !BASIS.includes(input.basis))
      throw bad('basis must be usage, included, pass or subscription');
    const dims = input.dimensionsAllowed ?? [];
    if (
      !Array.isArray(dims) ||
      dims.length > 20 ||
      !dims.every((d) => typeof d === 'string' && /^[a-z][a-z0-9_]{0,40}$/.test(d))
    )
      throw bad('dimensionsAllowed must be up to 20 lowercase keys');
    try {
      await this.db.withPlatformScope(async (c) => {
        await c.query(
          `INSERT INTO metering.meters (id, unit, aggregation_window, basis, dimensions_allowed, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            input.unit,
            input.aggregationWindow,
            input.basis,
            dims,
            typeof input.description === 'string' ? input.description.slice(0, 500) : '',
            actorUserId,
          ],
        );
        await this.audit.record({
          action: 'metering.meter.created',
          actorUserId,
          resource: { type: 'meter', id },
          outcome: 'success',
          after: { unit: input.unit, basis: input.basis },
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'a meter with this id already exists');
      throw e;
    }
    return {
      id,
      unit: input.unit as string,
      aggregationWindow: input.aggregationWindow as string,
      basis: input.basis as string,
      dimensionsAllowed: dims as string[],
      description: '',
      hasEvents: false,
    };
  }
}
