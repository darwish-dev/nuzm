import { idempotencyToken } from '@nuzm/adapter-data';
import type { Operation } from '@nuzm/platform';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { SecretStore } from '../../../common/secrets';
import type { DataAlerts } from './alerts';
import type { DatabaseBindingPort } from './binding.port';
import type { DatabaseDto, DatabaseService } from './database.service';
import { DatabaseFlow, REDIS_APP_ACL } from './database-flow';
import { FlowFailure, FlowUncertain, outcomeOf, retryTransient } from './flow-support';
import { DB_RESOURCE, OP, serviceOfEngine, type DataConfig, type Engine, type Row } from './model';
import type { DataOperations } from './operations-port';

interface RotationState {
  state: 'pending' | 'window' | 'completed';
  role: string;
  operationId?: string;
  newCredentialId?: string;
  previousCredentialId?: string;
  previousVaultRef?: string;
  windowEndsAt?: string;
  completedAt?: string;
}
const ROLE = /^[a-z][a-z0-9_]{1,30}$/;

/**
 * Credential rotation with a dual-credential window (M08 S33 task 5; proposal 24 h). Order: issue the NEW credential while the old one keeps working →
 * store it in the vault → point the instance at it and notify the consumers through `DatabaseBindingPort` (they switch inside the window: zero
 * downtime) → at the window end the sweep REVOKES the old credential and removes its vault entry. A provider without dual-credential support cannot
 * rotate (422 unsupported_capability): a hard swap would break running consumers, so the action is disabled instead. Secrets are never returned,
 * logged, audited or put into operations: the instance only changes its vault reference.
 */
