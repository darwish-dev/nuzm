import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { enqueue, type Db } from '@nuzm/platform';
import { Mailer } from '../../../common/mailer';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, parseLimit, type Page } from './pagination';
import { ORG_ROLES } from './member.service';

export interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  createdAt: string;
}

interface InvRow {
  id: string;
  email: string;
  role: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class InvitationService {
  constructor(
    private readonly db: Db,
    private readonly mailer: Mailer,
    private readonly ttlSeconds = 7 * 86400, // proposal: 7 days
  ) {}

  private status(r: InvRow): Invitation['status'] {
    return r.accepted_at
      ? 'accepted'
      : r.revoked_at
        ? 'revoked'
        : r.expires_at.getTime() < Date.now()
          ? 'expired'
          : 'pending';
  }
  private shape = (r: InvRow): Invitation => ({
    id: r.id,
    email: r.email,
    role: r.role,
    expiresAt: r.expires_at.toISOString(),
    status: this.status(r),
    createdAt: r.created_at.toISOString(),
  });

  async create(
    orgId: string,
    actor: { userId: string; role: string; email: string },
    input: { email: string; role: string },
    locale: 'ar' | 'en',
  ): Promise<Invitation> {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 320)
      throw new ProblemException('validation_failed', 'a valid email is required');
    if (!(ORG_ROLES as readonly string[]).includes(input.role))
      throw new ProblemException('validation_failed', 'unknown role');
    if (input.role === 'owner' && actor.role !== 'owner')
      throw new ProblemException('forbidden', 'only an owner can invite an owner');

    const token = `nzi_${randomBytes(32).toString('base64url')}`;
    const id = uuidv7();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const orgName = await this.db.withOrg(orgId, async (c) => {
      const member = await c.query(
        `SELECT 1 FROM tenancy.memberships m JOIN identity.users u ON u.id=m.user_id WHERE lower(u.email)=$1`,
        [email],
      );
      if (member.rowCount)
        throw new ProblemException('conflict', 'this person is already a member');
      try {
        await c.query(
          `INSERT INTO tenancy.invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, orgId, email, input.role, sha(token), actor.userId, expiresAt],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new ProblemException(
            'conflict',
            'an open invitation for this email already exists',
          );
        throw e;
      }
      await enqueue(c, orgId, 'member.invited', { invitationId: id, role: input.role }); // never the token or email
      return (
        await c.query<{ name: string }>('SELECT name FROM tenancy.organizations WHERE id=$1', [
          orgId,
        ])
      ).rows[0]!.name;
    });
    try {
      await this.mailer.send({
        to: email,
        template: 'invitation',
        locale,
        data: {
          orgName,
          role: input.role,
          inviterEmail: actor.email,
          token,
          expiresAt: expiresAt.toISOString(),
        },
      });
    } catch {
      // Delivery failed: do not leave an undeliverable (but valid) invitation behind.
      await this.db.withOrg(orgId, (c) =>
        c.query('DELETE FROM tenancy.invitations WHERE id=$1', [id]),
      );
      throw new ProblemException('service_unavailable', 'could not deliver the invitation email');
    }
    return this.get(orgId, id) as Promise<Invitation>;
  }

  async get(orgId: string, id: string): Promise<Invitation | null> {
    return this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(
          `SELECT id, email, role, expires_at, accepted_at, revoked_at, created_at FROM tenancy.invitations WHERE id=$1`,
          [id],
        )
      ).rows[0];
      return r ? this.shape(r) : null;
    });
  }

  async list(orgId: string, q: { limit?: unknown; cursor?: unknown }): Promise<Page<Invitation>> {
    const limit = parseLimit(q.limit);
    const cursor = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT id, email, role, expires_at, accepted_at, revoked_at, created_at FROM tenancy.invitations
          WHERE ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $1`,
            [limit + 1, cursor],
          )
        ).rows,
    );
    return pageOf(rows.map(this.shape), limit);
  }

  async revoke(orgId: string, id: string): Promise<void> {
    const n = await this.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `UPDATE tenancy.invitations SET revoked_at=now() WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [id],
      );
      if (r.rowCount) await enqueue(c, orgId, 'member.invitation_revoked', { invitationId: id });
      return r.rowCount;
    });
    if (!n) throw new ProblemException('not_found');
  }

  /**
   * Accept by token. The caller must be signed in with a VERIFIED email equal to the invited one, so a
   * leaked token alone is useless. Single use is enforced atomically; concurrent accepts: one wins.
   */
  async accept(
    user: { id: string; email: string; emailVerified: boolean },
    invitationId: string,
    token: string,
  ): Promise<{ orgId: string; role: string }> {
    if (typeof token !== 'string' || !token.startsWith('nzi_'))
      throw new ProblemException('validation_failed', 'token is required');
    const inv = await this.db.withAuthScope(
      'invitation_accept',
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id, email, role, expires_at, accepted_at, revoked_at FROM tenancy.invitations WHERE token_hash=$1 AND id=$2`,
            [sha(token), invitationId],
          )
        ).rows[0],
    );
    if (!inv) throw new ProblemException('not_found');
    if (inv.accepted_at || inv.revoked_at || inv.expires_at.getTime() < Date.now())
      throw new ProblemException('gone', 'this invitation is no longer valid');
    if (!user.emailVerified || user.email.toLowerCase() !== String(inv.email).toLowerCase())
      throw new ProblemException(
        'forbidden',
        'this invitation was issued to a different, verified email',
      );

    return this.db.withOrg(
      inv.org_id,
      async (c) => {
        const won = await c.query(
          `UPDATE tenancy.invitations SET accepted_at=now(), accepted_by=$2
            WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING role`,
          [inv.id, user.id],
        );
        if (!won.rowCount) throw new ProblemException('gone', 'this invitation is no longer valid');
        const ins = await c.query(
          `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id, user_id) DO NOTHING`,
          [uuidv7(), inv.org_id, user.id, inv.role],
        );
        if (!ins.rowCount)
          throw new ProblemException('conflict', 'already a member of this organization'); // rolls back the accept
        await enqueue(c, inv.org_id, 'member.accepted', { userId: user.id, role: inv.role });
        return { orgId: inv.org_id as string, role: inv.role as string };
      },
      { userId: user.id },
    );
  }
}
