import { v7 as uuidv7 } from 'uuid';
import { enqueue, type Db, type OperationsService } from '@nuzm/platform';
import { isSupported, type DomainRef, type OperationResult } from '@nuzm/registrar-contracts';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { FieldCipher } from '../../../common/field-crypto';
import { decodeCursor, pageOf, parseLimit } from '../../../common/pagination';
import type { ConsentService } from '../../compliance';
import { selfRef } from '../../compliance';
import { UUID, badRequest, type Row } from './common';
import { maskContact, openContact, parseContacts, sealContact } from './contacts';
import type { EligibilityService } from './eligibility.service';
import { OP_UPDATE, type DomainOrderService } from './orders.service';
import type { RegistrarAccessService, RegistrarAccount } from './registrar-access.service';
import { RESIDENCY_PURPOSE } from './domain-pricer';
import type { ResidencyEvaluator } from '@nuzm/domain';

export const STATES = [
  'pending',
  'active',
  'expired',
  'redemption',
  'transferring',
  'failed',
  'renewal_at_risk',
] as const;

export interface DomainDto {
  id: string;
  name: string;
  tld: string;
  state: string;
  expiresAt: string | null;
  registeredAt: string | null;
  autoRenew: boolean;
  locked: boolean;
  privacyState: string;
  nameservers: string[];
  dataRegion: string;
  providerRegionId: string | null;
  renewalAtRisk: boolean;
  version: number;
  capabilities: Record<string, boolean>;
  contacts?: Record<string, unknown>;
  contactsMasked?: boolean;
  createdAt: string;
}

const dto = (r: Row, account: RegistrarAccount | null): DomainDto => ({
  id: r.id as string,
  name: r.name as string,
  tld: r.tld as string,
  state: r.state as string,
  expiresAt: r.expires_at ? (r.expires_at as Date).toISOString() : null,
  registeredAt: r.registered_at ? (r.registered_at as Date).toISOString() : null,
  autoRenew: r.auto_renew as boolean,
  locked: r.locked as boolean,
  privacyState: r.privacy_state as string,
  nameservers: (r.nameservers as string[]) ?? [],
  dataRegion: r.data_region as string,
  providerRegionId: (r.provider_region_id as string | null) ?? null,
  renewalAtRisk: r.state === 'renewal_at_risk',
  version: r.version as number,
  capabilities: {
    contacts: !!account && isSupported(account.capabilities, 'registrar.contacts'),
    nameservers: !!account && isSupported(account.capabilities, 'registrar.nameservers'),
    lock: !!account && isSupported(account.capabilities, 'registrar.lock'),
    privacy: !!account && account.tldSupport.find((t) => t.tld === r.tld)?.privacy === 'supported',
    dns: !!account && isSupported(account.capabilities, 'registrar.dns'),
    dnssec:
      !!account &&
      isSupported(account.capabilities, 'registrar.dnssec') &&
      account.tldSupport.find((t) => t.tld === r.tld)?.dnssec === 'supported',
  },
  createdAt: (r.created_at as Date).toISOString(),
});

