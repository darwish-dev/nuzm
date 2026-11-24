import { applyDecorators, Inject, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { v7 as newId } from 'uuid';
import { builderTools } from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';
import { DB } from '../../common/tokens';

const P = builderTools.lifecycle;

/**
 * O-9 (PROPOSED, not decided): may a `billing_admin` read the CONTENT of a project through the builder tools (review, symbols, import analysis, components, memory)?
 * The setting is `builder.billing_admin_content_access`, stored as the organization's own row in `platform.feature_flags` (RLS `flags_org_write`: only that organization writes
 * it) as `{ "mode": "allow" | "deny" }`. ABSENT = `allow` = today's behaviour; nothing here changes the default. Changing it needs `org:update` (owners and admins) and is audited
 * with before and after; every denial is audited too. Only the `billing_admin` role is ever affected.
 */
export class ContentAccessService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async mode(orgId: string): Promise<builderTools.lifecycle.ContentAccessMode> {
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT value FROM platform.feature_flags WHERE key = $1 AND org_id = $2`, [
            P.CONTENT_ACCESS_KEY,
            orgId,
          ])
        ).rows[0] as { value: unknown } | undefined,
    );
    return P.parseContentAccess(row?.value);
  }

  async get(orgId: string) {
    return { mode: await this.mode(orgId), default: P.CONTENT_ACCESS_DEFAULT };
  }

  async set(orgId: string, actor: string, body: Record<string, unknown>) {
    const unknown = Object.keys(body).filter((k) => k !== 'mode');
    if (unknown.length)
      throw new ProblemException('validation_failed', `unknown settings: ${unknown.join(', ')}`);
    if (body.mode !== 'allow' && body.mode !== 'deny')
      throw new ProblemException('validation_failed', 'mode must be "allow" or "deny"');
    const before = await this.mode(orgId);
    const value = JSON.stringify({ mode: body.mode });
    await this.db.withOrg(orgId, async (c) => {
      const upd = await c.query(
        `UPDATE platform.feature_flags SET value = $3::jsonb, updated_by = $4, updated_at = now() WHERE key = $1 AND org_id = $2`,
        [P.CONTENT_ACCESS_KEY, orgId, value, actor],
      );
      if (!upd.rowCount)
        await c.query(
          `INSERT INTO platform.feature_flags (id, key, org_id, value, updated_by) VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [newId(), P.CONTENT_ACCESS_KEY, orgId, value, actor],
        );
    });
    await this.audit.record({
      action: 'builder.policy.content_access_changed',
      actorUserId: actor,
      actorType: 'user',
      orgId,
      resource: { type: 'organization', id: orgId },
      outcome: 'success',
      detail: { key: P.CONTENT_ACCESS_KEY, before, after: body.mode },
    });
    return this.get(orgId);
  }

  /** Throws 403 when this role may not read project content under the organization's setting. Every denial is audited. */
  async assert(
    orgId: string,
    actor: string,
    role: string,
    operation: builderTools.lifecycle.ContentOperation,
    projectId: string,
  ): Promise<void> {
    // only the role the setting can affect costs a read
    if (role !== 'billing_admin') return;
    const d = P.decideContentAccess(role, await this.mode(orgId));
    if (d.allowed) return;
    await this.audit.record({
      action: 'builder.content.access_denied',
      actorUserId: actor,
      actorType: 'user',
      orgId,
      resource: projectId
        ? { type: 'project', id: projectId }
        : { type: 'organization', id: orgId },
      outcome: 'failure',
      detail: { operation, role, setting: P.CONTENT_ACCESS_KEY },
    });
    throw new ProblemException(
      'forbidden',
      'billing administrators cannot read project content in this organization',
    );
  }
}

// ---- ONE guard for every content-returning read (S07's O-9 audit, DEFECT-16) ----------------------------------------------------------------------------------------------------------
const CONTENT_READ_KEY = 'nuzm:content-read';
interface ContentReadMeta {
  op: builderTools.lifecycle.ContentOperation;
  /** the route parameter holding the project id (null when the route is not scoped by a project id) */
  project: 'projectId' | 'id' | null;
}

/**
 * `@ContentRead('file_content')` on a GET that returns customer SOURCE, FILES, run output or generated content. Under the organization's `builder.billing_admin_content_access =
 * deny` the `billing_admin` role gets 403 (audited); every other role, and the default `allow`, is untouched. Metadata routes (project lists, versions, file path lists) do NOT carry
 * it. The decision is `decideContentAccess` in the domain; this guard only reads the request's verified role and applies it.
 */
export const ContentRead = (
  op: builderTools.lifecycle.ContentOperation,
  project: ContentReadMeta['project'] = 'projectId',
) =>
  applyDecorators(
    SetMetadata(CONTENT_READ_KEY, { op, project } satisfies ContentReadMeta),
    UseGuards(ContentAccessGuard),
  );

@Injectable()
export class ContentAccessGuard implements CanActivate {
  private readonly svc: ContentAccessService;
  constructor(
    @Inject(DB) db: Db,
    @Inject(AuditSink) audit: AuditSink,
    private readonly reflector: Reflector,
  ) {
    this.svc = new ContentAccessService(db, audit);
  }
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.get<ContentReadMeta | undefined>(
      CONTENT_READ_KEY,
      ctx.getHandler(),
    );
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { params?: Record<string, string> }>();
    const a = req.access;
    if (!meta || !a) return true;
    const pid = meta.project ? (req.params?.[meta.project] ?? '') : '';
    await this.svc.assert(a.orgId, a.actor.userId, a.role, meta.op, pid);
    return true;
  }
}
