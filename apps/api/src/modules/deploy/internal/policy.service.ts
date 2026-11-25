import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';

/**
 * Deployment policy switches (Phase 2, Session 06): owner decisions O-1 and O-2, implemented as per-organization settings whose DEFAULT EQUALS THE BEHAVIOUR BEFORE
 * THEY EXISTED. Nothing here changes what happens unless an owner/admin changes a setting; the PROPOSED stricter values become a default only by a recorded owner
 * decision (docs/parallel/sessions/PHASE2-06-approval-inputs.md).
 *
 *  O-1 `deploy.production_publish_roles`: which roles may CONFIRM a production publish of a website. Default `owner, admin, developer` (everyone with `deploy:write`). A role
 *      outside the list may still REQUEST the approval; someone in the list confirms it (a second person, or an owner/admin).
 *  O-2 `deploy.rollback_requires_own_approval`: when true, rolling back a PRODUCTION website deployment needs its own human approval (not the one of the release being left).
 *      Default false (a rollback reuses the earlier approval and needs no new one).
 *
 * Scope: the website publish path (`DeployService`). Web apps have their own approval policy in the app builder (M10 `production_deploy` / `production_rollback`).
 */
export const PUBLISH_ROLES = ['owner', 'admin', 'developer'] as const;
export type PublishRole = (typeof PUBLISH_ROLES)[number];

