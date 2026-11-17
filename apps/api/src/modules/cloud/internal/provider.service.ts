import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { AdapterRegistry } from './adapter-registry';
import { UUID, body, iso, oneOf, pgCode, reqText, type Row } from './common';

export const PROVIDER_KINDS = [
  'compute',
  'hosting',
  'registrar',
  'database',
  'cache',
  'object-storage',
  'transactional-email',
  'mailbox',
  'psp',
  'einvoice',
  'model',
] as const;

export interface ProviderDto {
  id: string;
  key: string;
  kind: string;
  adapterId: string;
  status: string;
  environmentPolicy: string;
  /** Is an adapter implementation registered for this provider in THIS process/profile? (Real vendors: false until S18-S22.) */
  adapterAvailable: boolean;
  accountCount: number;
  createdAt: string;
}

export class ProviderService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly adapters: AdapterRegistry,
  ) {}

  private dto(r: Row): ProviderDto {
    return {
      id: r.id as string,
      key: r.key as string,
      kind: r.kind as string,
      adapterId: r.adapter_id as string,
      status: r.status as string,
      environmentPolicy: r.environment_policy as string,
      adapterAvailable: this.adapters.has(r.adapter_id as string),
      accountCount: Number(r.account_count ?? 0),
      createdAt: iso(r.created_at)!,
    };
  }

  async list(): Promise<ProviderDto[]> {
    return this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT p.*, (SELECT count(*) FROM cloud.provider_accounts a WHERE a.provider_id = p.id) AS account_count FROM cloud.providers p ORDER BY p.key`,
        )
      ).rows.map((r) => this.dto(r)),
    );
  }

  async get(id: string): Promise<ProviderDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const r = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT p.*, (SELECT count(*) FROM cloud.provider_accounts a WHERE a.provider_id = p.id) AS account_count FROM cloud.providers p WHERE p.id = $1`,
            [id],
          )
        ).rows[0],
    );
    if (!r) throw new ProblemException('not_found');
    return this.dto(r);
  }

  async create(actorUserId: string, input: unknown): Promise<ProviderDto> {
    const b = body(input);
    const key = reqText(b.key, 'key', 2, 31);
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(key))
      throw new ProblemException(
        'validation_failed',
        'key must be lower-case letters, digits and dashes',
      );
    const kind = oneOf(b.kind, 'kind', PROVIDER_KINDS);
    const adapterId = reqText(b.adapterId, 'adapterId', 2, 41);
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(adapterId))
      throw new ProblemException(
        'validation_failed',
        'adapterId must be lower-case letters, digits and dashes',
      );
    const policy =
      b.environmentPolicy === undefined
        ? 'any'
        : oneOf(b.environmentPolicy, 'environmentPolicy', ['any', 'non_production_only'] as const);
    const id = uuidv7();
    try {
      await this.db.withPlatformScope(async (c) => {
        await c.query(
          `INSERT INTO cloud.providers (id, key, kind, adapter_id, environment_policy) VALUES ($1,$2,$3,$4,$5)`,
          [id, key, kind, adapterId, policy],
        );
        await this.audit.record({
          action: 'provider.registry.created',
          actorUserId,
          resource: { type: 'provider', id },
          outcome: 'success',
          after: { key, kind, adapterId, environmentPolicy: policy },
        });
      });
    } catch (e) {
      if (pgCode(e) === '23505')
        throw new ProblemException('conflict', 'a provider with this key already exists');
      throw e;
    }
    return this.get(id);
  }
}
