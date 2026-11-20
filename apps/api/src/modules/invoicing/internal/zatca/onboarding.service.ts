import { v7 as uuidv7 } from 'uuid';
import { randomUUID } from 'node:crypto';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import {
  EInvoiceAuthError,
  EInvoiceTimeout,
  EInvoiceUnavailable,
  type EInvoiceAdapter,
  type SubmitDoc,
} from './adapter';
import { buildDocument, type ZatcaDocument } from './build-document';
import { buildCsr } from './csr';
import { documentHash, firstPih } from './hash-chain';
import { encodeTlv } from './qr-tlv';
import type { SecretStore } from './secrets';
import { signDocumentHash, type KeyVault } from './signing';
import { assemble, buildBody } from './ubl';
import { validateDocument } from './validator';
import type { ZatcaDocumentService } from './zatca-document.service';
import { UUID } from '@nuzm/domain';

type Row = Record<string, unknown>;
export const STEPS = ['csr', 'compliance_csid', 'compliance_checks', 'production_csid'] as const;
export type OnboardingStep = (typeof STEPS)[number];
/** Steps that create or request credentials need two people (docs/04): one requests, a different one approves. */
const CREDENTIAL_STEPS: OnboardingStep[] = ['csr', 'compliance_csid', 'production_csid'];
/** Only the compliance credential is authorised by a portal one-time password; the production credential is requested with the compliance credential. */
const NEEDS_OTP: OnboardingStep[] = ['compliance_csid'];

export interface OnboardingStepDto {
  id: string;
  environment: 'sandbox' | 'simulation';
  step: OnboardingStep;
  status: 'pending_approval' | 'completed' | 'failed' | 'rejected';
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  result: Record<string, unknown>;
  createdAt: string;
}
export interface OnboardingView {
  environment: 'sandbox' | 'simulation';
  /** Where the onboarding stands: the last completed step, or not_started. */
  state: 'not_started' | OnboardingStep;
  onboarded: boolean;
  /** Always true: nothing here is verified against ZATCA. */
  notVerifiedVsZatca: boolean;
  credentials: { kind: string; serial: string | null; expiresAt: string | null }[];
  steps: OnboardingStepDto[];
}
const dto = (r: Row): OnboardingStepDto => ({
  id: r.id as string,
  environment: r.environment as 'sandbox' | 'simulation',
  step: r.step as OnboardingStep,
  status: r.status as OnboardingStepDto['status'],
  requestedBy: r.requested_by as string,
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at ? (r.decided_at as Date).toISOString() : null,
  result: r.result as Record<string, unknown>,
  createdAt: (r.created_at as Date).toISOString(),
});

/**
 * E-invoicing onboarding (docs/11 §5): CSR → compliance credential → compliance checks → production credential, per billing entity and
 * environment, against the SIMULATED server only. The rules that matter:
 *  - **Two people** for every credential step: the requester cannot approve (service and database both refuse).
 *  - **Order is enforced** and a completed step cannot be redone (409).
 *  - **No secrets stored**: the OTP is used once and never persisted or logged; credential tokens and secrets go to the vault by reference; only
 *    references and public facts reach the database.
 *  - **Only the enabled environment**: `production` is never enabled by this code (it needs HG-03-03 evidence and the owner's decision).
 */