export interface DeployPolicy {
  productionPublishRoles: PublishRole[];
  rollbackRequiresOwnApproval: boolean;
  /** `default` = no row for this organization (the pre-existing behaviour) */
  source: 'default' | 'organization';
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const DEFAULT_DEPLOY_POLICY: Omit<DeployPolicy, 'updatedAt' | 'updatedBy'> = Object.freeze({
  productionPublishRoles: [...PUBLISH_ROLES],
  rollbackRequiresOwnApproval: false,
  source: 'default' as const,
  version: 0,
});

type Row = Record<string, unknown>;
const toPolicy = (r: Row | undefined): DeployPolicy =>
  r
    ? {
        productionPublishRoles: (r.production_publish_roles as PublishRole[])
          .slice()
          .sort((a, b) => PUBLISH_ROLES.indexOf(a) - PUBLISH_ROLES.indexOf(b)),
        rollbackRequiresOwnApproval: r.rollback_requires_own_approval === true,
        source: 'organization',
        version: Number(r.version),
        updatedAt: new Date(r.updated_at as string).toISOString(),
        updatedBy: (r.updated_by as string | null) ?? null,
      }
    : {
        ...DEFAULT_DEPLOY_POLICY,
        productionPublishRoles: [...PUBLISH_ROLES],
        updatedAt: null,
        updatedBy: null,
      };

export class DeployPolicyService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async get(orgId: string): Promise<DeployPolicy> {
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM deploy.org_policies WHERE org_id=$1`, [orgId])).rows[0],
    )) as Row | undefined;
    return toPolicy(r);
  }

  /** May `role` confirm a production publish under this policy? */
  canConfirmProductionPublish(policy: DeployPolicy, role: string | undefined): boolean {
    return role !== undefined && (policy.productionPublishRoles as string[]).includes(role);
  }

  /**
   * Change the policy. Only an owner or admin (the route also needs `org:security`); the body is validated strictly (unknown keys, empty or unknown role lists and
   * non-boolean values are refused with 422/400, never coerced). `expectedVersion` makes a concurrent edit a 409 instead of a silent overwrite. Audited with before/after.
   */
  async set(
    orgId: string,
    actor: { userId: string; role: string; kind: 'session' | 'api_key' },
    body: Record<string, unknown>,
  ): Promise<DeployPolicy> {
    if (actor.role !== 'owner' && actor.role !== 'admin')
      throw new ProblemException(
        'forbidden',
        'only an owner or admin may change the deployment policy',
      );
    if (actor.kind !== 'session')
      throw new ProblemException(
        'forbidden',
        'the deployment policy is changed by a signed-in person, not by an API key',
      );
    const known = new Set([
      'productionPublishRoles',
      'rollbackRequiresOwnApproval',
      'expectedVersion',
    ]);
    for (const k of Object.keys(body))
      if (!known.has(k)) throw new ProblemException('validation_failed', `unknown setting ${k}`);
    let roles: PublishRole[] | undefined;
    if (body.productionPublishRoles !== undefined) {
      const v = body.productionPublishRoles;
      if (
        !Array.isArray(v) ||
        v.length < 1 ||
        v.length > PUBLISH_ROLES.length ||
        new Set(v).size !== v.length ||
        !v.every((x) => (PUBLISH_ROLES as readonly unknown[]).includes(x))
      )
        throw new ProblemException(
          'validation_failed',
          'productionPublishRoles must be a non-empty list of distinct roles from owner, admin, developer',
        );
      roles = v as PublishRole[];
      // an organization must always keep someone who can confirm: owner stays in the list (an owner can never be locked out of publishing)
      if (!roles.includes('owner'))
        throw new ProblemException(
          'validation_failed',
          'the owner role must stay in productionPublishRoles',
        );
    }
    let rb: boolean | undefined;
    if (body.rollbackRequiresOwnApproval !== undefined) {
      if (typeof body.rollbackRequiresOwnApproval !== 'boolean')
        throw new ProblemException(
          'validation_failed',
          'rollbackRequiresOwnApproval must be true or false',
        );
      rb = body.rollbackRequiresOwnApproval;
    }
    if (roles === undefined && rb === undefined)
      throw new ProblemException(
        'validation_failed',
        'send productionPublishRoles and/or rollbackRequiresOwnApproval',
      );
    const expected = body.expectedVersion;
    if (expected !== undefined && (!Number.isInteger(expected) || (expected as number) < 0))
      throw new ProblemException(
        'validation_failed',
        'expectedVersion must be a non-negative integer',
      );

    const { before, after } = await this.db.withOrg(orgId, async (c) => {
      const cur = (
        await c.query(`SELECT * FROM deploy.org_policies WHERE org_id=$1 FOR UPDATE`, [orgId])
      ).rows[0] as Row | undefined;
      const curVersion = cur ? Number(cur.version) : 0;
      if (expected !== undefined && expected !== curVersion)
        throw new ProblemException(
          'conflict',
          `the policy changed (version ${curVersion}): reload and try again`,
        );
      const nextRoles = roles ?? toPolicy(cur).productionPublishRoles;
      const nextRb = rb ?? toPolicy(cur).rollbackRequiresOwnApproval;
      let row: Row | undefined;
      if (cur) {
        row = (
          await c.query(
            `UPDATE deploy.org_policies SET production_publish_roles=$2, rollback_requires_own_approval=$3, updated_by=$4, updated_at=now(), version=version+1 WHERE org_id=$1 RETURNING *`,
            [orgId, nextRoles, nextRb, actor.userId],
          )
        ).rows[0] as Row;
      } else {
        // FOR UPDATE on a missing row locks nothing: two first-ever writers can both get here. The loser must see a conflict (409), never a primary-key error (500).
        row = (
          await c.query(
            `INSERT INTO deploy.org_policies (org_id, production_publish_roles, rollback_requires_own_approval, updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id) DO NOTHING RETURNING *`,
            [orgId, nextRoles, nextRb, actor.userId],
          )
        ).rows[0] as Row | undefined;
        if (!row)
          throw new ProblemException(
            'conflict',
            'the policy was created concurrently: reload and try again',
          );
      }
      return { before: toPolicy(cur), after: toPolicy(row) };
    });
    await this.audit.record({
      action: 'deploy.policy.updated',
      actorUserId: actor.userId,
      actorType: 'user',
      orgId,
      resource: { type: 'deploy_policy', id: orgId },
      outcome: 'success',
      detail: {
        before: {
          productionPublishRoles: before.productionPublishRoles,
          rollbackRequiresOwnApproval: before.rollbackRequiresOwnApproval,
          source: before.source,
        },
        after: {
          productionPublishRoles: after.productionPublishRoles,
          rollbackRequiresOwnApproval: after.rollbackRequiresOwnApproval,
        },
        reason: 'owner decision O-1/O-2 switch',
      },
    });
    return after;
  }
}
