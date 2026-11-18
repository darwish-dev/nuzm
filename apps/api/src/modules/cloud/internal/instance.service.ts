import { v7 as uuidv7 } from 'uuid';
import { idempotencyToken } from '@nuzm/adapter-contracts';
import { enqueue, type Db, type OperationsService } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException, type ErrorCode } from '../../../common/errors';
import { decodeCursor, pageOf, parseLimit } from '../../../common/pagination';
import type { SpendService } from '../../billing';
import type { OrderService } from '../../commerce';
import type { AdapterRegistry } from './adapter-registry';
import { UUID, body, iso, pgCode, type Row } from './common';
import type { CloudFlags } from './flags';
import type { OfferService } from './offer.service';
import {
  OP_ACTION,
  OP_CREATE,
  OP_DELETE,
  type ActionInput,
  type CreateInput,
  type PlanShape,
  type ProvisioningService,
} from './provisioning.service';
import type { ComputeQuotaGuard } from './quota-guard';
import type { ReconcilerService } from './reconciler.service';
import { transitionResource } from './resource-store';

export interface InstanceDto {
  id: string;
  name: string;
  status: string;
  dataRegion: string;
  country: string;
  plan: { vcpu: number; memoryMb: number; diskGb: number; bandwidth?: string };
  publicIps: string[];
  createdAt: string;
  capabilities: string[];
  operationId: string | null;
  projectId: string | null;
  environmentId: string | null;
  tags: Record<string, string>;
  deletionProtected: boolean;
  driftState: string;
  version: number;
}

const SSH_KEY =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]{20,4000}( [^\r\n]{0,200})?$/;
const ACTIONS = ['start', 'stop', 'reboot', 'resize', 'snapshot'] as const;
const SELECT = `SELECT i.*, r.drift_state, r.state AS resource_state, r.provider_account_id, r.provider_ref, r.provider_region_id FROM compute.instances i JOIN cloud.resources r ON r.id = i.resource_id`;

const toDto = (r: Row): InstanceDto => {
  const plan = r.plan as { vcpu: number; memoryMb: number; diskGb: number; bandwidth?: string };
  return {
    id: r.id as string,
    name: r.name as string,
    status: r.status as string,
    dataRegion: r.data_region as string,
    country: (r.country as string).trim(),
    plan: {
      vcpu: plan.vcpu,
      memoryMb: plan.memoryMb,
      diskGb: plan.diskGb,
      ...(plan.bandwidth ? { bandwidth: plan.bandwidth } : {}),
    }, // planRef/provider details stay internal
    publicIps: (r.public_ips as string[]) ?? [],
    createdAt: iso(r.created_at)!,
    capabilities: (r.capabilities as string[]) ?? [],
    operationId: (r.operation_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    environmentId: (r.environment_id as string | null) ?? null,
    tags: (r.tags as Record<string, string>) ?? {},
    deletionProtected: r.deletion_protected as boolean,
    driftState: r.drift_state as string,
    version: r.version as number,
  };
};

function parseCreate(input: unknown) {
  const b = body(input);
  const bad = (m: string) => new ProblemException('validation_failed', m);
  if (typeof b.quoteId !== 'string' || !UUID.test(b.quoteId)) throw bad('quoteId must be a UUID');
  if (typeof b.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(b.name))
    throw bad('name must be 1..100 characters: letters, digits, space, dot, dash, underscore');
  const keys = b.sshPublicKeys ?? [];
  if (
    !Array.isArray(keys) ||
    keys.length > 10 ||
    keys.some((k) => typeof k !== 'string' || !SSH_KEY.test(k))
  )
    throw bad('sshPublicKeys must be up to 10 OpenSSH public keys');
  const tags = b.tags ?? {};
  if (!tags || typeof tags !== 'object' || Array.isArray(tags) || Object.keys(tags).length > 20)
    throw bad('tags must be an object with at most 20 entries');
  for (const [k, v] of Object.entries(tags as Record<string, unknown>))
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(k) ||
      k.toLowerCase().startsWith('nuzm') ||
      typeof v !== 'string' ||
      v.length > 128
    )
      throw bad(`tag "${k}" is invalid (reserved prefix or bad value)`);
  for (const k of ['projectId', 'environmentId'] as const)
    if (
      b[k] !== undefined &&
      b[k] !== null &&
      (typeof b[k] !== 'string' || !UUID.test(b[k] as string))
    )
      throw bad(`${k} must be a UUID`);
  return {
    quoteId: b.quoteId.toLowerCase(),
    name: b.name,
    sshPublicKeys: keys as string[],
    tags: tags as Record<string, string>,
    projectId: (b.projectId as string | null | undefined) ?? null,
    environmentId: (b.environmentId as string | null | undefined) ?? null,
  };
}