export class RotationService {
  private kicker: (orgId: string, operationId: string) => void = () => undefined;
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: DataOperations,
    private readonly dbs: DatabaseService,
    private readonly flow: DatabaseFlow,
    private readonly bindings: DatabaseBindingPort,
    private readonly alerts: DataAlerts,
    private readonly secrets: SecretStore,
    private readonly cfg: DataConfig,
  ) {
    flow.register(OP.DB_ROTATE, (o, op, w) => this.run(o, op, w));
  }
  setKicker(k: (orgId: string, operationId: string) => void) {
    this.kicker = k;
  }

  async request(
    orgId: string,
    actor: string,
    databaseId: string,
    body: Record<string, unknown>,
  ): Promise<DatabaseDto & { operationId: string }> {
    const role = body.role ?? 'app';
    if (typeof role !== 'string' || !ROLE.test(role))
      throw new ProblemException('validation_failed', 'role must be a lower-case identifier');
    if (Object.keys(body).some((k) => k !== 'role'))
      throw new ProblemException('validation_failed', 'unknown field in the rotation request');
    const inst = await this.dbs.row(orgId, databaseId);
    if (inst.state !== 'running')
      throw new ProblemException('conflict', 'the database must be running');
    const cur = inst.rotation as RotationState | null;
    if (cur && (cur.state === 'pending' || cur.state === 'window'))
      throw new ProblemException(
        'rotation_in_progress',
        'a rotation is already in progress for this database',
      );
    const p = await this.flow.providers.byId(
      orgId,
      String(inst.provider_id),
      serviceOfEngine(inst.engine as Engine),
    );
    const caps = p?.row.probe?.capabilities ?? {};
    const prefix = inst.engine === 'redis' ? 'cache' : 'database';
    if (
      caps[`${prefix}.credential-rotation`] !== 'supported' ||
      caps[`${prefix}.dual-credentials`] !== 'supported'
    )
      throw new ProblemException(
        'unsupported_capability',
        'the provider does not support dual-credential rotation, so the rotation action is disabled',
      );
    const op = await this.ops.create(orgId, {
      kind: OP.DB_ROTATE,
      resourceKind: DB_RESOURCE,
      resourceId: databaseId,
      createdBy: actor,
      maxAttempts: 1,
      input: { databaseId, role },
    });
    // the conditional update is the arbiter: two concurrent requests cannot both start a rotation
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.database_instances SET rotation = $3, operation_id = $4 WHERE id = $1 AND org_id = $2 AND state = 'running'
             AND (rotation IS NULL OR rotation->>'state' = 'completed') RETURNING *`,
            [
              databaseId,
              orgId,
              JSON.stringify({
                state: 'pending',
                role,
                operationId: op.id,
              } satisfies RotationState),
              op.id,
            ],
          )
        ).rows[0] as Row | undefined,
    );
    if (!row)
      throw new ProblemException(
        'rotation_in_progress',
        'a rotation is already in progress for this database',
      );
    await this.audit.record({
      action: 'data.database.rotation_requested',
      actorUserId: actor,
      orgId,
      resource: { type: 'database', id: databaseId },
      outcome: 'success',
      after: { role, operationId: op.id },
    });
    this.kicker(orgId, op.id);
    return { ...this.dbs.dto(row), operationId: op.id };
  }

  private async run(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as { databaseId: string; role: string };
    let inst = await this.flow.inst(orgId, input.databaseId);
    const state = inst.rotation as RotationState | null;
    if (!state || state.operationId !== op.id)
      throw new FlowFailure('rotation_superseded', 'this rotation is no longer the current one');
    if (state.state !== 'pending')
      return void (await this.ops.succeed(orgId, op.id, worker, {
        databaseId: inst.id,
        windowEndsAt: state.windowEndsAt,
      }));
    const access = await this.flow.access(orgId, inst, op.trace_id ?? op.id);
    await this.flow.assertResidency(orgId, inst, access, 'credential_rotation');
    const engine = inst.engine as Engine;
    // the credential being replaced (read from the vault by reference; never logged)
    const prev = JSON.parse(await this.secrets.get(inst.vault_ref as string)) as {
      credentialId: string;
    };
    const tokenIssue = idempotencyToken(orgId, op.id, 'rotate-issue');
    const iss = outcomeOf(
      await retryTransient(this.cfg, () =>
        access.adapter.issueCredential(access.ctx, inst.provider_ref as string, {
          role: input.role,
          ...(engine === 'redis' ? { acl: REDIS_APP_ACL } : {}),
          idempotencyToken: tokenIssue,
          keepPrevious: true,
        }),
      ),
    );
    if (iss.kind === 'uncertain') throw new FlowUncertain('the credential call timed out');
    if (iss.kind !== 'ok' || !iss.data)
      throw new FlowFailure(
        iss.kind === 'failed' && iss.unsupported ? 'unsupported_capability' : 'credential_failed',
        iss.kind === 'failed' ? iss.message : 'no credential returned',
      );
    const secret = iss.data;
    let ref: string;
    try {
      ref = await this.secrets.put(
        `db-${String(inst.id)}-${secret.credentialId.replace(/[^A-Za-z0-9_-]/g, '')}`,
        JSON.stringify({
          username: secret.username,
          ...secret.fields,
          host: inst.host,
          port: inst.port,
          engine,
          tls: true,
          credentialId: secret.credentialId,
        }),
      );
    } catch {
      throw new FlowUncertain('the vault is unavailable'); // the issued credential is addressed by token: the replay gets the same one
    }
    const windowEndsAt = new Date(
      Date.now() + this.cfg.rotationWindowHours * 3_600_000,
    ).toISOString();
    const next: RotationState = {
      state: 'window',
      role: input.role,
      operationId: op.id,
      newCredentialId: secret.credentialId,
      previousCredentialId: prev.credentialId,
      previousVaultRef: inst.vault_ref as string,
      windowEndsAt,
    };
    inst = await this.flow.setInst(orgId, inst.id as string, { vault_ref: ref, rotation: next });
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE data.database_instances SET reveal = NULL WHERE id = $1`, [inst.id]),
    );
    await this.audit.record({
      action: 'data.database.rotated',
      actorType: 'system',
      orgId,
      resource: { type: 'database', id: String(inst.id) },
      outcome: 'success',
      after: { windowEndsAt, newCredentialId: secret.credentialId },
    });
    // consumers switch to the new reference inside the window; a failed notice does not undo the rotation (the window keeps the old credential alive)
    await this.bindings
      .notifyRotation(orgId, {
        databaseId: String(inst.id),
        newVaultRef: ref,
        previousVaultRef: next.previousVaultRef!,
        windowEndsAt,
      })
      .catch(async () => {
        await this.alerts.raise(orgId, {
          kind: 'data.rotation_notice_failed',
          severity: 'warning',
          resource: { type: 'database', id: String(inst.id) },
          detail: { windowEndsAt },
        });
      });
    await this.ops.succeed(orgId, op.id, worker, { databaseId: inst.id, windowEndsAt });
  }

  /** End every dual-credential window that has passed: revoke the OLD credential at the provider, drop its vault entry, record completion. */
  async endWindows(now: Date, only?: { orgId: string; databaseId: string }): Promise<number> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM data.database_instances WHERE state = 'running' AND rotation->>'state' = 'window' AND (rotation->>'windowEndsAt')::timestamptz <= $1 AND ($2::uuid IS NULL OR id = $2)`,
            [now, only?.databaseId ?? null],
          )
        ).rows as Row[],
    );
    let n = 0;
    for (const inst of rows) {
      const orgId = inst.org_id as string;
      const rot = inst.rotation as RotationState;
      try {
        const access = await this.flow.access(orgId, inst, 'rotation-end');
        const r = outcomeOf(
          await retryTransient(this.cfg, () =>
            access.adapter.revokeCredential(access.ctx, inst.provider_ref as string, {
              credentialId: rot.previousCredentialId!,
              idempotencyToken: idempotencyToken(
                orgId,
                rot.operationId ?? String(inst.id),
                'rotate-revoke',
              ),
            }),
          ),
        );
        if (r.kind !== 'ok') {
          // never mark the window ended while the old credential might still work: leave it, alert, the next sweep retries
          await this.alerts.raise(orgId, {
            kind: 'data.rotation_revoke_failed',
            severity: 'critical',
            resource: { type: 'database', id: String(inst.id) },
            detail: { previousCredentialId: rot.previousCredentialId },
          });
          continue;
        }
        if (rot.previousVaultRef)
          await this.secrets.delete(rot.previousVaultRef).catch(() => undefined);
        await this.flow.setInst(orgId, inst.id as string, {
          rotation: {
            state: 'completed',
            role: rot.role,
            operationId: rot.operationId,
            newCredentialId: rot.newCredentialId,
            completedAt: now.toISOString(),
          },
        });
        await this.audit.record({
          action: 'data.database.rotation_completed',
          actorType: 'system',
          orgId,
          resource: { type: 'database', id: String(inst.id) },
          outcome: 'success',
          after: { revokedCredentialId: rot.previousCredentialId },
        });
        n++;
      } catch (e) {
        await this.alerts.raise(orgId, {
          kind: 'data.rotation_revoke_failed',
          severity: 'critical',
          resource: { type: 'database', id: String(inst.id) },
          detail: { error: (e as Error).message.slice(0, 120) },
        });
      }
    }
    return n;
  }

  /**
   * One-time, audited reveal of the CURRENT connection credential (PA-15). The HTTP routes `POST /v1/databases/{id}/credential-reveals` are NOT exposed:
   * docs/04 §2.13 forbids implementing a proposed addition before the owner approves it. This service is what the route will call.
   * The secret is returned once; asking again for the same credential is a conflict (a rotation issues a new one). Nothing is logged or audited with it.
   */
  async reveal(
    orgId: string,
    actor: string,
    databaseId: string,
  ): Promise<{
    username: string;
    password: string;
    host: string;
    port: number;
    engine: string;
    tls: true;
  }> {
    const inst = await this.dbs.row(orgId, databaseId);
    if (inst.state !== 'running' || !inst.vault_ref)
      throw new ProblemException('conflict', 'the database has no credential to reveal');
    const won = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE data.database_instances SET reveal = $3 WHERE id = $1 AND org_id = $2 AND (reveal IS NULL OR reveal->>'vaultRef' <> $4) RETURNING id`,
            [
              databaseId,
              orgId,
              JSON.stringify({
                vaultRef: inst.vault_ref,
                revealedAt: new Date().toISOString(),
                revealedBy: actor,
              }),
              inst.vault_ref,
            ],
          )
        ).rows[0],
    );
    if (!won)
      throw new ProblemException(
        'conflict',
        'this credential was already revealed once; rotate the credential to get a new one',
      );
    const s = JSON.parse(await this.secrets.get(inst.vault_ref as string)) as Record<
      string,
      unknown
    >;
    await this.audit.record({
      action: 'data.database.credential_revealed',
      actorUserId: actor,
      orgId,
      resource: { type: 'database', id: databaseId },
      outcome: 'success',
      after: { vaultRef: inst.vault_ref },
    });
    return {
      username: String(s.username),
      password: String(s.password),
      host: String(s.host),
      port: Number(s.port),
      engine: String(s.engine),
      tls: true,
    };
  }
}
