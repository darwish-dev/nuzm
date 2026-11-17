import {
  done,
  NOT_APPLICABLE,
  refused,
  type DsrHandler,
  type HandlerCtx,
  type HandlerResult,
} from './handlers';

type Row = Record<string, unknown>;
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : (d ?? null));
const member = (ctx: HandlerCtx) => (ctx.subject.kind === 'member' ? ctx.subject.userId : null);

/** Identity (M01): the account, sessions, factors and keys of a member; the member list for an organization export. The account row is shared by every organization. */
export const identityHandler: DsrHandler = {
  name: 'identity',
  datasets: ['identity.users', 'identity.sessions', 'identity.mfa_factors', 'identity.api_keys'],
  async export(ctx) {
    const uid = member(ctx);
    if (ctx.subject.kind === 'org') {
      const rows = await ctx.db.withOrg(
        ctx.orgId,
        async (c) =>
          (
            await c.query(
              `SELECT m.user_id, m.role, m.created_at, u.email, u.display_name FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at, m.user_id`,
              [ctx.orgId],
            )
          ).rows,
      );
      return done(
        { members: rows.length },
        {
          members: rows.map((r: Row) => ({
            userId: r.user_id,
            email: r.email,
            displayName: r.display_name,
            role: r.role,
            joinedAt: iso(r.created_at),
          })),
        },
      );
    }
    if (!uid) return NOT_APPLICABLE;
    const out = await ctx.db.withOrg(ctx.orgId, async (c) => {
      const user = (
        await c.query(
          `SELECT id, email, email_verified, display_name, locale, status, created_at, last_login_at FROM identity.users WHERE id = $1`,
          [uid],
        )
      ).rows[0];
      if (!user) return null;
      const membership =
        (
          await c.query(
            `SELECT role, created_at FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2`,
            [ctx.orgId, uid],
          )
        ).rows[0] ?? null;
      const sessions = (
        await c.query(
          `SELECT count(*)::int AS n, max(last_seen_at) AS last FROM identity.sessions WHERE user_id = $1 AND revoked_at IS NULL`,
          [uid],
        )
      ).rows[0];
      const factors = (
        await c.query(
          `SELECT type, status, created_at FROM identity.mfa_factors WHERE user_id = $1 ORDER BY created_at`,
          [uid],
        )
      ).rows;
      const keys = (
        await c.query(
          `SELECT name, prefix, created_at, revoked_at FROM identity.api_keys WHERE org_id = $1 AND created_by = $2 ORDER BY created_at`,
          [ctx.orgId, uid],
        )
      ).rows;
      return { user, membership, sessions, factors, keys };
    });
    if (!out) return NOT_APPLICABLE;
    // secrets are never exported: no hashes, no factor secrets, no key material
    return done(
      {
        activeSessions: out.sessions.n as number,
        mfaFactors: out.factors.length,
        apiKeys: out.keys.length,
      },
      {
        account: {
          id: out.user.id,
          email: out.user.email,
          emailVerified: out.user.email_verified,
          displayName: out.user.display_name,
          locale: out.user.locale,
          status: out.user.status,
          createdAt: iso(out.user.created_at),
          lastLoginAt: iso(out.user.last_login_at),
        },
        membership: out.membership
          ? { role: out.membership.role, since: iso(out.membership.created_at) }
          : null,
        sessions: { active: out.sessions.n, lastSeenAt: iso(out.sessions.last) },
        mfaFactors: out.factors.map((f: Row) => ({
          type: f.type,
          status: f.status,
          createdAt: iso(f.created_at),
        })),
        apiKeys: out.keys.map((k: Row) => ({
          name: k.name,
          prefix: k.prefix,
          createdAt: iso(k.created_at),
          revokedAt: iso(k.revoked_at),
        })),
      },
    );
  },
  async erase(ctx) {
    if (ctx.subject.kind === 'org')
      return refused('unsupported', { why: 'organization deletion is its own flow' });
    const uid = member(ctx);
    if (!uid) return NOT_APPLICABLE;
    const exists = await ctx.db.withOrg(
      ctx.orgId,
      async (c) => (await c.query(`SELECT 1 FROM identity.users WHERE id = $1`, [uid])).rowCount,
    );
    // the account row belongs to the person across every organization and is referenced by records that must stay: closing it is not an organization request
    return exists ? refused('account_is_global', { accountKept: true }) : NOT_APPLICABLE;
  },
  async rectify(ctx, patch) {
    const uid = member(ctx);
    if (!uid) return NOT_APPLICABLE;
    const keys = Object.keys(patch);
    if (keys.length === 0 || !keys.includes('displayName'))
      return keys.length === 0 ? NOT_APPLICABLE : NOT_APPLICABLE;
    const name = patch.displayName;
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 120)
      return refused('unsupported', { field: 'displayName', why: 'must be 1..120 characters' });
    const n = await ctx.db.withOrg(
      ctx.orgId,
      async (c) =>
        (
          await c.query(`UPDATE identity.users SET display_name = $2 WHERE id = $1`, [
            uid,
            name.trim(),
          ])
        ).rowCount,
    );
    return n ? done({ corrected: 'displayName' }) : NOT_APPLICABLE;
  },
};

