import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf } from '../../../common/pagination';
import { formatDec, parseDec, parseTiers, type Rounding, type Tier } from '../../../common/rating';

export interface PriceItemDto {
  meterId: string;
  tierModel: 'flat' | 'graduated' | 'volume';
  unitPriceMinor: string | null;
  tiers: { upTo: string | null; unitPriceMinor: string }[] | null;
  includedAllowance: string;
  rounding: Rounding;
}
export interface PriceVersionDto {
  id: string;
  version: number;
  status: 'draft' | 'published';
  effectiveFrom: string;
  createdBy: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  note: string | null;
  items: PriceItemDto[];
}
type Row = Record<string, unknown>;

/** Validates the item list of a price book write; the meter ids must exist in the catalogue. */
export async function parseItems(c: PoolClient, raw: unknown): Promise<PriceItemDto[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 200)
    throw new ProblemException('validation_failed', 'items must be an array of 1..200 price items');
  const seen = new Set<string>();
  const items: PriceItemDto[] = raw.map((x, i): PriceItemDto => {
    const bad = (m: string) => new ProblemException('validation_failed', `items[${i}]: ${m}`);
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.meterId !== 'string') throw bad('meterId is required');
    if (seen.has(o.meterId)) throw bad(`duplicate meter ${o.meterId}`);
    seen.add(o.meterId);
    if (o.tierModel !== 'flat' && o.tierModel !== 'graduated' && o.tierModel !== 'volume')
      throw bad('tierModel must be flat, graduated or volume');
    const rounding = (o.rounding ?? 'half_up') as Rounding;
    if (!['half_up', 'up', 'down'].includes(rounding))
      throw bad('rounding must be half_up, up or down');
    const allowance = formatDec(
      parseDec((o.includedAllowance ?? '0') as string, 'includedAllowance'),
    );
    if (o.tierModel === 'flat') {
      if (o.tiers !== undefined && o.tiers !== null)
        throw bad('flat items take unitPriceMinor, not tiers');
      return {
        meterId: o.meterId,
        tierModel: 'flat' as const,
        unitPriceMinor: formatDec(parseDec(o.unitPriceMinor as string, 'unitPriceMinor')),
        tiers: null,
        includedAllowance: allowance,
        rounding,
      };
    }
    if (o.unitPriceMinor !== undefined && o.unitPriceMinor !== null)
      throw bad('tiered items take tiers, not unitPriceMinor');
    const tiers = parseTiers(o.tiers).map((t: Tier) => ({
      upTo: t.upTo === null ? null : formatDec(t.upTo),
      unitPriceMinor: formatDec(t.unitPrice),
    }));
    return {
      meterId: o.meterId,
      tierModel: o.tierModel,
      unitPriceMinor: null,
      tiers,
      includedAllowance: allowance,
      rounding,
    };
  });
  const known = (
    await c.query<{ id: string }>('SELECT id FROM metering.meters WHERE id = ANY($1::text[])', [
      items.map((i) => i.meterId),
    ])
  ).rows.map((r) => r.id);
  const unknown = items.filter((i) => !known.includes(i.meterId));
  if (unknown.length)
    throw new ProblemException('validation_failed', `unknown meter ${unknown[0]!.meterId}`);
  return items;
}

const itemDto = (r: Row): PriceItemDto => ({
  meterId: r.meter_id as string,
  tierModel: r.tier_model as PriceItemDto['tierModel'],
  unitPriceMinor:
    r.unit_price_minor === null ? null : formatDec(parseDec(String(r.unit_price_minor))),
  tiers: (r.tiers as PriceItemDto['tiers']) ?? null,
  includedAllowance: formatDec(parseDec(String(r.included_allowance))),
  rounding: r.rounding as Rounding,
});

