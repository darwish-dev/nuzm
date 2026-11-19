import { scanForSecrets } from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { isUuid, iso, newId, onlyKeys, type Row } from '../core';

export const PLATFORMS = ['android', 'ios'] as const;
export type Platform = (typeof PLATFORMS)[number];
export interface SigningCredentialDto {
  id: string;
  platform: Platform;
  label: string;
  vaultRef: string;
  authorizedBy: string;
  authorizedAt: string;
  revokedAt: string | null;
  usable: boolean;
}
const VAULT_REF = /^vault:\/\/[A-Za-z0-9][A-Za-z0-9._/@:+-]{2,250}$/;
/** a long unbroken base64/hex-looking run is key material or a token, not a path */
const BLOB = /[A-Za-z0-9+/=_-]{48,}/;
const BODY_KEYS = ['platform', 'label', 'vaultRef', 'authorizedBy'] as const;

const dto = (r: Row): SigningCredentialDto => ({
  id: r.id as string,
  platform: r.platform as Platform,
  label: r.label as string,
  vaultRef: r.vault_ref as string,
  authorizedBy: r.authorized_by as string,
  authorizedAt: iso(r.authorized_at)!,
  revokedAt: iso(r.revoked_at),
  usable: r.revoked_at === null,
});

/**
 * The signing stage (a worker that project code cannot reach: HG-10-01 / D-22). It would receive SHORT-LIVED material for a credential reference at signing time, sign, and discard it.
 * No vault and no signing material exist in this repository, so production has only `UnavailableSigningStage` (503 `signing_unavailable`); `RecordingSigningStage` is a TEST double
 * that proves the contract (material is never logged, never copied into artifacts or into the build environment of project code). It signs nothing for real.
 */
export interface SigningRequest {
  orgId: string;
  buildId: string;
  platform: Platform;
  vaultRef: string;
  artifactSha256: string;
}
export abstract class SigningStagePort {
  abstract readonly kind: string;
  abstract available(): boolean;
  abstract sign(r: SigningRequest, log: (line: string) => void): Promise<{ signedSha256: string; verified: boolean }>;
}
export class UnavailableSigningStage extends SigningStagePort {
  readonly kind = 'unavailable';
  available() {
    return false;
  }
  async sign(): Promise<never> {
    throw new ProblemException('signing_unavailable', 'no signing stage is connected (HG-10-01 pending)');
  }
}

/**
 * Credential REFERENCES (`POST/GET /v1/mobile/signing-credentials`, S49.3): the body is closed (`platform`, `label`, `vaultRef`, `authorizedBy`); anything that looks like key material,
 * a password, a token or a PEM block is refused (422 `raw_secret_rejected`) and the value is NEVER echoed or logged. `authorizedBy` must be the caller: nobody authorizes in another
 * person's name. Owner/admin only (permission `mobile:signing`, catalogue in M01).
 */
export class SigningService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly region: string,
  ) {}

  /** structural + content checks; throws without ever including a value in the message */
  validate(userId: string, b: Record<string, unknown>) {
    const extra = onlyKeys(b, BODY_KEYS);
    if (extra.length)
      throw new ProblemException(
        'raw_secret_rejected',
        `unknown member(s) ${extra.slice(0, 5).map((k) => k.slice(0, 30)).join(', ')}: only a vault reference is accepted, never key material`,
      );
    const platform = b.platform;
    if (platform !== 'android' && platform !== 'ios')
      throw new ProblemException('validation_failed', 'platform must be android or ios');
    const label = typeof b.label === 'string' ? b.label.trim() : '';
    if (label.length < 1 || label.length > 100)
      throw new ProblemException('validation_failed', 'label must be 1..100 characters');
    const vaultRef = typeof b.vaultRef === 'string' ? b.vaultRef.trim() : '';
    if (!VAULT_REF.test(vaultRef))
      throw new ProblemException('validation_failed', 'vaultRef must be a vault:// reference');
    // anything key-like in any member: PEM blocks, tokens, assignments, base64 blobs
    const flat: [string, string][] = [
      ['label', label],
      ['vaultRef', vaultRef.replace(/^vault:\/\//, 'ref/')],
    ];
    for (const [member, v] of flat)
      if (scanForSecrets(v).length > 0 || BLOB.test(v) || /-----BEGIN/.test(v))
        throw new ProblemException('raw_secret_rejected', `${member} looks like a secret or key material; send a vault reference only`);
    if (b.authorizedBy !== userId)
      throw new ProblemException('validation_failed', 'authorizedBy must be the authenticated user');
    return { platform: platform as Platform, label, vaultRef };
  }

  async create(orgId: string, userId: string, b: Record<string, unknown>): Promise<SigningCredentialDto> {
    const v = this.validate(userId, b);
    const id = newId();
    let row: Row;
    try {
      row = await this.db.withOrg(orgId, async (c) =>
        (
          await c.query(
            `INSERT INTO mobile.signing_credential_refs (id, org_id, platform, label, vault_ref, authorized_by, data_region) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [id, orgId, v.platform, v.label, v.vaultRef, userId, this.region],
          )
        ).rows[0] as Row,
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'an active credential with this label already exists for the platform');
      throw e;
    }
    await this.audit.record({
      action: 'signing.credential.authorized',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'mobile_signing_credential', id },
      outcome: 'success',
      detail: { platform: v.platform, label: v.label }, // never the reference value
    });
    return dto(row);
  }

  async list(orgId: string): Promise<SigningCredentialDto[]> {
    return this.db.withOrg(orgId, async (c) =>
      (
        await c.query(`SELECT * FROM mobile.signing_credential_refs ORDER BY created_at DESC, id DESC LIMIT 200`)
      ).rows.map((r) => dto(r as Row)),
    );
  }

  /** the credential a release build would use: the newest usable one of the platform (null = none authorized) */
  async activeFor(orgId: string, platform: Platform): Promise<SigningCredentialDto | null> {
    return this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(
          `SELECT * FROM mobile.signing_credential_refs WHERE platform=$1 AND revoked_at IS NULL ORDER BY authorized_at DESC, id DESC LIMIT 1`,
          [platform],
        )
      ).rows[0] as Row | undefined;
      return r ? dto(r) : null;
    });
  }
  async get(orgId: string, id: string): Promise<SigningCredentialDto | null> {
    if (!isUuid(id)) return null;
    return this.db.withOrg(orgId, async (c) => {
      const r = (await c.query(`SELECT * FROM mobile.signing_credential_refs WHERE id=$1`, [id.toLowerCase()])).rows[0] as Row | undefined;
      return r ? dto(r) : null;
    });
  }
}
