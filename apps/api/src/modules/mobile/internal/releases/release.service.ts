import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { MobileProjectService } from '../../../builder';
import { hashOf, isUuid, iso, newId, onlyKeys, type Row } from '../core';
import type { MobileSpec } from '../flutter/spec';
import { copyLint, stringsOf } from './copy-lint';

export const STORES = ['google_play', 'app_store'] as const;
export type Store = (typeof STORES)[number];
export type ReleaseStatus = 'draft' | 'prepared' | 'owner_approved';
export interface ReleaseDto {
  id: string;
  projectId: string;
  buildId: string;
  versionName: string;
  versionCode: number;
  store: Store;
  status: ReleaseStatus;
  checklist: Record<string, unknown>;
  metadata: Record<string, unknown>;
  scopeHash: string | null;
  ownerApprovedBy: string | null;
  ownerApprovedAt: string | null;
  /** items still missing for `prepared` (always computed, so a client can show them) */
  missing: string[];
  createdAt: string;
  updatedAt: string;
  etag: number;
  /** what this record is and is not */
  notices: string[];
}
const BODY = [
  'projectId',
  'buildId',
  'versionName',
  'versionCode',
  'store',
  'checklist',
  'metadata',
  'status',
] as const;
const CHECKLIST_KEYS = ['privacyPolicyUrl', 'permissions', 'screenshots', 'compliance'] as const;
const COMPLIANCE_KEYS = [
  'dataSafetyReviewed',
  'ageRatingReviewed',
  'contentRightsConfirmed',
  'exportComplianceReviewed',
  'iapPolicy',
] as const;
const META_KEYS = [
  'title',
  'shortDescription',
  'fullDescription',
  'category',
  'keywords',
  'supportUrl',
] as const;
export const NOTICES = [
  'This record prepares a store release. Nuzm does not submit to any store and cannot predict the outcome of a store review.',
  'Submission is a human step in the store console, taken by the account owner after approving this record.',
];
const isHttps = (u: unknown): u is string => {
  if (typeof u !== 'string' || u.length > 300) return false;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname.includes('.') && !x.username && !x.password;
  } catch {
    return false;
  }
};
const bilingual = (v: unknown, max: number): boolean =>
  !!v &&
  typeof v === 'object' &&
  ['ar', 'en'].every(
    (k) =>
      typeof (v as Row)[k] === 'string' &&
      ((v as Row)[k] as string).trim().length > 0 &&
      ((v as Row)[k] as string).length <= max,
  );

const dto = (r: Row, missing: string[]): ReleaseDto => ({
  id: r.id as string,
  projectId: r.project_id as string,
  buildId: r.build_id as string,
  versionName: r.version_name as string,
  versionCode: r.version_code as number,
  store: r.store as Store,
  status: r.status as ReleaseStatus,
  checklist: r.checklist as Record<string, unknown>,
  metadata: r.metadata as Record<string, unknown>,
  scopeHash: (r.scope_hash as string | null) ?? null,
  ownerApprovedBy: (r.owner_approved_by as string | null) ?? null,
  ownerApprovedAt: iso(r.owner_approved_at),
  missing,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  etag: r.version as number,
  notices: NOTICES,
});

/**
 * Release-preparation records (`POST/GET /v1/mobile/releases`, S50). `draft` keeps whatever is entered (shape-checked); `prepared` needs EVERY checklist item and a SIGNED succeeded build
 * (so with no signing stage, HG-10-01, nothing can be prepared: reported as `missing`, never faked); `owner_approved` is an explicit act of the account owner bound to the hash of the exact
 * content (`scopeHash`): any change makes a NEW record. There is no submission action anywhere: `submissionExport` only assembles the manifest a human would use, and only after approval.
 */
