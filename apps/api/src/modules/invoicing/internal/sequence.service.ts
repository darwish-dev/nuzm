import type { PoolClient } from 'pg';
import { ProblemException } from '../../../common/errors';

/**
 * Gapless invoice numbers. `next` must be called INSIDE the issuing transaction (the caller owns the client): the increment
 * commits or rolls back together with the invoice, so a failed issue gives its number back and no number is ever skipped.
 */
export class SequenceService {
  async next(
    c: PoolClient,
    entityId: string,
    series: string,
  ): Promise<{ value: bigint; formatted: string }> {
    if (!/^[A-Z]{2,6}$/.test(series))
      throw new ProblemException('validation_failed', 'series must be 2..6 capital letters');
    const r = await c.query<{ n: string }>('SELECT invoicing.allocate_number($1, $2)::text AS n', [
      entityId,
      series,
    ]);
    const value = BigInt(r.rows[0]!.n);
    return { value, formatted: `${series}-${value.toString().padStart(8, '0')}` };
  }
}