export class ZatcaOnboardingService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly docs: Pick<ZatcaDocumentService, 'mode' | 'profile'>,
    private readonly adapter: EInvoiceAdapter,
    private readonly vault: KeyVault & { generateTestKey(ref: string): Promise<void> },
    private readonly secrets: SecretStore,
  ) {}

  private env(v: unknown): 'sandbox' | 'simulation' {
    if (v === 'production')
      throw new ProblemException(
        'validation_failed',
        'production onboarding is not enabled: it needs HG-03-03 evidence recorded by the owner',
      );
    if (v !== 'sandbox' && v !== 'simulation')
      throw new ProblemException(
        'validation_failed',
        "environment must be 'sandbox' or 'simulation'",
      );
    if (this.docs.mode !== v)
      throw new ProblemException(
        'validation_failed',
        `environment ${v} is not enabled (ZATCA_MODE=${this.docs.mode})`,
      );
    return v;
  }
  private async entity(): Promise<Row> {
    const e = await this.db.withoutScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM invoicing.billing_entities WHERE status = 'active' ORDER BY created_at, id LIMIT 1`,
          )
        ).rows[0],
    );
    if (!e)
      throw new ProblemException('service_unavailable', 'no active billing entity is configured');
    return e as Row;
  }

  async view(environment?: string): Promise<OnboardingView[]> {
    const envs: ('sandbox' | 'simulation')[] = environment
      ? [this.env(environment)]
      : this.docs.mode === 'off'
        ? []
        : [this.docs.mode];
    const entity = await this.entity();
    return this.db.withPlatformScope(async (c) => {
      const out: OnboardingView[] = [];
      for (const env of envs) {
        const steps = (
          await c.query(
            `SELECT * FROM invoicing.zatca_onboarding WHERE entity_id = $1 AND environment = $2 ORDER BY created_at, id`,
            [entity.id, env],
          )
        ).rows as Row[];
        const done = new Set(
          steps.filter((s) => s.status === 'completed').map((s) => s.step as OnboardingStep),
        );
        const last = [...STEPS].reverse().find((s) => done.has(s));
        const creds = (
          await c.query(
            `SELECT kind, serial, expires_at FROM invoicing.zatca_credentials_refs WHERE entity_id = $1 AND environment = $2 AND status = 'active' ORDER BY created_at`,
            [entity.id, env],
          )
        ).rows as Row[];
        out.push({
          environment: env,
          state: last ?? 'not_started',
          onboarded: done.has('production_csid'),
          notVerifiedVsZatca: this.docs.profile.synthetic,
          credentials: creds.map((r) => ({
            kind: r.kind as string,
            serial: (r.serial as string | null) ?? null,
            expiresAt: r.expires_at ? (r.expires_at as Date).toISOString() : null,
          })),
          steps: steps.map(dto),
        });
      }
      return out;
    });
  }

  private async assertOrder(entityId: string, env: string, step: OnboardingStep): Promise<void> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT step, status FROM invoicing.zatca_onboarding WHERE entity_id = $1 AND environment = $2 AND status IN ('completed','pending_approval')`,
            [entityId, env],
          )
        ).rows as Row[],
    );
    if (rows.some((r) => r.status === 'pending_approval'))
      throw new ProblemException('conflict', 'another onboarding step is waiting for approval');
    const done = new Set(
      rows.filter((r) => r.status === 'completed').map((r) => r.step as OnboardingStep),
    );
    if (done.has(step))
      throw new ProblemException('conflict', `the ${step} step is already completed`);
    const i = STEPS.indexOf(step);
    if (i > 0 && !done.has(STEPS[i - 1]!))
      throw new ProblemException('conflict', `the ${STEPS[i - 1]} step must be completed first`);
  }

  /** Request a step. Credential steps wait for a second person; the compliance checks run at once. */
  async request(actorUserId: string, input: Record<string, unknown>): Promise<OnboardingStepDto> {
    for (const k of Object.keys(input))
      if (k !== 'environment' && k !== 'step')
        throw new ProblemException('validation_failed', `unknown field ${k}`);
    const env = this.env(input.environment);
    if (typeof input.step !== 'string' || !(STEPS as readonly string[]).includes(input.step))
      throw new ProblemException('validation_failed', `step must be one of ${STEPS.join(', ')}`);
    const step = input.step as OnboardingStep;
    const entity = await this.entity();
    await this.assertOrder(entity.id as string, env, step);
    const id = uuidv7();
    try {
      await this.db.withPlatformScope(async (c) => {
        await c.query(
          `INSERT INTO invoicing.zatca_onboarding (id, entity_id, environment, step, requested_by) VALUES ($1,$2,$3,$4,$5)`,
          [id, entity.id, env, step, actorUserId],
        );
        await this.audit.record({
          action: 'invoicing.zatca_onboarding.requested',
          actorUserId,
          resource: { type: 'zatca_onboarding', id },
          outcome: 'success',
          after: { environment: env, step },
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'another onboarding step is waiting for approval');
      throw e;
    }
    if (CREDENTIAL_STEPS.includes(step)) return this.get(id);
    return this.run(id, actorUserId, undefined); // compliance_checks: no credential is created, one person may run it
  }

  /** A second person approves (and supplies the one-time password where the step needs one) or rejects a pending credential step. */
  async decide(approverId: string, input: Record<string, unknown>): Promise<OnboardingStepDto> {
    for (const k of Object.keys(input))
      if (!['stepId', 'decision', 'otp'].includes(k))
        throw new ProblemException('validation_failed', `unknown field ${k}`);
    if (typeof input.stepId !== 'string' || !UUID.test(input.stepId))
      throw new ProblemException('validation_failed', 'stepId must be a uuid');
    if (input.decision !== 'approve' && input.decision !== 'reject')
      throw new ProblemException('validation_failed', "decision must be 'approve' or 'reject'");
    if (input.otp !== undefined && (typeof input.otp !== 'string' || input.otp.length > 20))
      throw new ProblemException('validation_failed', 'otp must be a short string');
    const row = await this.row(input.stepId.toLowerCase());
    if (row.status !== 'pending_approval')
      throw new ProblemException('conflict', `this step is already ${row.status as string}`);
    if (row.requested_by === approverId)
      throw new ProblemException(
        'forbidden',
        'a second person must approve this step (two-person rule)',
      );
    if (input.decision === 'reject') {
      await this.db.withPlatformScope(async (c) => {
        await c.query(
          `UPDATE invoicing.zatca_onboarding SET status = 'rejected', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = $1 AND status = 'pending_approval'`,
          [row.id, approverId],
        );
        await this.audit.record({
          action: 'invoicing.zatca_onboarding.rejected',
          actorUserId: approverId,
          resource: { type: 'zatca_onboarding', id: row.id as string },
          outcome: 'success',
        });
      });
      return this.get(row.id as string);
    }
    if (NEEDS_OTP.includes(row.step as OnboardingStep) && !input.otp)
      throw new ProblemException(
        'validation_failed',
        'the one-time password from the portal is required for this step (HG-03-03)',
      );
    return this.run(row.id as string, approverId, input.otp as string | undefined);
  }

  private async row(id: string): Promise<Row> {
    const r = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM invoicing.zatca_onboarding WHERE id = $1`, [id])).rows[0],
    );
    if (!r) throw new ProblemException('not_found');
    return r as Row;
  }
  async get(id: string): Promise<OnboardingStepDto> {
    return dto(await this.row(id));
  }

  /** Perform the step. The OTP lives only in this call: it is passed to the server and never stored, logged or returned. */
  private async run(
    id: string,
    actorUserId: string,
    otp: string | undefined,
  ): Promise<OnboardingStepDto> {
    const row = await this.row(id);
    const env = row.environment as 'sandbox' | 'simulation';
    const step = row.step as OnboardingStep;
    const entity = await this.entity();
    let status: 'completed' | 'failed' = 'completed';
    let result: Record<string, unknown> = {};
    try {
      result = await this.perform(step, env, entity, id, otp);
    } catch (e) {
      status = 'failed';
      result = {
        error:
          e instanceof ProblemException
            ? (e.detail ?? 'step refused')
            : e instanceof EInvoiceAuthError
              ? e.message
              : e instanceof EInvoiceUnavailable || e instanceof EInvoiceTimeout
                ? 'the e-invoicing service did not answer; request the step again'
                : 'the step failed',
      };
    }
    await this.db.withPlatformScope(async (c) => {
      await c.query(
        `UPDATE invoicing.zatca_onboarding SET status = $2, decided_by = $3, decided_at = now(), result = $4, updated_at = now() WHERE id = $1 AND status = 'pending_approval'`,
        [
          id,
          status,
          actorUserId,
          JSON.stringify({ ...result, notVerifiedVsZatca: this.docs.profile.synthetic }),
        ],
      );
      await this.audit.record({
        action: `invoicing.zatca_onboarding.${status}`,
        actorUserId,
        resource: { type: 'zatca_onboarding', id },
        outcome: status === 'completed' ? 'success' : 'failure',
        detail: { environment: env, step },
      });
    });
    return this.get(id);
  }

  private async cred(entityId: string, env: string, kind: string): Promise<Row | undefined> {
    return this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM invoicing.zatca_credentials_refs WHERE entity_id = $1 AND environment = $2 AND kind = $3 AND status = 'active'`,
            [entityId, env, kind],
          )
        ).rows[0],
    );
  }
  private async insertCredential(
    entityId: string,
    env: string,
    kind: string,
    keyRef: string,
    tokenRef: string | null,
    secretRef: string | null,
    serial: string | null,
    expiresAt: Date | null,
    onboardingId: string,
  ) {
    await this.db.withPlatformScope((c) =>
      c.query(
        `INSERT INTO invoicing.zatca_credentials_refs (id, entity_id, environment, kind, key_ref, token_ref, secret_ref, serial, expires_at, onboarding_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          uuidv7(),
          entityId,
          env,
          kind,
          keyRef,
          tokenRef,
          secretRef,
          serial,
          expiresAt,
          onboardingId,
        ],
      ),
    );
  }
  private async resolve(tokenRef: string, secretRef: string) {
    return { token: await this.secrets.get(tokenRef), secret: await this.secrets.get(secretRef) };
  }

  private async perform(
    step: OnboardingStep,
    env: 'sandbox' | 'simulation',
    entity: Row,
    onboardingId: string,
    otp: string | undefined,
  ): Promise<Record<string, unknown>> {
    const entityId = entity.id as string;
    const short = entityId.replace(/-/g, '').slice(0, 8);
    if (step === 'csr') {
      const keyRef = `vault://dev/zatca/egs-${env}-${short}-${onboardingId.replace(/-/g, '').slice(-8)}`;
      await this.vault.generateTestKey(keyRef); // a SELF-GENERATED TEST key: the vault choice and real key custody are D-12
      const { pem } = await buildCsr(this.vault, keyRef, {
        commonName: `EGS-${env}-${short}`,
        organization: String(entity.legal_name_en),
        organizationalUnit: 'E-invoicing',
        country: 'SA',
        serialNumber: `1-Nuzm|2-${env}|3-${short}`,
      });
      await this.insertCredential(
        entityId,
        env,
        'csr_key',
        keyRef,
        null,
        null,
        null,
        null,
        onboardingId,
      );
      return { csrPem: pem };
    }
    const csrKey = await this.cred(entityId, env, 'csr_key');
    if (!csrKey)
      throw new ProblemException('conflict', 'no CSR key exists; complete the csr step first');
    if (step === 'compliance_csid') {
      const csr = await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query(
              `SELECT result FROM invoicing.zatca_onboarding WHERE entity_id = $1 AND environment = $2 AND step = 'csr' AND status = 'completed'`,
              [entityId, env],
            )
          ).rows[0],
      );
      const issued = await this.adapter.requestComplianceCsid({
        csrPem: (csr!.result as { csrPem: string }).csrPem,
        otp: otp!,
      });
      const tokenRef = `vault://dev/zatca/csid-${env}-${short}-c-${onboardingId.replace(/-/g, '').slice(-8)}-t`;
      const secretRef = tokenRef.replace(/-t$/, '-s');
      await this.secrets.put(tokenRef, issued.token);
      await this.secrets.put(secretRef, issued.secret);
      await this.insertCredential(
        entityId,
        env,
        'compliance_csid',
        csrKey.key_ref as string,
        tokenRef,
        secretRef,
        issued.serial,
        issued.expiresAt,
        onboardingId,
      );
      return { serial: issued.serial, expiresAt: issued.expiresAt.toISOString() };
    }
    const compliance = await this.cred(entityId, env, 'compliance_csid');
    if (!compliance) throw new ProblemException('conflict', 'no compliance credential exists');
    const cred = await this.resolve(
      compliance.token_ref as string,
      compliance.secret_ref as string,
    );
    if (step === 'compliance_checks') {
      const checks: {
        documentType: string;
        subtype: string;
        status: string;
        warnings: number;
        errors: string[];
      }[] = [];
      for (const doc of this.samples(entity)) {
        const issues = validateDocument(this.docs.profile, doc).issues.filter(
          (i) => i.severity === 'error',
        );
        if (issues.length)
          throw new ProblemException(
            'validation_failed',
            `the sample ${doc.type}/${doc.subtype} does not validate: ${issues.map((i) => i.code).join(', ')} (is the billing entity registered? HG-03-01)`,
          );
        const r = await this.adapter.complianceCheck(
          cred,
          await this.stampSample(doc, csrKey.key_ref as string),
        );
        checks.push({
          documentType: doc.type,
          subtype: doc.subtype,
          status: r.status,
          warnings: r.warnings.length,
          errors: r.errors.map((e) => e.code),
        });
      }
      if (checks.some((c) => c.status === 'rejected'))
        throw new ProblemException(
          'validation_failed',
          `compliance checks failed: ${checks
            .filter((c) => c.status === 'rejected')
            .map((c) => `${c.documentType}/${c.subtype}`)
            .join(', ')}`,
        );
      return { checks };
    }
    // production_csid
    const issued = await this.adapter.requestProductionCsid(cred);
    const tokenRef = `vault://dev/zatca/csid-${env}-${short}-p-${onboardingId.replace(/-/g, '').slice(-8)}-t`;
    const secretRef = tokenRef.replace(/-t$/, '-s');
    await this.secrets.put(tokenRef, issued.token);
    await this.secrets.put(secretRef, issued.secret);
    await this.insertCredential(
      entityId,
      env,
      'production_csid',
      csrKey.key_ref as string,
      tokenRef,
      secretRef,
      issued.serial,
      issued.expiresAt,
      onboardingId,
    );
    return { serial: issued.serial, expiresAt: issued.expiresAt.toISOString() };
  }

  /** Synthetic sample documents for the compliance checks: never stored, never part of the chain, fictional buyer. */
  private samples(entity: Row): ZatcaDocument[] {
    const seller = {
      legalName: { ar: entity.legal_name_ar, en: entity.legal_name_en },
      vatNumber: entity.vat_number,
      crNumber: entity.cr_number,
      address: entity.address,
    };
    const buyerB2b = {
      buyerType: 'b2b',
      legalName: { ar: 'عميل تجريبي', en: 'Sample Buyer' },
      vatNumber: '399999999999993',
      address: { city: 'Riyadh', country: 'SA' },
    };
    const buyerB2c = {
      buyerType: 'b2c',
      legalName: { ar: 'عميل', en: 'Consumer' },
      vatNumber: null,
      address: {},
    };
    const lines = [
      {
        quantity: '1',
        unit: 'sample',
        description: 'Sample item',
        netMinor: '10000',
        taxMinor: '1500',
        rateBps: 1500,
      },
    ];
    const base = {
      uuid: randomUUID(),
      icv: 1n,
      pih: firstPih(this.docs.profile),
      issuedAt: new Date(),
      currency: 'SAR',
      seller,
      lines,
    };
    return [
      buildDocument(this.docs.profile, {
        ...base,
        type: 'invoice',
        number: 'SAMPLE-STD-1',
        buyer: buyerB2b,
      }),
      buildDocument(this.docs.profile, {
        ...base,
        uuid: randomUUID(),
        type: 'invoice',
        number: 'SAMPLE-SIMP-1',
        buyer: buyerB2c,
      }),
      buildDocument(this.docs.profile, {
        ...base,
        uuid: randomUUID(),
        type: 'credit_note',
        number: 'SAMPLE-CN-1',
        buyer: buyerB2b,
        reference: { number: 'SAMPLE-STD-1', reason: 'sample' },
      }),
    ];
  }
  private async stampSample(doc: ZatcaDocument, keyRef: string): Promise<SubmitDoc> {
    const body = buildBody(this.docs.profile, doc);
    const hash = documentHash(body);
    const { signature, publicKey } = await signDocumentHash(this.vault, keyRef, hash);
    const qr = encodeTlv([
      { tag: 1, value: Buffer.from(doc.seller.nameEn) },
      { tag: 6, value: Buffer.from(hash) },
    ]);
    return {
      uuid: doc.uuid,
      hash,
      type: doc.type,
      subtype: doc.subtype,
      xml: assemble(body, qr, signature, publicKey),
    };
  }
}
