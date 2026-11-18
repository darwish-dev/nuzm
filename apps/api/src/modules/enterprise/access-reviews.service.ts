import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../common/pagination';
import { MemberService } from '../tenancy';
import { SessionService } from '../identity';

/**
 * Access reviews (M12 S55, FR-ENT-04). Scope today: the MEMBERS of one organization. API keys and admin roles are covered through the member (a revoked
 * member loses the keys they created); delegated access arrives with M11 and is NOT VERIFIED. A `revoke` decision removes the membership through the
 * tenancy module, revokes the user's API keys for the organization and their sessions; `keep` records the decision. The jsonb items mirror the
 * latest state; every decision is also an append-only audit event (`access_review.decision`).
 */
export interface ReviewItem {
  itemId: string;
  kind: 'member';
  userId: string;
  email: string;
  role: string;
  decision: 'keep' | 'revoke' | null;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}
export interface ReviewDto {
  id: string;
  orgId: string;
  scope: { orgId: string; kinds: string[] };
  reviewers: string[];
  dueAt: string;
  status: 'open' | 'closed';
  items: ReviewItem[];
  progress: { total: number; decided: number };
  createdAt: string;
  closedAt: string | null;
}
type Row = Record<string, unknown>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dto = (r: Row): ReviewDto => {
  const items = r.items as ReviewItem[];
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    scope: r.scope as ReviewDto['scope'],
    reviewers: r.reviewers as string[],
    dueAt: (r.due_at as Date).toISOString(),
    status: r.status as 'open' | 'closed',
    items,
    progress: { total: items.length, decided: items.filter((i) => i.decision).length },
    createdAt: (r.created_at as Date).toISOString(),
    closedAt: r.closed_at ? (r.closed_at as Date).toISOString() : null,
  };
};

