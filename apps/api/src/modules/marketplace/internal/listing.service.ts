import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { TaxService } from '../../invoicing';
import {
  LISTING_TYPES,
  artifactNamespace,
  badRequest,
  isUuid,
  iso,
  pgCode,
  type ListingType,
  type MarketplaceConfig,
  type Row,
} from './model';
import { ArtifactStore } from './ports';
import { parseSemver } from './semver';
import { scanArtifact } from './scan';
import type { PublisherService } from './publisher.service';

export interface VersionDto {
  id: string;
  version: string;
  moderationStatus: 'pending' | 'approved' | 'rejected' | 'suspended';
  changelog: string | null;
  contentHash: string;
  createdAt: string;
  /** Visible to the publisher only. */
  artifactRef?: string;
  scan?: { verdict: string; findings: unknown[]; rulesetVersion: string } | null;
}
export interface ListingDto {
  id: string;
  type: ListingType;
  title: { ar: string; en: string };
  description: { ar: string | null; en: string | null };
  status: 'draft' | 'published' | 'suspended' | 'archived';
  licence: 'single_org' | 'multi_seat';
  seats: number;
  price: { amount: string; currency: string };
  priceWithTax?: { taxMinor: string; totalMinor: string; rateBps: number; status: 'provisional' };
  versions: VersionDto[];
  mine: boolean;
  accrual?: { grossMinor: string; shareMinor: string; currency: string; purchases: number };
  etag: number;
  createdAt: string;
}

const money = (v: unknown, what: string): { minor: bigint; currency: string } => {
  const m = v as { amount?: unknown; currency?: unknown } | null;
  if (
    !m ||
    typeof m !== 'object' ||
    typeof m.amount !== 'string' ||
    !/^(0|[1-9]\d{0,14})$/.test(m.amount) ||
    typeof m.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(m.currency)
  )
    throw badRequest(`${what} must be {amount: integer string in minor units, currency: ISO 4217}`);
  return { minor: BigInt(m.amount), currency: m.currency };
};
const text = (v: unknown, what: string, max: number, optional = false): string | null => {
  if (v === undefined || v === null) {
    if (optional) return null;
    throw badRequest(`${what} is required`);
  }
  if (typeof v !== 'string' || v.trim().length < 1 || v.length > max)
    throw badRequest(`${what} must be 1..${max} characters`);
  return v.trim();
};