export class ReleaseService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly projects: MobileProjectService,
    private readonly region: string,
  ) {}

  private async buildRow(orgId: string, buildId: string): Promise<Row | undefined> {
    return this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM mobile.builds WHERE id=$1`, [buildId])).rows[0] as
          Row | undefined,
    );
  }

  /** the items missing for `prepared` (empty = complete). Pure over its inputs. */
  missingItems(i: {
    build: Row;
    store: Store;
    checklist: Record<string, unknown>;
    metadata: Record<string, unknown>;
    locales: string[];
    declared: string[];
  }): string[] {
    const m: string[] = [];
    const cl = i.checklist;
    if (i.build.status !== 'succeeded') m.push('succeeded_build');
    if (i.build.signed !== true) m.push('signed_release_build');
    if (i.store === 'app_store' && i.build.platform !== 'ios') m.push('ios_build_for_app_store');
    if (i.store === 'google_play' && i.build.platform !== 'android')
      m.push('android_build_for_google_play');
    if (!isHttps(cl.privacyPolicyUrl)) m.push('privacy_policy_url');
    const perms = Array.isArray(cl.permissions) ? (cl.permissions as Row[]) : [];
    const named = new Set(
      perms
        .filter(
          (p) =>
            typeof p.permission === 'string' &&
            typeof p.justification === 'string' &&
            (p.justification as string).trim().length >= 5,
        )
        .map((p) => p.permission as string),
    );
    if (
      i.declared.some((d) => !named.has(d)) ||
      perms.some((p) => !i.declared.includes(p.permission as string))
    )
      m.push('permission_declarations_match_the_app');
    const shots = Array.isArray(cl.screenshots) ? (cl.screenshots as Row[]) : [];
    for (const l of i.locales)
      if (
        shots.filter(
          (s) =>
            s.locale === l && typeof s.ref === 'string' && /^[0-9a-f]{64}$/.test(String(s.sha256)),
        ).length < 2
      )
        m.push(`screenshots_${l}`);
    const comp = (cl.compliance ?? {}) as Row;
    for (const k of COMPLIANCE_KEYS) {
      if (k === 'iapPolicy') {
        const v = comp.iapPolicy;
        const ok =
          v === 'not_applicable' ||
          (!!v &&
            typeof v === 'object' &&
            typeof (v as Row).assessmentRef === 'string' &&
            ((v as Row).assessmentRef as string).length >= 3);
        if (!ok) m.push('compliance.iapPolicy');
      } else if (comp[k] !== true) m.push(`compliance.${k}`);
    }
    const md = i.metadata;
    if (!bilingual(md.title, 30)) m.push('metadata.title');
    if (!bilingual(md.shortDescription, 80)) m.push('metadata.shortDescription');
    if (!bilingual(md.fullDescription, 4000)) m.push('metadata.fullDescription');
    if (!isHttps(md.supportUrl)) m.push('metadata.supportUrl');
    return m;
  }

  private validateShape(b: Record<string, unknown>) {
    const extra = onlyKeys(b, BODY);
    if (extra.length)
      throw new ProblemException(
        'validation_failed',
        `unknown member(s): ${extra.slice(0, 5).join(', ')}`,
      );
    if (!isUuid(b.projectId))
      throw new ProblemException('validation_failed', 'projectId must be a uuid');
    if (!isUuid(b.buildId))
      throw new ProblemException('validation_failed', 'buildId must be a uuid');
    if (
      typeof b.versionName !== 'string' ||
      !/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]{1,30})?$/.test(b.versionName)
    )
      throw new ProblemException('validation_failed', 'versionName must look like 1.2.3');
    if (
      !Number.isInteger(b.versionCode) ||
      (b.versionCode as number) < 1 ||
      (b.versionCode as number) > 2_100_000_000
    )
      throw new ProblemException('validation_failed', 'versionCode must be a positive integer');
    if (!STORES.includes(b.store as Store))
      throw new ProblemException('validation_failed', 'store must be google_play or app_store');
    if (b.status !== undefined && b.status !== 'draft' && b.status !== 'prepared')
      throw new ProblemException(
        'validation_failed',
        'status must be draft or prepared (owner approval is a separate act)',
      );
    const checklist = (b.checklist ?? {}) as Record<string, unknown>;
    const metadata = (b.metadata ?? {}) as Record<string, unknown>;
    if (
      typeof checklist !== 'object' ||
      Array.isArray(checklist) ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata)
    )
      throw new ProblemException('validation_failed', 'checklist and metadata must be objects');
    const ce = onlyKeys(checklist, CHECKLIST_KEYS);
    if (ce.length)
      throw new ProblemException(
        'validation_failed',
        `unknown checklist member(s): ${ce.slice(0, 5).join(', ')}`,
      );
    const me = onlyKeys(metadata, META_KEYS);
    if (me.length)
      throw new ProblemException(
        'validation_failed',
        `unknown metadata member(s): ${me.slice(0, 5).join(', ')}`,
      );
    if (JSON.stringify(checklist).length > 40_000 || JSON.stringify(metadata).length > 40_000)
      throw new ProblemException('validation_failed', 'checklist or metadata is too large');
    // copy lint over every free-text member
    const hits = stringsOf([checklist, metadata]).flatMap((t) => copyLint(t));
    if (hits.length)
      throw new ProblemException(
        'validation_failed',
        'the text promises store approval or a way around store review; the platform cannot promise either',
        hits.map((h) => ({ rule: h.rule })),
      );
    return { checklist, metadata };
  }

  async create(orgId: string, userId: string, b: Record<string, unknown>): Promise<ReleaseDto> {
    const { checklist, metadata } = this.validateShape(b);
    const project = await this.projects.project(orgId, b.projectId as string);
    if (!project) throw new ProblemException('not_found', 'project not found');
    const build = await this.buildRow(orgId, (b.buildId as string).toLowerCase());
    if (!build || build.project_id !== project.id)
      throw new ProblemException('not_found', 'build not found');
    const src = await this.projects.sourceOf(orgId, project.id, build.version_id as string);
    const spec = src?.manifest.spec as MobileSpec | null | undefined;
    const declared = [
      'internet',
      ...((spec?.permissions ?? []) as string[]).filter((p) => p !== 'internet'),
    ];
    const store = b.store as Store;
    const missing = this.missingItems({
      build,
      store,
      checklist,
      metadata,
      locales: project.locales,
      declared,
    });
    const wanted = (b.status as ReleaseStatus | undefined) ?? 'draft';
    if (wanted === 'prepared' && missing.length)
      throw new ProblemException(
        'release_checklist_incomplete',
        `${missing.length} item(s) missing: ${missing.slice(0, 12).join(', ')}`,
        missing.map((m) => ({ item: m })),
      );
    const id = newId();
    const scopeHash =
      wanted === 'prepared'
        ? hashOf({
            projectId: project.id,
            buildId: build.id,
            versionName: b.versionName,
            versionCode: b.versionCode,
            store,
            checklist,
            metadata,
          })
        : null;
    let row: Row;
    try {
      row = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO mobile.releases (id, org_id, project_id, build_id, version_name, version_code, store, status, checklist, metadata, scope_hash, data_region, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
              [
                id,
                orgId,
                project.id,
                build.id,
                b.versionName,
                b.versionCode,
                store,
                wanted,
                JSON.stringify(checklist),
                JSON.stringify(metadata),
                scopeHash,
                this.region,
                userId,
              ],
            )
          ).rows[0] as Row,
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException(
          'conflict',
          'a release record with this store and version code already exists for the project',
        );
      throw e;
    }
    await this.audit.record({
      action: 'mobile.release.created',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'mobile_release', id },
      outcome: 'success',
      detail: { store, versionName: b.versionName, status: wanted },
    });
    return dto(row, missing);
  }

  async list(orgId: string, o: { projectId?: string } = {}): Promise<ReleaseDto[]> {
    return this.db.withOrg(orgId, async (c) =>
      (
        await c.query(
          `SELECT * FROM mobile.releases WHERE ($1::uuid IS NULL OR project_id=$1) ORDER BY created_at DESC, id DESC LIMIT 100`,
          [o.projectId && isUuid(o.projectId) ? o.projectId.toLowerCase() : null],
        )
      ).rows.map((r) => dto(r as Row, [])),
    );
  }
  async get(orgId: string, id: string): Promise<ReleaseDto> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM mobile.releases WHERE id=$1`, [id.toLowerCase()])).rows[0] as
          Row | undefined,
    );
    if (!r) throw new ProblemException('not_found');
    return dto(r, []);
  }

  /**
   * The account owner's approval (service level; its HTTP path needs SCR-M10B-02). `isOwner` comes from the verified access context (permission `mobile:release:approve`, owner role).
   * Bound to `scopeHash`: a stale hash (the record changed or a different record was meant) is 409. Approval is final: the row becomes immutable.
   */
  async ownerApprove(
    orgId: string,
    approver: { userId: string; isOwner: boolean },
    id: string,
    scopeHash: unknown,
  ): Promise<ReleaseDto> {
    if (!approver.isOwner)
      throw new ProblemException(
        'forbidden',
        'only the account owner can approve a release record',
      );
    if (typeof scopeHash !== 'string')
      throw new ProblemException('validation_failed', 'scopeHash is required');
    const cur = await this.get(orgId, id);
    if (cur.status === 'owner_approved') return cur; // idempotent
    if (cur.status !== 'prepared')
      throw new ProblemException(
        'release_checklist_incomplete',
        'only a prepared record can be approved',
      );
    if (cur.scopeHash !== scopeHash)
      throw new ProblemException(
        'conflict',
        'the approval is bound to different content (stale scopeHash)',
      );
    const recomputed = hashOf({
      projectId: cur.projectId,
      buildId: cur.buildId,
      versionName: cur.versionName,
      versionCode: cur.versionCode,
      store: cur.store,
      checklist: cur.checklist,
      metadata: cur.metadata,
    });
    if (recomputed !== cur.scopeHash)
      throw new ProblemException('conflict', 'the stored content no longer matches its hash');
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE mobile.releases SET status='owner_approved', owner_approved_by=$2, owner_approved_at=now() WHERE id=$1 AND status='prepared' RETURNING *`,
            [cur.id, approver.userId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!row) return this.get(orgId, id);
    await this.audit.record({
      action: 'release.owner.approved',
      actorUserId: approver.userId,
      actorType: 'user',
      orgId,
      resource: { type: 'mobile_release', id: cur.id },
      outcome: 'success',
      detail: { scopeHash, store: cur.store, versionName: cur.versionName },
    });
    return dto(row, []);
  }

  /** The manifest a human would use in the store console. Needs the owner's approval first. There is NO call to any store. */
  async submissionExport(orgId: string, id: string): Promise<Record<string, unknown>> {
    const r = await this.get(orgId, id);
    if (r.status !== 'owner_approved')
      throw new ProblemException(
        'owner_approval_required',
        'the account owner must approve this record first',
      );
    const artifacts = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT kind, file_name, sha256, size_bytes, signed FROM mobile.artifacts WHERE build_id=$1 ORDER BY created_at`,
            [r.buildId],
          )
        ).rows,
    );
    return {
      releaseId: r.id,
      store: r.store,
      versionName: r.versionName,
      versionCode: r.versionCode,
      scopeHash: r.scopeHash,
      ownerApprovedAt: r.ownerApprovedAt,
      artifacts,
      metadata: r.metadata,
      checklist: r.checklist,
      notices: NOTICES,
    };
  }
}