export class DomainService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly access: RegistrarAccessService,
    private readonly eligibility: EligibilityService,
    private readonly orders: DomainOrderService,
    private readonly ops: OperationsService,
    private readonly cipher: FieldCipher,
    private readonly consents: ConsentService,
    private readonly residency: ResidencyEvaluator,
  ) {}

  async list(
    orgId: string,
    q: { state?: unknown; q?: unknown; limit?: unknown; cursor?: unknown },
  ) {
    const limit = parseLimit(q.limit);
    const cursor = decodeCursor(q.cursor);
    if (q.state !== undefined && !(STATES as readonly string[]).includes(String(q.state)))
      throw badRequest('state is not a domain state');
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM domains.domains WHERE ($1::text IS NULL OR state = $1) AND ($2::text IS NULL OR name LIKE $2) AND ($3::uuid IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
            [
              q.state ?? null,
              typeof q.q === 'string' && q.q
                ? `%${q.q.toLowerCase().replace(/[%_\\]/g, '')}%`
                : null,
              cursor,
              limit + 1,
            ],
          )
        ).rows as Row[],
    );
    const accounts = new Map<string, RegistrarAccount | null>();
    const items: DomainDto[] = [];
    for (const r of rows.slice(0, limit)) {
      const id = r.registrar_account_id as string;
      if (!accounts.has(id)) accounts.set(id, await this.access.getAccount(id));
      items.push(dto(r, accounts.get(id)!));
    }
    return {
      ...pageOf(
        rows.map((r) => ({ id: r.id as string })),
        limit,
      ),
      items,
    };
  }

  async get(orgId: string, id: string, showContacts: boolean): Promise<DomainDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM domains.domains WHERE id = $1`, [id])).rows[0] as
          Row | undefined,
    );
    if (!r) throw new ProblemException('not_found');
    const d = dto(r, await this.access.getAccount(r.registrar_account_id as string));
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT id, role, payload_enc FROM domains.domain_contacts WHERE domain_id = $1 ORDER BY role`,
            [id],
          )
        ).rows as Row[],
    );
    if (rows.length) {
      const contacts: Record<string, unknown> = {};
      for (const row of rows) {
        const p = await openContact(this.cipher, row.id as string, row.payload_enc as string);
        contacts[row.role as string] = showContacts ? p : maskContact(p);
      }
      d.contacts = contacts;
      d.contactsMasked = !showContacts;
    }
    return d;
  }

  async eligibilityOf(orgId: string, id: string) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const d = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT d.id, d.tld, d.registrar_account_id FROM domains.domains d WHERE d.id = $1`,
            [id],
          )
        ).rows[0] as Row | undefined,
    );
    if (!d) throw new ProblemException('not_found');
    const last = await this.eligibility.latestForDomain(orgId, id);
    if (last) return last;
    // an existing domain with no stored evaluation (e.g. registered before the policy existed): evaluate now and keep the evidence
    const acct = await this.access.getAccount(d.registrar_account_id as string);
    const dec = this.eligibility.decide(
      d.tld as string,
      'renew',
      acct?.tldSupport.find((t) => t.tld === d.tld),
    );
    await this.eligibility.record(orgId, dec, { domainId: id });
    return {
      rule: dec.rule,
      state: dec.result,
      reason: dec.reason,
      action: dec.action,
      ruleSetVersion: dec.ruleSetVersion,
      evaluatedAt: new Date().toISOString(),
      evidence: dec.evidence,
    };
  }

  /** PATCH contacts / nameservers / lock / autoRenew with optimistic concurrency (If-Match = domain version). */
  async patch(
    orgId: string,
    actor: string,
    id: string,
    ifMatch: number | null,
    body: Record<string, unknown>,
    traceId: string,
  ): Promise<{ status: 200 | 202; domain: DomainDto; operationId?: string }> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM domains.domains WHERE id = $1`, [id])).rows[0] as
          Row | undefined,
    );
    if (!row) throw new ProblemException('not_found'); // existence is answered before anything about the request is judged
    if (ifMatch === null)
      throw new ProblemException(
        'precondition_required',
        'send If-Match with the version you read',
      );
    const allowed = ['contacts', 'nameservers', 'lock', 'autoRenew', 'privacy'];
    for (const k of Object.keys(body))
      if (!allowed.includes(k)) throw badRequest(`unknown field ${k}`);
    if (Object.keys(body).length === 0) throw badRequest('nothing to change');
    if (body.privacy !== undefined)
      throw new ProblemException(
        'unsupported_capability',
        'privacy protection can only be chosen when the domain is ordered',
      );
    if (row.version !== ifMatch)
      throw new ProblemException(
        'etag_mismatch',
        `the domain is at version ${String(row.version)}`,
      );
    if (
      row.state !== 'active' &&
      row.state !== 'renewal_at_risk' &&
      !(Object.keys(body).length === 1 && body.autoRenew !== undefined)
    )
      throw new ProblemException('conflict', `a ${String(row.state)} domain cannot be changed`);
    const account = await this.access.getAccount(row.registrar_account_id as string);
    if (!account)
      throw new ProblemException(
        'unsupported_capability',
        'the registrar for this domain is not available',
      );
    const name = row.name as string;
    const need = (
      cap: 'registrar.contacts' | 'registrar.nameservers' | 'registrar.lock',
      what: string,
    ) => {
      if (!isSupported(account.capabilities, cap))
        throw new ProblemException(
          'unsupported_capability',
          `${what} cannot be changed at this registrar`,
        );
    };
    if (body.contacts !== undefined) need('registrar.contacts', 'contacts');
    if (body.nameservers !== undefined) need('registrar.nameservers', 'nameservers');
    if (body.lock !== undefined) need('registrar.lock', 'the transfer lock');
    if (body.lock !== undefined && typeof body.lock !== 'boolean')
      throw badRequest('lock must be true or false');
    if (body.autoRenew !== undefined && typeof body.autoRenew !== 'boolean')
      throw badRequest('autoRenew must be true or false');
    let nameservers: string[] | undefined;
    if (body.nameservers !== undefined) {
      const v = body.nameservers;
      if (
        !Array.isArray(v) ||
        v.length < 2 ||
        v.length > 13 ||
        v.some(
          (n) =>
            typeof n !== 'string' ||
            !/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(n),
        )
      )
        throw badRequest('nameservers must be 2..13 host names');
      nameservers = (v as string[]).map((n) => n.toLowerCase());
    }
    const support = account.tldSupport.find((t) => t.tld === row.tld);
    const contacts =
      body.contacts !== undefined
        ? parseContacts(body.contacts, support?.requiredContactFields ?? [])
        : undefined;
    if (contacts) {
      const r = await this.residency.evaluate({
        orgId,
        dataClass: 'personal',
        targetRegion: account.dataRegion,
        purpose: RESIDENCY_PURPOSE,
        processorId: account.providerCode,
        operation: 'write',
      });
      if (r.decision !== 'allow')
        throw new ProblemException(
          'residency_denied',
          'the registrar is not allowed by your data residency policy',
          r.reasons.map((x) => ({ code: x.code, message: x.message })),
        );
      if (row.privacy_state !== 'on') {
        const ok =
          (await this.consents.isAllowed(orgId, selfRef(actor), 'domain_registrant_disclosure')) ||
          (await this.consents.isAllowed(orgId, 'org', 'domain_registrant_disclosure'));
        if (!ok)
          throw new ProblemException(
            'consent_required',
            'record the consent domain_registrant_disclosure first',
          );
      }
    }
    const acc = this.access.accessFor(account, traceId);
    if (!acc)
      throw new ProblemException(
        'unsupported_capability',
        'no adapter is available for this registrar',
      );

    const results: OperationResult<DomainRef>[] = [];
    if (nameservers) results.push(await acc.adapter.setNameservers(acc.ctx, name, nameservers));
    if (typeof body.lock === 'boolean')
      results.push(await acc.adapter.setLock(acc.ctx, name, body.lock));
    if (contacts) results.push(await acc.adapter.setContacts(acc.ctx, name, contacts));
    const bad = results.find((r) => r.status === 'failed');
    const uncertain = results.find((r) => r.status === 'uncertain');
    if (bad && !uncertain) {
      const c = bad.error?.category;
      throw new ProblemException(
        c === 'unsupported'
          ? 'unsupported_capability'
          : c === 'validation'
            ? 'validation_failed'
            : c === 'conflict'
              ? 'conflict'
              : 'service_unavailable',
        bad.error?.message ?? 'the registrar refused the change',
      );
    }
    // local state: what the registrar confirmed (read-back refs), plus our own auto-renew flag (renewals are platform-driven: the vendor's auto-renew stays off)
    const ref = [...results].reverse().find((r) => r.data)?.data;
    await this.db.withOrg(orgId, async (c) => {
      const cur = (
        await c.query(`SELECT version FROM domains.domains WHERE id=$1 FOR UPDATE`, [id])
      ).rows[0] as Row;
      if (cur.version !== ifMatch)
        throw new ProblemException(
          'etag_mismatch',
          'the domain changed while the request was running',
        );
      await c.query(
        `UPDATE domains.domains SET nameservers = coalesce($2::jsonb, nameservers), locked = coalesce($3, locked), auto_renew = coalesce($4, auto_renew), last_synced_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
        [
          id,
          nameservers && !uncertain
            ? JSON.stringify(ref?.nameservers?.length ? ref.nameservers : nameservers)
            : null,
          typeof body.lock === 'boolean' && !uncertain ? (ref?.locked ?? body.lock) : null,
          typeof body.autoRenew === 'boolean' ? body.autoRenew : null,
        ],
      );
      if (contacts && !uncertain) {
        for (const role of ['registrant', 'admin', 'tech', 'billing'] as const) {
          const existing = (
            await c.query(`SELECT id FROM domains.domain_contacts WHERE domain_id=$1 AND role=$2`, [
              id,
              role,
            ])
          ).rows[0] as Row | undefined;
          if (existing)
            await c.query(
              `UPDATE domains.domain_contacts SET payload_enc=$2, version=version+1, updated_at=now() WHERE id=$1`,
              [existing.id, await sealContact(this.cipher, existing.id as string, contacts[role])],
            );
          else {
            const cid = uuidv7();
            await c.query(
              `INSERT INTO domains.domain_contacts (id, org_id, domain_id, role, payload_enc) VALUES ($1,$2,$3,$4,$5)`,
              [cid, orgId, id, role, await sealContact(this.cipher, cid, contacts[role])],
            );
          }
        }
      }
      await enqueue(c, orgId, 'resource.state_changed', {
        resourceKind: 'domain',
        resourceId: id,
        state: row.state,
      });
    });
    const changed = Object.keys(body);
    await this.audit.record({
      action: contacts ? 'domain.contacts.updated' : 'domain.settings.updated',
      orgId,
      actorUserId: actor,
      resource: { type: 'domain', id },
      outcome: 'success',
      detail: { fields: changed, uncertain: !!uncertain },
    });
    const fresh = await this.get(orgId, id, true);
    delete fresh.contacts;
    delete fresh.contactsMasked;
    if (uncertain) {
      const op = await this.ops.create(orgId, {
        kind: OP_UPDATE,
        input: { domainId: id, fields: changed },
        resourceKind: 'domain',
        resourceId: id,
        createdBy: actor,
        traceId,
      });
      const claimed = await this.ops.claimById(orgId, op.id, 'domain-update');
      if (claimed)
        await this.ops.markNeedsReconcile(orgId, op.id, 'domain-update', 'provider_uncertain');
      return { status: 202, domain: fresh, operationId: op.id };
    }
    return { status: 200, domain: fresh };
  }

  /** Technical reconciliation of one domain: the registrar's state wins for the fields the registrar owns. Returns whether anything changed. */
  async sync(
    orgId: string,
    domainId: string,
    traceId = 'sync',
  ): Promise<{ changed: boolean; absent: boolean }> {
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM domains.domains WHERE id = $1`, [domainId])).rows[0] as
          Row | undefined,
    );
    if (!row || !row.provider_ref) return { changed: false, absent: false };
    const acc = await this.access.access(row.registrar_account_id as string, traceId);
    if (!acc) return { changed: false, absent: false };
    const r = await acc.adapter.inspect(acc.ctx, row.name as string);
    if (r.status !== 'succeeded') return { changed: false, absent: false };
    if (!r.data) return { changed: false, absent: true };
    const ref = r.data;
    const next = {
      nameservers: ref.nameservers.length ? ref.nameservers : (row.nameservers as string[]),
      locked: ref.locked ?? (row.locked as boolean),
      expires: ref.expiresAt ? new Date(ref.expiresAt) : (row.expires_at as Date | null),
      state:
        ref.state === 'expired'
          ? 'expired'
          : ref.state === 'redemption'
            ? 'redemption'
            : (row.state as string),
    };
    const differs =
      JSON.stringify(next.nameservers) !== JSON.stringify(row.nameservers) ||
      next.locked !== row.locked ||
      (next.expires?.getTime() ?? 0) !== ((row.expires_at as Date | null)?.getTime() ?? 0) ||
      next.state !== row.state;
    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `UPDATE domains.domains SET nameservers=$2, locked=$3, expires_at=$4, state=$5, last_provider_state=$6, last_synced_at=now(), version = version + CASE WHEN $7 THEN 1 ELSE 0 END, updated_at = CASE WHEN $7 THEN now() ELSE updated_at END WHERE id=$1`,
        [
          domainId,
          JSON.stringify(next.nameservers),
          next.locked,
          next.expires,
          next.state,
          ref.state,
          differs,
        ],
      );
      if (differs)
        await enqueue(c, orgId, 'resource.state_changed', {
          resourceKind: 'domain',
          resourceId: domainId,
          state: next.state,
        });
    });
    if (differs)
      await this.audit.record({
        action: 'domain.state.synced',
        orgId,
        resource: { type: 'domain', id: domainId },
        outcome: 'success',
        detail: { state: next.state },
      });
    return { changed: differs, absent: false };
  }
}