/** Tenancy (M01): membership and the organization's own structure. Erasing a member removes the membership of THIS organization (never the last owner). */
export const tenancyHandler: DsrHandler = {
  name: 'tenancy',
  datasets: [
    'tenancy.memberships',
    'tenancy.invitations',
    'tenancy.organizations',
    'tenancy.workspaces',
    'tenancy.projects',
    'tenancy.environments',
  ],
  async export(ctx) {
    if (ctx.subject.kind === 'org') {
      const d = await ctx.db.withOrg(ctx.orgId, async (c) => ({
        org: (
          await c.query(
            `SELECT id, name, slug, type, country, default_locale, status, created_at FROM tenancy.organizations WHERE id = $1`,
            [ctx.orgId],
          )
        ).rows[0],
        workspaces: (
          await c.query(
            `SELECT id, name, slug, created_at FROM tenancy.workspaces WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
            [ctx.orgId],
          )
        ).rows,
        projects: (
          await c.query(
            `SELECT id, workspace_id, name, created_at FROM tenancy.projects WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
            [ctx.orgId],
          )
        ).rows,
        environments: (
          await c.query(
            `SELECT id, project_id, name, kind, data_region, created_at FROM tenancy.environments WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
            [ctx.orgId],
          )
        ).rows,
        invitations: (
          await c.query(
            `SELECT id, email, role, expires_at, accepted_at, revoked_at, created_at FROM tenancy.invitations WHERE org_id = $1 ORDER BY created_at`,
            [ctx.orgId],
          )
        ).rows,
      }));
      return done(
        {
          workspaces: d.workspaces.length,
          projects: d.projects.length,
          environments: d.environments.length,
          invitations: d.invitations.length,
        },
        d,
      );
    }
    const uid = member(ctx);
    if (!uid) return NOT_APPLICABLE;
    const m = await ctx.db.withOrg(
      ctx.orgId,
      async (c) =>
        (
          await c.query(
            `SELECT role, created_at FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2`,
            [ctx.orgId, uid],
          )
        ).rows[0],
    );
    return m
      ? done({ role: m.role as string }, { membership: { role: m.role, since: iso(m.created_at) } })
      : NOT_APPLICABLE;
  },
  async erase(ctx) {
    if (ctx.subject.kind === 'org')
      return refused('unsupported', { why: 'organization deletion is its own flow' });
    const uid = member(ctx);
    if (!uid) return NOT_APPLICABLE;
    return ctx.db.withOrg(ctx.orgId, async (c): Promise<HandlerResult> => {
      const m = (
        await c.query(`SELECT role FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2`, [
          ctx.orgId,
          uid,
        ])
      ).rows[0];
      if (!m) return NOT_APPLICABLE; // already removed: a rerun is a no-op
      if (
        m.role === 'owner' &&
        Number(
          (
            await c.query(
              `SELECT count(*) n FROM tenancy.memberships WHERE org_id = $1 AND role = 'owner'`,
              [ctx.orgId],
            )
          ).rows[0].n,
        ) <= 1
      )
        return refused('last_owner', { role: 'owner' });
      await c.query(`DELETE FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2`, [
        ctx.orgId,
        uid,
      ]);
      return done({ membershipRemoved: true });
    });
  },
  async rectify() {
    return NOT_APPLICABLE;
  },
};

/** Billing and invoicing (M02/M03): READ-ONLY. Invoices, credit notes, payments and the ledger are tax and accounting records: erasure is refused. */
export const billingHandler: DsrHandler = {
  name: 'billing',
  datasets: [
    'invoicing.invoices',
    'invoicing.credit_notes',
    'invoicing.tax_profiles',
    'billing.subscriptions',
    'payments.payment_intents',
    'payments.refunds',
  ],
  async export(ctx) {
    if (ctx.subject.kind !== 'org') return NOT_APPLICABLE; // billing data belongs to the organization, not to one member
    const d = await ctx.db.withOrg(ctx.orgId, async (c) => ({
      invoices: (
        await c.query(
          `SELECT number_text, status, currency, issued_at, due_at, subtotal_minor, tax_minor, total_minor, paid_minor, buyer FROM invoicing.invoices WHERE org_id = $1 ORDER BY issued_at, id`,
          [ctx.orgId],
        )
      ).rows,
      creditNotes: (
        await c.query(
          `SELECT number_text, status, currency, issued_at, total_minor, reason FROM invoicing.credit_notes WHERE org_id = $1 ORDER BY issued_at, id`,
          [ctx.orgId],
        )
      ).rows,
      subscriptions: (
        await c.query(
          `SELECT status, currency, quantity, period_start, period_end, cancel_at_period_end, created_at FROM billing.subscriptions WHERE org_id = $1 ORDER BY created_at, id`,
          [ctx.orgId],
        )
      ).rows,
      payments: (
        await c.query(
          `SELECT status, currency, amount_minor, captured_minor, refunded_minor, created_at FROM payments.payment_intents WHERE org_id = $1 ORDER BY created_at, id`,
          [ctx.orgId],
        )
      ).rows,
    }));
    return done(
      {
        invoices: d.invoices.length,
        creditNotes: d.creditNotes.length,
        subscriptions: d.subscriptions.length,
        payments: d.payments.length,
      },
      d,
    );
  },
  async erase(ctx) {
    return ctx.subject.kind === 'org' || ctx.subject.kind === 'member'
      ? refused('retention_mandatory', { basis: 'tax and accounting records (D-34, HG-03-04)' })
      : NOT_APPLICABLE;
  },
  async rectify() {
    return NOT_APPLICABLE; // a tax profile is corrected by the organization in its billing settings; invoices are corrected by credit notes
  },
};

/** Consents (M04): the history of what a subject agreed to. Append-only evidence: exported, never erased by a request while the relationship lasts. */
export const consentHandler: DsrHandler = {
  name: 'consent',
  datasets: ['compliance.consents'],
  async export(ctx) {
    const ref =
      ctx.subject.kind === 'member'
        ? `member:${ctx.subject.userId}`
        : ctx.subject.kind === 'org'
          ? 'org'
          : ctx.subject.ref;
    const rows = await ctx.db.withOrg(
      ctx.orgId,
      async (c) =>
        (
          await c.query(
            `SELECT purpose_id, state, text_version, locale, source, created_at FROM compliance.consents WHERE org_id = $1 AND subject_ref = $2 ORDER BY seq, created_at`,
            [ctx.orgId, ref],
          )
        ).rows,
    );
    return rows.length
      ? done(
          { consents: rows.length },
          {
            consents: rows.map((r: Row) => ({
              purposeId: r.purpose_id,
              state: r.state,
              textVersion: r.text_version,
              locale: r.locale,
              source: r.source,
              at: iso(r.created_at),
            })),
          },
        )
      : NOT_APPLICABLE;
  },
  async erase(ctx) {
    const ref =
      ctx.subject.kind === 'member'
        ? `member:${ctx.subject.userId}`
        : ctx.subject.kind === 'org'
          ? 'org'
          : ctx.subject.ref;
    const n = await ctx.db.withOrg(ctx.orgId, async (c) =>
      Number(
        (
          await c.query(
            `SELECT count(*) n FROM compliance.consents WHERE org_id = $1 AND subject_ref = $2`,
            [ctx.orgId, ref],
          )
        ).rows[0].n,
      ),
    );
    // consent history is evidence (docs/10 §5: life of the relationship plus a proposed 24 months)
    return n > 0
      ? refused('retention_mandatory', { basis: 'consent evidence (D-34)', records: n })
      : NOT_APPLICABLE;
  },
  async rectify() {
    return NOT_APPLICABLE;
  },
};

export const BUILTIN_HANDLERS: DsrHandler[] = [
  identityHandler,
  tenancyHandler,
  billingHandler,
  consentHandler,
];
