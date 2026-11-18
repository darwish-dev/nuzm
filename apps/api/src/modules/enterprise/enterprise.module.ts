import { Module } from '@nestjs/common';
import { HmacCheckpointSigner, type CheckpointSigner, type Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { ComplianceModule, RetentionService } from '../compliance';
import { DnsTxtLookup, DomainsModule } from '../domains';
import { IdentityModule, SessionService } from '../identity';
import { MemberService, TenancyModule } from '../tenancy';
import { AccessReviewService } from './access-reviews.service';
import { AuditAssuranceService } from './audit-assurance.service';
import { AuditRetentionService } from './audit-retention.service';
import { AccessReviewsController } from './access-reviews.controller';
import { AuditRetentionController } from './audit-retention.controller';
import { PolicyVersionsController } from './policy-versions.controller';
import { SsoConnectionsController } from './sso-connections.controller';
import { EnterpriseFlags } from './flags';
import { PolicyVersionService } from './policy-versions.service';
import { DnsTxtResolver, MetadataFetcher, NodeDnsTxtResolver, SafeMetadataFetcher } from './ports';
import { ScimAuthGuard, ScimController } from './scim/scim.controller';
import { ScimService } from './scim/scim.service';
import { ScimTokenService } from './scim/scim-tokens.service';
import { SsoConnectionService } from './sso-connections.service';

/** DEV stand-in until the vault (D-12): same env var as the worker's audit checkpoint job; refuses to run in production without it. */
function signer(): CheckpointSigner {
  if (process.env.AUDIT_CHECKPOINT_KEY) return HmacCheckpointSigner.fromEnv();
  if (process.env.NODE_ENV === 'production')
    throw new Error('missing required env AUDIT_CHECKPOINT_KEY');
  return new HmacCheckpointSigner(
    new Uint8Array(Buffer.from('nuzm-dev-only-audit-checkpoint-key-not-secret!')),
  );
}
export const CHECKPOINT_SIGNER = Symbol('CHECKPOINT_SIGNER');
const baseUrl = () => (process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

/**
 * M12 enterprise IAM: SSO connections (SAML/OIDC), SCIM 2.0, access reviews, audit retention/assurance and policy versions.
 * Feature flags default OFF: nothing here is reachable until the owner enables it per organization (`enterprise.sso`, `enterprise.scim`).
 */
@Module({
  imports: [IdentityModule, TenancyModule, DomainsModule, ComplianceModule],
  controllers: [
    SsoConnectionsController,
    ScimController,
    AccessReviewsController,
    AuditRetentionController,
    PolicyVersionsController,
  ],
  providers: [
    { provide: EnterpriseFlags, useFactory: (db: Db) => new EnterpriseFlags(db), inject: [DB] },
    { provide: MetadataFetcher, useClass: SafeMetadataFetcher },
    { provide: DnsTxtResolver, useClass: NodeDnsTxtResolver },
    { provide: CHECKPOINT_SIGNER, useFactory: signer },
    {
      provide: SsoConnectionService,
      useFactory: (
        db: Db,
        a: AuditSink,
        f: MetadataFetcher,
        o: DnsTxtLookup,
        p: DnsTxtResolver,
        m: MemberService,
      ) => new SsoConnectionService(db, a, f, o, p, m),
      inject: [DB, AuditSink, MetadataFetcher, DnsTxtLookup, DnsTxtResolver, MemberService],
    },
    {
      provide: ScimTokenService,
      useFactory: (db: Db, a: AuditSink) => new ScimTokenService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: ScimService,
      useFactory: (db: Db, a: AuditSink, m: MemberService, s: SessionService) =>
        new ScimService(db, a, m, s, baseUrl),
      inject: [DB, AuditSink, MemberService, SessionService],
    },
    ScimAuthGuard,
    {
      provide: AccessReviewService,
      useFactory: (db: Db, a: AuditSink, m: MemberService, s: SessionService) =>
        new AccessReviewService(db, a, m, s),
      inject: [DB, AuditSink, MemberService, SessionService],
    },
    {
      provide: AuditAssuranceService,
      useFactory: (db: Db, s: CheckpointSigner) => new AuditAssuranceService(db, s),
      inject: [DB, CHECKPOINT_SIGNER],
    },
    {
      provide: AuditRetentionService,
      useFactory: (db: Db, r: RetentionService, a: AuditSink) =>
        new AuditRetentionService(db, r, a),
      inject: [DB, RetentionService, AuditSink],
    },
    {
      provide: PolicyVersionService,
      useFactory: (db: Db, a: AuditSink) => new PolicyVersionService(db, a),
      inject: [DB, AuditSink],
    },
  ],
  exports: [
    SsoConnectionService,
    ScimTokenService,
    ScimService,
    AccessReviewService,
    AuditAssuranceService,
    AuditRetentionService,
    PolicyVersionService,
  ],
})
export class EnterpriseModule {}
