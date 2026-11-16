import { ProblemException } from '../../../common/errors';
import { AuditSink } from '../../../common/audit';
import type { PlatformContext } from '../../../common/access';
import type { SessionService } from '../../identity';
import type { NotificationService } from '../../notifications';
import type { AdminReadService } from './admin-read.service';

export interface ImpersonationInput {
  reason: unknown;
  ttlMinutes: unknown;
  approvalRef?: unknown;
  notifyOrgOwners?: unknown;
}

/**
 * Support impersonation (M01 §18): a time-boxed (<= 30 min) web-realm session for the TARGET user that records
 * who started it and why. Rules: reason >= 10 chars; platform users cannot be impersonated; a caller without the
 * `platform_admin` role must cite an approval reference; only `platform_admin` may suppress the owner notice.
 * Every start is audited in the platform chain AND in each of the target's organizations' chains.
 */
export class ImpersonationService {
  constructor(
    private readonly sessions: SessionService,
    private readonly read: AdminReadService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditSink,
  ) {}

  async start(
    admin: PlatformContext,
    targetId: string,
    raw: ImpersonationInput,
    meta: { ip?: string; userAgent?: string; traceId?: string },
  ) {
    const bad = (m: string) => new ProblemException('validation_failed', m);
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (reason.length < 10 || reason.length > 500) throw bad('reason must be 10..500 characters');
    const ttl = raw.ttlMinutes;
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > 30)
      throw bad('ttlMinutes must be an integer from 1 to 30');
    const isAdmin = admin.roles.includes('platform_admin');
    const ref = typeof raw.approvalRef === 'string' ? raw.approvalRef.trim() : '';
    if (!isAdmin && (ref.length < 3 || ref.length > 200))
      throw bad('approvalRef (the approved support ticket/consent reference) is required');
    if (raw.notifyOrgOwners !== undefined && typeof raw.notifyOrgOwners !== 'boolean')
      throw bad('notifyOrgOwners must be a boolean');
    const notifyOwners = raw.notifyOrgOwners ?? true;
    if (!notifyOwners && !isAdmin)
      throw new ProblemException('forbidden', 'only platform_admin may skip the owner notice');

    const target = await this.read.userWithOrgs(targetId);
    if (!target || target.status !== 'active') throw new ProblemException('not_found');
    if (target.id === admin.userId)
      throw new ProblemException('forbidden', 'cannot impersonate yourself');
    if (target.is_platform_user)
      throw new ProblemException('forbidden', 'platform users cannot be impersonated');

    const s = await this.sessions.create(target.id, 'web', meta, {
      byUserId: admin.userId,
      reason,
      ref: ref || undefined,
      ttlSeconds: ttl * 60,
    });
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();

    const detail = {
      reason,
      approvalRef: ref || null,
      ttlMinutes: ttl,
      notifiedOwners: notifyOwners,
      targetUserId: target.id,
    };
    const base = {
      action: 'admin.impersonation.started' as const,
      actorUserId: admin.userId,
      actorType: 'user' as const,
      resource: { type: 'user', id: target.id },
      outcome: 'success' as const,
      traceId: meta.traceId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail,
    };
    await this.audit.record(base); // platform chain
    for (const o of target.orgs) {
      await this.audit.record({ ...base, orgId: o.id });
      if (notifyOwners)
        for (const owner of await this.read.owners(o.id))
          await this.notifications.notify({
            orgId: o.id,
            userId: owner,
            kind: 'security.impersonation_started',
            params: { ttlMinutes: ttl, targetUserId: target.id },
          });
    }
    return {
      session: s,
      expiresAt,
      target: { id: target.id, email: target.email, organizations: target.orgs },
    };
  }
}