/** Listings and immutable versions. A submitted version is hashed and scanned at once and enters moderation as `pending`; nothing is purchasable before a person approves it. */
export class ListingService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly publishers: PublisherService,
    private readonly artifacts: ArtifactStore,
    private readonly tax: Pick<TaxService, 'estimate'> | null,
    private readonly cfg: MarketplaceConfig,
  ) {}

  private vdto(r: Row, mine: boolean, scan?: Row | null): VersionDto {
    return {
      id: r.id,
      version: r.version,
      moderationStatus: r.moderation_status,
      changelog: r.changelog ?? null,
      contentHash: r.content_hash,
      createdAt: iso(r.created_at)!,
      ...(mine
        ? {
            artifactRef: r.artifact_ref,
            scan: scan
              ? {
                  verdict: scan.scan_verdict,
                  findings: scan.scan_results?.findings ?? [],
                  rulesetVersion: scan.scan_results?.rulesetVersion ?? '',
                }
              : null,
          }
        : {}),
    };
  }
  private ldto(
    r: Row,
    versions: VersionDto[],
    mine: boolean,
    extra: Partial<ListingDto> = {},
  ): ListingDto {
    return {
      id: r.id,
      type: r.type,
      title: { ar: r.title_ar, en: r.title_en },
      description: { ar: r.description_ar ?? null, en: r.description_en ?? null },
      status: r.status,
      licence: r.licence,
      seats: r.seats,
      price: { amount: String(r.price_minor), currency: (r.currency as string).trim() },
      versions,
      mine,
      etag: r.version_lock,
      createdAt: iso(r.created_at)!,
      ...extra,
    };
  }

  /** POST /v1/marketplace/listings: the listing (status `draft`) and, when `artifactRef` is sent, its first version (`version`, default 1.0.0) which enters moderation. */
  async create(orgId: string, actor: string, body: Record<string, unknown>): Promise<ListingDto> {
    for (const k of Object.keys(body))
      if (
        ![
          'type',
          'title',
          'description',
          'price',
          'licence',
          'seats',
          'artifactRef',
          'sbomRef',
          'version',
          'changelog',
        ].includes(k)
      )
        throw badRequest(`unknown field ${k}`);
    const publisher = await this.publishers.requireVerified(orgId);
    if (!LISTING_TYPES.includes(body.type as ListingType))
      throw badRequest(`type must be one of ${LISTING_TYPES.join(', ')}`);
    const t = body.title as { ar?: unknown; en?: unknown } | undefined;
    const title = { ar: text(t?.ar, 'title.ar', 160)!, en: text(t?.en, 'title.en', 160)! };
    const d = (body.description ?? {}) as { ar?: unknown; en?: unknown };
    const price = money(body.price, 'price');
    if (!['single_org', 'multi_seat'].includes(body.licence as string))
      throw badRequest("licence must be 'single_org' or 'multi_seat'");
    const seats = body.seats === undefined ? 1 : body.seats;
    if (!Number.isInteger(seats) || (seats as number) < 1 || (seats as number) > 1000)
      throw badRequest('seats must be an integer 1..1000');
    if (body.licence === 'single_org' && seats !== 1)
      throw badRequest('a single_org licence has one seat');
    const id = uuidv7();
    const row = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `INSERT INTO marketplace.listings (id, org_id, publisher_id, type, title_ar, title_en, description_ar, description_en, status, licence, seats, price_minor, currency, data_region, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11,$12,$13,$14) RETURNING *`,
            [
              id,
              orgId,
              publisher.id,
              body.type,
              title.ar,
              title.en,
              text(d.ar, 'description.ar', 4000, true),
              text(d.en, 'description.en', 4000, true),
              body.licence,
              seats,
              price.minor.toString(),
              price.currency,
              this.cfg.artifactRegion,
              actor,
            ],
          )
        ).rows[0],
    )) as Row;
    await this.audit.record({
      action: 'listing.listing.created',
      actorUserId: actor,
      orgId,
      resource: { type: 'listing', id },
      outcome: 'success',
      after: { type: body.type, priceMinor: price.minor.toString(), currency: price.currency },
    });
    const versions: VersionDto[] = [];
    if (body.artifactRef !== undefined)
      versions.push(
        await this.createVersion(orgId, actor, id, {
          artifactRef: body.artifactRef,
          sbomRef: body.sbomRef,
          version: body.version ?? '1.0.0',
          changelog: body.changelog,
        }),
      );
    return this.ldto(row, versions, true);
  }

  /** POST …/{id}/versions */
  async createVersion(
    orgId: string,
    actor: string,
    listingId: string,
    body: Record<string, unknown>,
  ): Promise<VersionDto> {
    for (const k of Object.keys(body))
      if (!['version', 'artifactRef', 'sbomRef', 'changelog'].includes(k))
        throw badRequest(`unknown field ${k}`);
    if (!isUuid(listingId)) throw new ProblemException('not_found');
    const listing = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM marketplace.listings WHERE id = $1 AND org_id = $2`, [
            listingId,
            orgId,
          ])
        ).rows[0],
    )) as Row | undefined;
    if (!listing) throw new ProblemException('not_found'); // existence first: another organization's listing is 404
    await this.publishers.requireVerified(orgId);
    if (listing.status === 'archived' || listing.status === 'suspended')
      throw new ProblemException('invalid_state', `the listing is ${listing.status}`);
    const version = text(body.version, 'version', 60)!;
    if (!parseSemver(version)) throw badRequest('version must be a semantic version (x.y.z)');
    const ref = text(body.artifactRef, 'artifactRef', 500)!;
    if (!ref.startsWith(artifactNamespace(orgId)))
      throw badRequest(`artifactRef must be inside ${artifactNamespace(orgId)}`);
    const sbomRef = text(body.sbomRef, 'sbomRef', 500, true);
    if (sbomRef && !sbomRef.startsWith(artifactNamespace(orgId)))
      throw badRequest(`sbomRef must be inside ${artifactNamespace(orgId)}`);
    const content = await this.artifacts.read(ref);
    if (content.length === 0 || content.length > this.cfg.maxArtifactBytes)
      throw badRequest(`the artifact must be 1..${this.cfg.maxArtifactBytes} bytes`);
    const scan = scanArtifact({ type: listing.type, content, sbomPresent: sbomRef !== null });
    const vid = uuidv7();
    try {
      const row = (await this.db.withOrg(orgId, async (c) => {
        const v = (
          await c.query(
            `INSERT INTO marketplace.listing_versions (id, org_id, listing_id, version, artifact_ref, sbom_ref, content_hash, changelog, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [
              vid,
              orgId,
              listingId,
              version,
              ref,
              sbomRef,
              createHash('sha256').update(content).digest('hex'),
              text(body.changelog, 'changelog', 4000, true),
              actor,
            ],
          )
        ).rows[0] as Row;
        await c.query(
          `INSERT INTO marketplace.moderation_cases (id, org_id, listing_id, listing_version_id, scan_results, scan_verdict) VALUES ($1,$2,$3,$4,$5,$6)`,
          [uuidv7(), orgId, listingId, vid, JSON.stringify(scan), scan.verdict],
        );
        return v;
      })) as Row;
      await this.audit.record({
        action: 'listing.version.submitted',
        actorUserId: actor,
        orgId,
        resource: { type: 'listing_version', id: vid },
        outcome: 'success',
        after: { listingId, version, scan: scan.verdict, findings: scan.findings.length },
      });
      return this.vdto(row, true, { scan_verdict: scan.verdict, scan_results: scan });
    } catch (e) {
      if (pgCode(e) === '23505')
        throw new ProblemException('conflict', `version ${version} already exists`);
      throw e;
    }
  }

  /**
   * GET /v1/marketplace/listings. Default = BROWSE: published listings of every publisher with their APPROVED versions (artifact references and scan details are never shown).
   * `mine=true` = the publisher's own listings in every state with all versions, scan findings and the revenue ACCRUAL summary. `filter[id]` narrows to one (the detail view).
   */
  async list(
    orgId: string,
    q: { limit: number; cursor?: string; mine?: boolean; type?: string; q?: string; id?: string },
  ): Promise<Page<ListingDto>> {
    if (q.type !== undefined && !LISTING_TYPES.includes(q.type as ListingType))
      throw new ProblemException('invalid_filter', 'unknown type');
    if (q.id !== undefined && !isUuid(q.id))
      throw new ProblemException('invalid_filter', 'filter[id] must be a uuid');
    const before = decodeCursor(q.cursor);
    const search = q.q ? `%${q.q.replace(/[%_\\]/g, '\\$&').slice(0, 100)}%` : null;
    const out = await this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query(
          `SELECT * FROM marketplace.listings WHERE ($1::boolean AND org_id = $2 OR (NOT $1::boolean AND status = 'published'))
             AND ($3::uuid IS NULL OR id < $3) AND ($4::text IS NULL OR type = $4) AND ($5::text IS NULL OR title_en ILIKE $5 OR title_ar ILIKE $5) AND ($6::uuid IS NULL OR id = $6)
           ORDER BY id DESC LIMIT $7`,
          [q.mine === true, orgId, before, q.type ?? null, search, q.id ?? null, q.limit + 1],
        )
      ).rows as Row[];
      const shown = rows.slice(0, q.limit);
      const ids = shown.map((r) => r.id as string);
      const vers = ids.length
        ? ((
            await c.query(
              `SELECT * FROM marketplace.listing_versions WHERE listing_id = ANY($1::uuid[]) ORDER BY created_at DESC`,
              [ids],
            )
          ).rows as Row[])
        : [];
      const cases =
        q.mine && ids.length
          ? ((
              await c.query(
                `SELECT listing_version_id, scan_verdict, scan_results FROM marketplace.moderation_cases WHERE listing_id = ANY($1::uuid[])`,
                [ids],
              )
            ).rows as Row[])
          : [];
      const acc =
        q.mine && ids.length
          ? ((
              await c.query(
                `SELECT listing_id, currency, sum(CASE WHEN kind = 'accrual' THEN gross_minor ELSE -gross_minor END)::text g, sum(CASE WHEN kind = 'accrual' THEN share_minor ELSE -share_minor END)::text s, count(*) FILTER (WHERE kind = 'accrual')::int n FROM marketplace.publisher_accruals WHERE listing_id = ANY($1::uuid[]) GROUP BY listing_id, currency`,
                [ids],
              )
            ).rows as Row[])
          : [];
      return { rows, vers, cases, acc };
    });
    const p = pageOf(out.rows as (Row & { id: string })[], q.limit);
    const items: ListingDto[] = [];
    for (const r of p.items) {
      const mine = r.org_id === orgId;
      const vs = out.vers
        .filter((v) => v.listing_id === r.id && (mine || v.moderation_status === 'approved'))
        .map((v) =>
          this.vdto(
            v,
            mine,
            out.cases.find((x) => x.listing_version_id === v.id),
          ),
        );
      const a = out.acc.find((x) => x.listing_id === r.id);
      let withTax: ListingDto['priceWithTax'];
      if (q.id && this.tax) {
        const est = await this.tax
          .estimate(orgId, [BigInt(r.price_minor)], new Date())
          .catch(() => null);
        if (est)
          withTax = {
            taxMinor: est.taxMinor.toString(),
            totalMinor: (BigInt(r.price_minor) + est.taxMinor).toString(),
            rateBps: est.rateBps,
            status: 'provisional',
          };
      }
      items.push(
        this.ldto(r, vs, mine, {
          ...(withTax ? { priceWithTax: withTax } : {}),
          ...(mine
            ? {
                accrual: {
                  grossMinor: a?.g ?? '0',
                  shareMinor: a?.s ?? '0',
                  currency: a?.currency ?? (r.currency as string).trim(),
                  purchases: a?.n ?? 0,
                },
              }
            : {}),
        }),
      );
    }
    return { items, nextCursor: p.nextCursor };
  }
}
