import type { Db } from '@nuzm/platform';
import type { FieldCipher } from '../../../common/field-crypto';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, parseLimit } from '../../../common/pagination';
import { UUID, badRequest, type Row } from './common';
import { maskContact, openContact } from './contacts';

/** Admin console reads (UI-M07-10 orders queue, UI-M07-12 support lookup). Metadata only: contacts are ALWAYS masked here (no break-glass in this milestone). */
export class DomainAdminReadService {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher,
  ) {}

  async list(q: {
    state?: unknown;
    needsReconcile?: unknown;
    q?: unknown;
    limit?: unknown;
    cursor?: unknown;
  }) {
    const limit = parseLimit(q.limit);
    if (q.state !== undefined && typeof q.state !== 'string')
      throw badRequest('state must be a string');
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT d.id, d.org_id, d.name, d.tld, d.state, d.expires_at, d.created_at, r.provider_code, a.label AS account_label, a.evidence_kind,
                    (SELECT o.state FROM domains.domain_orders o WHERE o.domain_id = d.id ORDER BY o.created_at DESC LIMIT 1) AS last_order_state,
                    (SELECT o.id FROM domains.domain_orders o WHERE o.domain_id = d.id ORDER BY o.created_at DESC LIMIT 1) AS last_order_id,
                    (SELECT o.type FROM domains.domain_orders o WHERE o.domain_id = d.id ORDER BY o.created_at DESC LIMIT 1) AS last_order_type
               FROM domains.domains d JOIN domains.registrar_accounts a ON a.id = d.registrar_account_id JOIN domains.registrars r ON r.id = a.registrar_id
              WHERE ($1::text IS NULL OR d.state = $1) AND ($2::text IS NULL OR d.name LIKE $2) AND ($3::uuid IS NULL OR d.id < $3)
                AND ($4::boolean IS NOT TRUE OR EXISTS (SELECT 1 FROM domains.domain_orders o WHERE o.domain_id = d.id AND o.state IN ('needs_reconcile','provider_pending')))
              ORDER BY d.id DESC LIMIT $5`,
            [
              q.state ?? null,
              typeof q.q === 'string' && q.q
                ? `%${q.q.toLowerCase().replace(/[%_\\]/g, '')}%`
                : null,
              decodeCursor(q.cursor),
              q.needsReconcile === 'true' || q.needsReconcile === true,
              limit + 1,
            ],
          )
        ).rows as Row[],
    );
    const page = pageOf(rows as (Row & { id: string })[], limit);
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        id: r.id as string,
        orgId: r.org_id as string,
        name: r.name as string,
        tld: r.tld as string,
        state: r.state as string,
        expiresAt: r.expires_at ? (r.expires_at as Date).toISOString() : null,
        registrar: r.provider_code as string,
        account: r.account_label as string,
        verification: r.evidence_kind === 'live' ? 'LIVE-VERIFIED' : 'NOT VERIFIED',
        lastOrder: r.last_order_id
          ? {
              id: r.last_order_id as string,
              type: r.last_order_type as string,
              state: r.last_order_state as string,
            }
          : null,
      })),
    };
  }

  async get(id: string) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const d = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT d.*, r.provider_code FROM domains.domains d JOIN domains.registrar_accounts a ON a.id = d.registrar_account_id JOIN domains.registrars r ON r.id = a.registrar_id WHERE d.id = $1`,
            [id],
          )
        ).rows[0] as Row | undefined,
    );
    if (!d) throw new ProblemException('not_found');
    const orders = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, type, state, years, price_minor, currency, authorization_state, failure_code, attempts, created_at, completed_at FROM domains.domain_orders WHERE domain_id = $1 ORDER BY created_at DESC`,
            [id],
          )
        ).rows as Row[],
    );
    const contacts = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, role, payload_enc FROM domains.domain_contacts WHERE domain_id = $1 ORDER BY role`,
            [id],
          )
        ).rows as Row[],
    );
    const masked: Record<string, unknown> = {};
    for (const c of contacts)
      masked[c.role as string] = maskContact(
        await openContact(this.cipher, c.id as string, c.payload_enc as string),
      );
    return {
      id: d.id as string,
      orgId: d.org_id as string,
      name: d.name as string,
      state: d.state as string,
      registrar: d.provider_code as string,
      expiresAt: d.expires_at ? (d.expires_at as Date).toISOString() : null,
      locked: d.locked as boolean,
      nameservers: d.nameservers as string[],
      dataRegion: d.data_region as string,
      providerRegionId: (d.provider_region_id as string | null) ?? null,
      contacts: masked,
      contactsMasked: true,
      orders: orders.map((o) => ({
        id: o.id as string,
        type: o.type as string,
        state: o.state as string,
        years: o.years as number,
        priceMinor: String(o.price_minor),
        currency: (o.currency as string).trim(),
        authorization: o.authorization_state as string,
        failureCode: (o.failure_code as string | null) ?? null,
        attempts: o.attempts as number,
        createdAt: (o.created_at as Date).toISOString(),
      })),
    };
  }
}