/**
 * Compute instances (customer API logic, M05 task 12). Creating consumes the quote (an M02 order: validity, quota group, spend limit / approval),
 * records a cost-authorization HOLD for the first period, re-checks eligibility/residency/price at execution (TOCTOU, in the provisioning step),
 * and starts the durable operation. Other organizations' ids answer 404 (RLS).
 */
export class InstanceService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly adapters: AdapterRegistry,
    private readonly offers: Pick<OfferService, 'candidates'>,
    private readonly orders: Pick<OrderService, 'createFromQuote'>,
    private readonly spend: Pick<SpendService, 'list'>,
    private readonly quotaGuard: ComputeQuotaGuard,
    private readonly prov: ProvisioningService,
    private readonly reconciler: Pick<ReconcilerService, 'reconcileResource'>,
    private readonly flags: CloudFlags,
  ) {}

  private async requireFlag(orgId: string) {
    if (!(await this.flags.enabled(orgId)))
      throw new ProblemException('not_found', 'compute is not enabled for this organization');
  }
  private now(): Date {
    return new Date(this.adapters.clock.now());
  }

  async list(orgId: string, q: { status?: string; cursor?: string; limit?: string }) {
    await this.requireFlag(orgId);
    const limit = parseLimit(q.limit);
    const after = decodeCursor(q.cursor);
    if (
      q.status !== undefined &&
      !['provisioning', 'running', 'stopped', 'failed', 'deleting', 'deleted', 'unknown'].includes(
        q.status,
      )
    )
      throw new ProblemException('invalid_filter', 'status is invalid');
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `${SELECT} WHERE i.org_id = $1 AND ($2::text IS NULL OR i.status = $2) AND ($3::uuid IS NULL OR i.id < $3::uuid) ORDER BY i.id DESC LIMIT $4`,
            [orgId, q.status ?? null, after, limit + 1],
          )
        ).rows as Row[],
    );
    return pageOf(rows.map(toDto), limit);
  }

  async getRow(orgId: string, id: string): Promise<Row> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`${SELECT} WHERE i.id = $1 AND i.org_id = $2`, [id.toLowerCase(), orgId]))
          .rows[0] as Row | undefined,
    );
    if (!r) throw new ProblemException('not_found'); // another organization's id is indistinguishable from a missing one
    return r;
  }
  async get(orgId: string, id: string): Promise<InstanceDto> {
    await this.requireFlag(orgId);
    return toDto(await this.getRow(orgId, id));
  }

  // ---- create ---------------------------------------------------------------------------------------------------------------
  async create(
    orgId: string,
    actorUserId: string,
    input: unknown,
    traceId: string,
    idempotencyKey?: string,
  ): Promise<{ instance: InstanceDto; operationId: string }> {
    await this.requireFlag(orgId);
    const req = parseCreate(input);
    const now = new Date(); // quotes are issued and expire against the WALL clock (the module clock only moves provider-side observations in tests)
    const quote = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM commerce.quotes WHERE id = $1 AND org_id = $2 AND kind = 'compute'`,
            [req.quoteId, orgId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!quote) throw new ProblemException('not_found', 'compute quote not found');
    if ((quote.expires_at as Date).getTime() <= now.getTime())
      throw new ProblemException('quote_expired', 'this quote has expired; request a new one');
    const used = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT 1 FROM commerce.orders WHERE org_id = $1 AND quote_id = $2 UNION ALL SELECT 1 FROM compute.instances WHERE org_id = $1 AND quote_id = $2`,
            [orgId, req.quoteId],
          )
        ).rowCount,
    );
    if (used) throw new ProblemException('quote_consumed', 'this quote has already been used');
    const pref = (quote.preferences as { compute?: Record<string, unknown> }).compute;
    if (!pref)
      throw new ProblemException('validation_failed', 'the quote carries no compute placement');
    const plan = pref.plan as PlanShape;
    const accountId = pref.accountId as string;
    const providerPrice = (pref.providerPrice as CreateInput['providerPrice']) ?? null;
    const priceBookVersionId = (quote.price_book_version_id as string | null) ?? null;

    // Execution-time re-check BEFORE the quote is consumed (TOCTOU): residency, capability, entitlement, price.
    const veto = await this.prov.revalidate(orgId, {
      offerId: pref.offerId as string,
      providerPrice,
      priceBookVersionId,
    });
    if (veto) {
      const status: ErrorCode =
        (veto.code as ErrorCode) in
        ({
          residency_denied: 1,
          unsupported_capability: 1,
          quota_exceeded: 1,
          price_changed: 1,
          no_eligible_offer: 1,
        } as Record<string, number>)
          ? (veto.code as ErrorCode)
          : 'no_eligible_offer';
      throw new ProblemException(status, veto.message);
    }
    if (project(req.projectId, req.environmentId))
      await this.checkProject(orgId, req.projectId, req.environmentId);
    if (!(await this.quotaGuard.hasHeadroom(orgId)))
      throw new ProblemException(
        'quota_exceeded',
        'the compute quota would be exceeded; existing resources are untouched',
      );

    // The order consumes the quote: validity, hard quota group, spend limit or an approved spend approval (M02).
    let order;
    try {
      order = await this.orders.createFromQuote(orgId, req.quoteId, actorUserId, now);
    } catch (e) {
      if (e instanceof ProblemException) {
        if (e.code === 'gone')
          throw new ProblemException('quote_expired', 'this quote has expired; request a new one');
        if (e.code === 'conflict')
          throw new ProblemException('quote_consumed', 'this quote has already been used');
        if (e.code === 'spend_approval_required') {
          const pending = await this.spend
            .list(orgId, { userId: actorUserId, seesAll: true }, { limit: 50, status: 'pending' })
            .then(
              (p) =>
                p.items.find((a) => a.subjectKind === 'quote' && a.subjectId === req.quoteId) ??
                null,
              () => null,
            );
          throw new ProblemException('spend_approval_required', e.detail, undefined, {
            approvalId: pending?.id ?? null,
            quoteId: req.quoteId,
          });
        }
      }
      throw e;
    }

    const instanceId = uuidv7();
    const resourceId = uuidv7();
    const operationId = uuidv7();
    const authorizationId = uuidv7();
    const caps = await this.accountCapabilities(accountId);
    const createInput: CreateInput = {
      instanceId,
      resourceId,
      quoteId: req.quoteId,
      orderId: order.id,
      authorizationId,
      accountId,
      offerId: pref.offerId as string,
      regionRowId: pref.regionRowId as string,
      providerRegionId: pref.providerRegionId as string,
      country: pref.country as string,
      dataRegion: pref.dataRegion as string,
      planRef: pref.planRef as string,
      imageRef: pref.imageRef as string,
      name: req.name,
      plan,
      sshPublicKeys: req.sshPublicKeys,
      providerPrice,
      priceBookVersionId,
    };
    const token = idempotencyToken(orgId, operationId, 'provision');
    try {
      await this.db.withOrg(orgId, async (c) => {
        await this.quotaGuard.admit(c, orgId, plan.vcpu); // serialized per org: N parallel creates admit exactly the limit
        await c.query(
          `INSERT INTO commerce.authorizations (id, org_id, kind, order_id, amount_minor, currency) VALUES ($1,$2,'hold',$3,$4,$5)`,
          [
            authorizationId,
            orgId,
            order.id,
            String(quote.total_minor),
            (quote.currency as string).trim(),
          ],
        );
        await c.query(
          `INSERT INTO cloud.resources (id, org_id, kind, provider_account_id, state, data_region, country, provider_region_id, created_by_operation_id, provision_token)
           VALUES ($1,$2,'compute_instance',$3,'PROVISIONING',$4,$5,$6,$7,$8)`,
          [
            resourceId,
            orgId,
            accountId,
            createInput.dataRegion,
            createInput.country,
            createInput.providerRegionId,
            operationId,
            token,
          ],
        );
        await c.query(
          `INSERT INTO compute.instances (id, org_id, project_id, environment_id, resource_id, name, plan, status, capabilities, quote_id, order_id, data_region, country, ssh_public_keys, tags, operation_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'provisioning',$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            instanceId,
            orgId,
            req.projectId,
            req.environmentId,
            resourceId,
            req.name,
            JSON.stringify({ ...plan, planRef: createInput.planRef }),
            JSON.stringify(caps),
            req.quoteId,
            order.id,
            createInput.dataRegion,
            createInput.country,
            JSON.stringify(req.sshPublicKeys),
            JSON.stringify(req.tags),
            operationId,
            actorUserId,
          ],
        );
        await c.query(
          `INSERT INTO platform.operations (id, org_id, kind, input, resource_kind, resource_id, created_by, trace_id, idempotency_key, max_attempts) VALUES ($1,$2,$3,$4,'cloud_resource',$5,$6,$7,$8,5)`,
          [
            operationId,
            orgId,
            OP_CREATE,
            JSON.stringify(createInput),
            resourceId,
            actorUserId,
            traceId,
            idempotencyKey ?? null,
          ],
        );
        await enqueue(c, orgId, 'operation.created', { operationId, kind: OP_CREATE });
        await this.audit.record({
          action: 'instance.create.requested',
          actorUserId,
          orgId,
          resource: { type: 'compute_instance', id: instanceId },
          outcome: 'success',
          after: { quoteId: req.quoteId, orderId: order.id, dataRegion: createInput.dataRegion },
          traceId,
        });
      });
    } catch (e) {
      // the quote was consumed but nothing was created: close the order so it is not left looking active
      await this.db
        .withOrg(orgId, (c) =>
          c.query(
            `UPDATE commerce.orders SET status = 'failed' WHERE id = $1 AND status = 'created'`,
            [order.id],
          ),
        )
        .catch(() => undefined);
      throw e;
    }
    this.prov.kick(orgId, operationId);
    return { instance: toDto(await this.getRow(orgId, instanceId)), operationId };
  }

  private async checkProject(
    orgId: string,
    projectId: string | null,
    environmentId: string | null,
  ) {
    await this.db.withOrg(orgId, async (c) => {
      if (
        projectId &&
        !(
          await c.query(`SELECT 1 FROM tenancy.projects WHERE id = $1 AND org_id = $2`, [
            projectId,
            orgId,
          ])
        ).rowCount
      )
        throw new ProblemException('not_found', 'project not found');
      if (
        environmentId &&
        !(
          await c.query(
            `SELECT 1 FROM tenancy.environments WHERE id = $1 AND org_id = $2 AND ($3::uuid IS NULL OR project_id = $3)`,
            [environmentId, orgId, projectId],
          )
        ).rowCount
      )
        throw new ProblemException('not_found', 'environment not found');
    });
  }

  private async accountCapabilities(accountId: string): Promise<string[]> {
    return this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT capability_id FROM cloud.provider_capabilities WHERE account_id = $1 AND state = 'supported' ORDER BY capability_id`,
          [accountId],
        )
      ).rows.map((r) => r.capability_id as string),
    );
  }

  // ---- delete ---------------------------------------------------------------------------------------------------------------
  async remove(
    orgId: string,
    actorUserId: string,
    id: string,
    ifMatch: number | null,
    traceId: string,
  ): Promise<{ instance: InstanceDto; operationId: string }> {
    await this.requireFlag(orgId);
    let row = await this.getRow(orgId, id); // existence (404 for another organization's id) is answered before any precondition
    if (ifMatch === null) throw new ProblemException('precondition_required');
    if (row.version !== ifMatch)
      throw new ProblemException('precondition_failed', 'the instance changed; reload and retry');
    if (row.deletion_protected)
      throw new ProblemException(
        'deletion_protected',
        'deletion protection is on for this instance',
      );
    if (['deleting', 'deleted'].includes(row.status as string))
      throw new ProblemException(
        'invalid_state',
        `the instance is already ${row.status as string}`,
      );
    if (row.status === 'provisioning')
      throw new ProblemException(
        'invalid_state',
        'the instance is still provisioning; cancel the operation instead',
      );
    if (row.status === 'unknown' || row.resource_state === 'UNKNOWN') {
      // reconcile BEFORE deleting when the state is uncertain
      await this.reconciler.reconcileResource(row.resource_id as string, { trigger: 'pre_delete' });
      row = await this.getRow(orgId, id);
      if (row.status === 'unknown' || row.resource_state === 'UNKNOWN')
        throw new ProblemException(
          'invalid_state',
          'the instance state is uncertain and could not be reconciled yet; try again shortly',
        );
      if (row.status === 'deleted')
        return { instance: toDto(row), operationId: (row.operation_id as string | null) ?? '' };
      if (row.status === 'failed')
        throw new ProblemException('invalid_state', 'the instance failed to provision');
    }
    const operationId = uuidv7();
    const input = {
      instanceId: row.id as string,
      resourceId: row.resource_id as string,
      accountId: row.provider_account_id as string,
      priorStatus: row.status as string,
    };
    try {
      await this.db.withOrg(orgId, async (c) => {
        await transitionResource(c, row.resource_id as string, 'DELETING', 'orchestrator');
        const n = await c.query(
          `UPDATE compute.instances SET status = 'deleting', operation_id = $3, updated_at = now(), version = version + 1 WHERE id = $1 AND version = $2`,
          [row.id, ifMatch, operationId],
        );
        if (!n.rowCount)
          throw new ProblemException(
            'precondition_failed',
            'the instance changed; reload and retry',
          );
        await c.query(
          `INSERT INTO platform.operations (id, org_id, kind, input, resource_kind, resource_id, created_by, trace_id, max_attempts) VALUES ($1,$2,$3,$4,'cloud_resource',$5,$6,$7,5)`,
          [
            operationId,
            orgId,
            OP_DELETE,
            JSON.stringify(input),
            row.resource_id,
            actorUserId,
            traceId,
          ],
        );
        await enqueue(c, orgId, 'operation.created', { operationId, kind: OP_DELETE });
        await this.audit.record({
          action: 'instance.delete.requested',
          actorUserId,
          orgId,
          resource: { type: 'compute_instance', id: row.id as string },
          outcome: 'success',
          traceId,
        });
      });
    } catch (e) {
      if (pgCode(e) === '23514')
        throw new ProblemException(
          'invalid_state',
          'the instance cannot be deleted in its current state',
        );
      throw e;
    }
    this.prov.kick(orgId, operationId);
    return { instance: toDto(await this.getRow(orgId, id)), operationId };
  }

  // ---- actions --------------------------------------------------------------------------------------------------------------
  async act(
    orgId: string,
    actorUserId: string,
    id: string,
    input: unknown,
    idempotencyKey: string,
    traceId: string,
  ): Promise<{ instance: InstanceDto; operationId: string; actionId: string }> {
    await this.requireFlag(orgId);
    let row = await this.getRow(orgId, id); // 404 for another organization's id comes before any body validation
    const b = body(input);
    const type = b.type;
    if (typeof type !== 'string' || !(ACTIONS as readonly string[]).includes(type))
      throw new ProblemException('validation_failed', `type must be one of ${ACTIONS.join(', ')}`);
    const action = type as (typeof ACTIONS)[number];
    const params = (b.params ?? {}) as Record<string, unknown>;
    if (
      typeof params !== 'object' ||
      params === null ||
      Array.isArray(params) ||
      JSON.stringify(params).length > 2000
    )
      throw new ProblemException('validation_failed', 'params must be a small object');
    // a repeated key returns the first action (idempotent per key)
    const prior = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM compute.instance_actions WHERE instance_id = $1 AND idempotency_key = $2`,
            [row.id, idempotencyKey],
          )
        ).rows[0] as Row | undefined,
    );
    if (prior) {
      if (prior.type !== action) throw new ProblemException('idempotency_key_reuse');
      return {
        instance: toDto(row),
        operationId: (prior.operation_id as string | null) ?? '',
        actionId: prior.id as string,
      };
    }
    // capability gate: only actions in the instance capability set (422 unsupported_capability, never a silent no-op)
    if (!((row.capabilities as string[]) ?? []).includes(`compute.action.${action}`))
      throw new ProblemException(
        'unsupported_capability',
        `this instance does not support the ${action} action`,
      );
    if (row.status === 'unknown' || row.resource_state === 'UNKNOWN') {
      await this.reconciler.reconcileResource(row.resource_id as string, { trigger: 'pre_action' });
      row = await this.getRow(orgId, id);
    }
    const status = row.status as string;
    const okStates: Record<string, string[]> = {
      start: ['stopped'],
      stop: ['running'],
      reboot: ['running'],
      resize: ['running', 'stopped'],
      snapshot: ['running', 'stopped'],
    };
    if (!okStates[action]!.includes(status))
      throw new ProblemException(
        'invalid_state',
        `the ${action} action is not allowed while the instance is ${status}`,
      );
    let targetPlan: ActionInput['targetPlan'];
    if (action === 'resize') {
      if (typeof params.offerId !== 'string' || !UUID.test(params.offerId))
        throw new ProblemException('validation_failed', 'params.offerId must be an offer id');
      const [c] = await this.offers.candidates(orgId, {
        planId: params.offerId.toLowerCase(),
        ignoreInstanceQuota: true,
      });
      if (
        !c ||
        c.failures.length ||
        c.accountId !== (row.provider_account_id as string) ||
        c.providerRegionId !== (row.provider_region_id as string)
      )
        throw new ProblemException(
          'no_eligible_offer',
          'the target plan is not an eligible offer in the same placement',
        );
      const delta = c.vcpu - ((row.plan as PlanShape).vcpu ?? 0);
      if (delta > 0)
        await this.db.withOrg(orgId, (cl) => this.quotaGuard.admitVcpuDelta(cl, orgId, delta));
      targetPlan = { planRef: c.planRef, vcpu: c.vcpu, memoryMb: c.memoryMb, diskGb: c.diskGb };
    }
    const actionId = uuidv7();
    const operationId = uuidv7();
    const opInput: ActionInput = {
      actionId,
      instanceId: row.id as string,
      resourceId: row.resource_id as string,
      accountId: row.provider_account_id as string,
      type: action,
      params,
      ...(targetPlan ? { targetPlan } : {}),
      priorStatus: status,
    };
    try {
      await this.db.withOrg(orgId, async (c) => {
        await c.query(
          `INSERT INTO compute.instance_actions (id, org_id, instance_id, type, params, operation_id, idempotency_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            actionId,
            orgId,
            row.id,
            action,
            JSON.stringify(params),
            operationId,
            idempotencyKey,
            actorUserId,
          ],
        );
        await c.query(
          `INSERT INTO platform.operations (id, org_id, kind, input, resource_kind, resource_id, created_by, trace_id, idempotency_key, max_attempts) VALUES ($1,$2,$3,$4,'cloud_resource',$5,$6,$7,$8,3)`,
          [
            operationId,
            orgId,
            OP_ACTION,
            JSON.stringify(opInput),
            row.resource_id,
            actorUserId,
            traceId,
            idempotencyKey,
          ],
        );
        await enqueue(c, orgId, 'operation.created', { operationId, kind: OP_ACTION });
      });
    } catch (e) {
      if (pgCode(e) === '23505') {
        const again = await this.db.withOrg(
          orgId,
          async (c) =>
            (
              await c.query(
                `SELECT * FROM compute.instance_actions WHERE instance_id = $1 AND idempotency_key = $2`,
                [row.id, idempotencyKey],
              )
            ).rows[0] as Row,
        );
        return {
          instance: toDto(row),
          operationId: (again.operation_id as string | null) ?? '',
          actionId: again.id as string,
        };
      }
      throw e;
    }
    this.prov.kick(orgId, operationId);
    return { instance: toDto(await this.getRow(orgId, id)), operationId, actionId };
  }

  // ---- metrics --------------------------------------------------------------------------------------------------------------
  async metrics(orgId: string, id: string, q: { from?: string; to?: string }) {
    await this.requireFlag(orgId);
    const row = await this.getRow(orgId, id);
    if (!((row.capabilities as string[]) ?? []).includes('compute.metrics'))
      throw new ProblemException(
        'unsupported_capability',
        'metrics are not available for this instance',
      );
    const to = q.to ? new Date(q.to) : this.now();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 3_600_000);
    if (
      Number.isNaN(to.getTime()) ||
      Number.isNaN(from.getTime()) ||
      from >= to ||
      to.getTime() - from.getTime() > 7 * 86_400_000
    )
      throw new ProblemException(
        'invalid_filter',
        'from/to must be ISO times, from < to, at most 7 days apart',
      );
    const acc = await this.prov.access(row.provider_account_id as string, `metrics-${id}`);
    if (!acc?.adapter.metrics || !row.provider_ref)
      throw new ProblemException(
        'unsupported_capability',
        'metrics are not available for this instance',
      );
    const r = await acc.adapter.metrics(acc.ctx, row.provider_ref as string, {
      from: from.toISOString(),
      to: to.toISOString(),
    });
    if (r.status !== 'succeeded' || !r.data) {
      if (r.error?.category === 'unsupported')
        throw new ProblemException(
          'unsupported_capability',
          'metrics are not available for this instance',
        );
      throw new ProblemException('service_unavailable', 'metrics could not be read right now');
    }
    return { window: r.data.window, series: r.data.series };
  }
}

const project = (p: string | null, e: string | null) => p !== null || e !== null;