export class AccessReviewService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly members: MemberService,
    private readonly sessions: SessionService,
  ) {}

  async create(
    by: string,
    key: string,
    body: Record<string, unknown>,
  ): Promise<{ created: boolean; review: ReviewDto }> {
    const errors: { field: string; message: string }[] = [];
    const scope = body.scope as { orgId?: unknown; kinds?: unknown } | undefined;
    const orgId =
      typeof scope?.orgId === 'string' && UUID_RE.test(scope.orgId)
        ? scope.orgId.toLowerCase()
        : (errors.push({ field: 'scope.orgId', message: 'must be an organization id' }), '');
    const kinds = scope?.kinds === undefined ? ['members'] : scope.kinds;
    if (!Array.isArray(kinds) || kinds.length !== 1 || kinds[0] !== 'members')
      errors.push({
        field: 'scope.kinds',
        message:
          'only ["members"] is supported: API keys and admin roles follow the member; delegated access arrives with M11',
      });
    const reviewers =
      Array.isArray(body.reviewers) &&
      body.reviewers.length >= 1 &&
      body.reviewers.length <= 20 &&
      body.reviewers.every((x) => typeof x === 'string' && UUID_RE.test(x))
        ? (body.reviewers as string[]).map((x) => x.toLowerCase())
        : (errors.push({ field: 'reviewers', message: '1 to 20 platform user ids' }), []);
    const dueAt =
      typeof body.dueAt === 'string' &&
      !Number.isNaN(Date.parse(body.dueAt)) &&
      Date.parse(body.dueAt) > Date.now()
        ? new Date(body.dueAt)
        : (errors.push({ field: 'dueAt', message: 'must be a future date-time' }), new Date());
    if (errors.length)
      throw new ProblemException('validation_failed', 'invalid access review', errors);

    return this.db.withPlatformScope(async (c) => {
      const prior = (
        await c.query<Row>(
          `SELECT * FROM audit.access_reviews WHERE created_by = $1 AND idempotency_key = $2`,
          [by, key],
        )
      ).rows[0];
      if (prior) return { created: false, review: dto(prior) };
      const staff = (
        await c.query<{ id: string }>(
          `SELECT id FROM identity.users WHERE id = ANY($1::uuid[]) AND is_platform_user AND status = 'active'`,
          [reviewers],
        )
      ).rows;
      if (staff.length !== new Set(reviewers).size)
        throw new ProblemException(
          'validation_failed',
          'every reviewer must be an active platform user',
          [{ field: 'reviewers', message: 'unknown or non-staff user' }],
        );
      const org = (
        await c.query(`SELECT 1 FROM tenancy.organizations WHERE id = $1 AND deleted_at IS NULL`, [
          orgId,
        ])
      ).rowCount;
      if (!org) throw new ProblemException('not_found', 'organization not found');
      const members = (
        await c.query<Row>(
          `SELECT m.id, m.user_id, m.role, u.email FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY u.email`,
          [orgId],
        )
      ).rows;
      const items: ReviewItem[] = members.map((m) => ({
        itemId: m.id as string,
        kind: 'member',
        userId: m.user_id as string,
        email: m.email as string,
        role: m.role as string,
        decision: null,
        reason: null,
        decidedBy: null,
        decidedAt: null,
      }));
      const id = uuidv7();
      const { rows } = await c.query<Row>(
        `INSERT INTO audit.access_reviews (id, org_id, scope, reviewers, due_at, items, created_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          id,
          orgId,
          JSON.stringify({ orgId, kinds: ['members'] }),
          reviewers,
          dueAt,
          JSON.stringify(items),
          by,
          key,
        ],
      );
      await this.audit.record({
        action: 'audit.access_review.created',
        orgId,
        actorUserId: by,
        resource: { type: 'access_review', id },
        outcome: 'success',
        after: { items: items.length, reviewers: reviewers.length, dueAt: dueAt.toISOString() },
      });
      return { created: true, review: dto(rows[0]!) };
    });
  }

  async list(q: {
    orgId?: string;
    status?: string;
    limit: number;
    cursor?: unknown;
  }): Promise<Page<ReviewDto>> {
    const cur = decodeCursor(q.cursor);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<Row>(
            `SELECT * FROM audit.access_reviews WHERE ($1::uuid IS NULL OR org_id = $1) AND ($2::text IS NULL OR status = $2)
           AND ($3::uuid IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
            [q.orgId ?? null, q.status ?? null, cur, q.limit + 1],
          )
        ).rows,
    );
    return pageOf(rows.map(dto), q.limit);
  }

  /**
   * Decide one item. Only an assigned reviewer (403); closed review (409); the same decision twice is a no-op (idempotent), a different one is 409.
   * `revoke` executes through the owning modules BEFORE the decision is recorded as final; the review closes itself when every item is decided.
   */
  async decide(reviewId: string, by: string, body: Record<string, unknown>): Promise<ReviewDto> {
    const itemId = typeof body.itemId === 'string' ? body.itemId : '';
    const decision = body.decision;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!UUID_RE.test(reviewId) || !UUID_RE.test(itemId))
      throw new ProblemException('validation_failed', 'itemId must be an item id', [
        { field: 'itemId', message: 'invalid' },
      ]);
    if (decision !== 'keep' && decision !== 'revoke')
      throw new ProblemException('validation_failed', 'decision must be keep or revoke', [
        { field: 'decision', message: 'keep | revoke' },
      ]);
    if (reason.length < 3 || reason.length > 500)
      throw new ProblemException('validation_failed', 'a reason is required', [
        { field: 'reason', message: '3 to 500 characters' },
      ]);

    const cur = await this.db.withPlatformScope(
      async (c) =>
        (await c.query<Row>(`SELECT * FROM audit.access_reviews WHERE id = $1`, [reviewId]))
          .rows[0],
    );
    if (!cur) throw new ProblemException('not_found');
    if (!(cur.reviewers as string[]).includes(by))
      throw new ProblemException('forbidden', 'you are not an assigned reviewer of this campaign');
    const item = (cur.items as ReviewItem[]).find((i) => i.itemId === itemId);
    if (!item) throw new ProblemException('not_found', 'item not found');
    if (item.decision === decision) return dto(cur); // idempotent replay
    if (cur.status === 'closed') throw new ProblemException('review_closed');
    if (item.decision)
      throw new ProblemException('conflict', `this item was already decided: ${item.decision}`);

    const orgId = cur.org_id as string;
    if (decision === 'revoke') {
      // owning modules do the work; a missing member (already gone) is fine
      await this.members
        .remove(orgId, { userId: by, role: 'owner' }, item.userId)
        .catch((e: { code?: string }) => {
          if (e.code !== 'not_found') throw e;
        });
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE identity.api_keys SET revoked_at = now() WHERE org_id = $1 AND created_by = $2 AND revoked_at IS NULL`,
          [orgId, item.userId],
        ),
      );
      await this.sessions.revokeAllForUser(item.userId);
    }
    const out = await this.db.withPlatformScope(async (c) => {
      const row = (
        await c.query<Row>(`SELECT * FROM audit.access_reviews WHERE id = $1 FOR UPDATE`, [
          reviewId,
        ])
      ).rows[0]!;
      const items = (row.items as ReviewItem[]).map((i) =>
        i.itemId === itemId
          ? { ...i, decision, reason, decidedBy: by, decidedAt: new Date().toISOString() }
          : i,
      );
      const done = items.every((i) => i.decision);
      const { rows } = await c.query<Row>(
        `UPDATE audit.access_reviews SET items = $2, status = $3, closed_at = $4, version = version + 1 WHERE id = $1 RETURNING *`,
        [reviewId, JSON.stringify(items), done ? 'closed' : 'open', done ? new Date() : null],
      );
      return rows[0]!;
    });
    await this.audit.record({
      action: 'audit.access_review.decision',
      orgId,
      actorUserId: by,
      resource: { type: 'access_review', id: reviewId },
      outcome: 'success',
      detail: { itemId, userId: item.userId, decision, reason },
      before: { role: item.role },
    });
    return dto(out);
  }

  /** Verification query for AC-M12-04: the members/keys/sessions that SHOULD be gone after a campaign. 0 rows = no residual access. */
  async residualAccess(
    reviewId: string,
  ): Promise<{ userId: string; memberships: number; apiKeys: number; sessions: number }[]> {
    const r = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<Row>(`SELECT org_id, items FROM audit.access_reviews WHERE id = $1`, [
            reviewId,
          ])
        ).rows[0],
    );
    if (!r) throw new ProblemException('not_found');
    const out: { userId: string; memberships: number; apiKeys: number; sessions: number }[] = [];
    for (const i of (r.items as ReviewItem[]).filter((x) => x.decision === 'revoke')) {
      const q = await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query<Row>(
              `SELECT (SELECT count(*) FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2)::int AS m,
                (SELECT count(*) FROM identity.api_keys WHERE org_id = $1 AND created_by = $2 AND revoked_at IS NULL)::int AS k,
                (SELECT count(*) FROM identity.sessions WHERE user_id = $2 AND revoked_at IS NULL AND absolute_expires_at > now())::int AS s`,
              [r.org_id, i.userId],
            )
          ).rows[0]!,
      );
      if (Number(q.m) + Number(q.k) + Number(q.s) > 0)
        out.push({
          userId: i.userId,
          memberships: Number(q.m),
          apiKeys: Number(q.k),
          sessions: Number(q.s),
        });
    }
    return out;
  }
}