/** Price books (platform reference data): admin CRUD with four-eyes publishing, and version resolution for the rater. */
export class PriceBookService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  private async hydrate(c: PoolClient, books: Row[]) {
    if (books.length === 0) return [];
    const versions = (
      await c.query(
        `SELECT * FROM billing.price_book_versions WHERE price_book_id = ANY($1::uuid[]) ORDER BY version`,
        [books.map((b) => b.id)],
      )
    ).rows;
    const items = (
      await c.query(
        `SELECT * FROM billing.price_items WHERE version_id = ANY($1::uuid[]) ORDER BY meter_id`,
        [versions.map((v) => v.id)],
      )
    ).rows;
    return books.map((b) => ({
      id: b.id as string,
      name: b.name as string,
      currency: (b.currency as string).trim(),
      status: b.status as string,
      placeholder: b.placeholder as boolean,
      versions: versions
        .filter((v) => v.price_book_id === b.id)
        .map<PriceVersionDto>((v) => ({
          id: v.id,
          version: v.version,
          status: v.status,
          effectiveFrom: (v.effective_from as Date).toISOString(),
          createdBy: v.created_by ?? null,
          publishedBy: v.published_by ?? null,
          publishedAt: v.published_at ? (v.published_at as Date).toISOString() : null,
          note: v.note ?? null,
          items: items.filter((i) => i.version_id === v.id).map(itemDto),
        })),
    }));
  }

  async list(o: { limit: number; cursor?: string | null }) {
    const cur = decodeCursor(o.cursor);
    return this.db.withPlatformScope(async (c) => {
      const books = (
        await c.query(
          `SELECT * FROM billing.price_books WHERE ($1::uuid IS NULL OR id < $1) ORDER BY id DESC LIMIT $2`,
          [cur, o.limit + 1],
        )
      ).rows;
      const items = (await this.hydrate(c, books.slice(0, o.limit))) as { id: string }[];
      return pageOf(items, o.limit);
    });
  }

  private effective(raw: unknown): Date {
    const d = typeof raw === 'string' ? new Date(raw) : null;
    if (!d || Number.isNaN(d.getTime()))
      throw new ProblemException(
        'validation_failed',
        'effectiveFrom must be an ISO-8601 timestamp',
      );
    return d;
  }

  async createBook(
    input: {
      name?: unknown;
      currency?: unknown;
      effectiveFrom?: unknown;
      items?: unknown;
      note?: unknown;
    },
    actor: string,
  ) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 120)
      throw new ProblemException('validation_failed', 'name must be 1..120 characters');
    const currency = input.currency === undefined ? 'SAR' : input.currency;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
      throw new ProblemException('validation_failed', 'currency must be an ISO 4217 code');
    const from = this.effective(input.effectiveFrom);
    const bookId = uuidv7();
    try {
      return await this.db.withPlatformScope(async (c) => {
        const items = await parseItems(c, input.items);
        await c.query(
          `INSERT INTO billing.price_books (id, name, currency, created_by) VALUES ($1,$2,$3,$4)`,
          [bookId, name, currency, actor],
        );
        await this.insertVersion(
          c,
          bookId,
          1,
          from,
          items,
          typeof input.note === 'string' ? input.note : null,
          actor,
        );
        await this.audit.record({
          action: 'billing.price_book.created',
          actorUserId: actor,
          resource: { type: 'price_book', id: bookId },
          outcome: 'success',
          after: { name, currency },
        });
        return (
          await this.hydrate(
            c,
            (await c.query('SELECT * FROM billing.price_books WHERE id = $1', [bookId])).rows,
          )
        )[0]!;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException(
          'conflict',
          'a price book with this name and currency already exists',
        );
      throw e;
    }
  }

  private async insertVersion(
    c: PoolClient,
    bookId: string,
    version: number,
    from: Date,
    items: PriceItemDto[],
    note: string | null,
    actor: string,
  ) {
    const vid = uuidv7();
    await c.query(
      `INSERT INTO billing.price_book_versions (id, price_book_id, version, status, effective_from, note, created_by) VALUES ($1,$2,$3,'draft',$4,$5,$6)`,
      [vid, bookId, version, from, note, actor],
    );
    for (const i of items)
      await c.query(
        `INSERT INTO billing.price_items (id, version_id, meter_id, tier_model, unit_price_minor, tiers, included_allowance, rounding) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          uuidv7(),
          vid,
          i.meterId,
          i.tierModel,
          i.unitPriceMinor,
          i.tiers ? JSON.stringify(i.tiers) : null,
          i.includedAllowance,
          i.rounding,
        ],
      );
    return vid;
  }

  /** New DRAFT version of an existing book (finance). One draft at a time per book. */
  async createVersion(
    bookId: string,
    input: { effectiveFrom?: unknown; items?: unknown; note?: unknown },
    actor: string,
  ) {
    const from = this.effective(input.effectiveFrom);
    return this.db.withPlatformScope(async (c) => {
      const book = (
        await c.query('SELECT id FROM billing.price_books WHERE id = $1 FOR UPDATE', [bookId])
      ).rows[0];
      if (!book) throw new ProblemException('not_found');
      const items = await parseItems(c, input.items);
      if (
        (
          await c.query(
            `SELECT 1 FROM billing.price_book_versions WHERE price_book_id = $1 AND status = 'draft'`,
            [bookId],
          )
        ).rowCount
      )
        throw new ProblemException(
          'conflict',
          'a draft version already exists for this price book',
        );
      const next =
        ((
          await c.query(
            'SELECT max(version) v FROM billing.price_book_versions WHERE price_book_id = $1',
            [bookId],
          )
        ).rows[0]!.v as number) + 1;
      await this.insertVersion(
        c,
        bookId,
        next,
        from,
        items,
        typeof input.note === 'string' ? input.note : null,
        actor,
      );
      await this.audit.record({
        action: 'billing.price_book_version.created',
        actorUserId: actor,
        resource: { type: 'price_book', id: bookId },
        outcome: 'success',
        after: { version: next },
      });
      return (
        await this.hydrate(
          c,
          (await c.query('SELECT * FROM billing.price_books WHERE id = $1', [bookId])).rows,
        )
      )[0]!;
    });
  }

  /**
   * Publish a draft (second person). Four-eyes: the publisher must differ from the version's creator. The effective date
   * must be strictly later than every published version's, so published ranges never overlap and history is never rewritten.
   */
  async publish(bookId: string, versionId: string, actor: string) {
    return this.db.withPlatformScope(async (c) => {
      const book = (
        await c.query('SELECT id FROM billing.price_books WHERE id = $1 FOR UPDATE', [bookId])
      ).rows[0];
      if (!book) throw new ProblemException('not_found');
      const v = (
        await c.query(
          'SELECT * FROM billing.price_book_versions WHERE id = $1 AND price_book_id = $2',
          [versionId, bookId],
        )
      ).rows[0];
      if (!v) throw new ProblemException('not_found');
      if (v.status !== 'draft')
        throw new ProblemException('conflict', 'this version is already published');
      if (v.created_by === actor)
        throw new ProblemException(
          'forbidden',
          'a second person must publish a price book version (four-eyes)',
        );
      const latest = (
        await c.query(
          `SELECT max(effective_from) f FROM billing.price_book_versions WHERE price_book_id = $1 AND status = 'published'`,
          [bookId],
        )
      ).rows[0]!.f as Date | null;
      if (latest && (v.effective_from as Date).getTime() <= latest.getTime())
        throw new ProblemException(
          'conflict',
          'effective dates overlap an existing published version',
        );
      await c.query(
        `UPDATE billing.price_book_versions SET status = 'published', published_by = $2, published_at = now() WHERE id = $1`,
        [versionId, actor],
      );
      await this.audit.record({
        action: 'billing.price_book_version.published',
        actorUserId: actor,
        resource: { type: 'price_book', id: bookId },
        outcome: 'success',
        after: { version: v.version },
        detail: { createdBy: v.created_by },
      });
      return (
        await this.hydrate(
          c,
          (await c.query('SELECT * FROM billing.price_books WHERE id = $1', [bookId])).rows,
        )
      )[0]!;
    });
  }

  /**
   * The book used for rating in `currency`: the newest active NON-placeholder book that has a published version, else the
   * DRAFT-NOT-APPROVED seed book — which is refused in a production profile (HG-02-01 is not signed).
   */
  async resolveForRating(c: PoolClient, currency: string, opts: { production: boolean }) {
    const books = (
      await c.query(
        `SELECT * FROM billing.price_books b WHERE status='active' AND currency = $1
        AND EXISTS (SELECT 1 FROM billing.price_book_versions v WHERE v.price_book_id = b.id AND v.status='published')
      ORDER BY placeholder ASC, created_at DESC, id DESC LIMIT 1`,
        [currency],
      )
    ).rows;
    const book = (await this.hydrate(c, books))[0];
    if (!book)
      throw new ProblemException(
        'service_unavailable',
        `no price book is available for ${currency}`,
      );
    if (book.placeholder && opts.production)
      throw new ProblemException(
        'service_unavailable',
        'the only price book is a DRAFT-NOT-APPROVED placeholder (HG-02-01)',
      );
    return {
      ...book,
      versions: book.versions
        .filter((v) => v.status === 'published')
        .sort((a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom)),
    };
  }
}
