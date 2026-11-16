import { Global, Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './internal/audit-query.service';
import { DbAuditSink } from './internal/db-audit.sink';

/** `AUDIT_HASH_KEY` (base64, >= 32 bytes) keys the IP/UA hashes. DEV stand-in until the vault (D-12). */
function hashKey(): Uint8Array {
  const raw = process.env.AUDIT_HASH_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === 'production')
      throw new Error('missing required env AUDIT_HASH_KEY');
    return new Uint8Array(Buffer.from('nuzm-dev-only-audit-hash-key-not-secret'));
  }
  const k = Buffer.from(raw, 'base64');
  if (k.length < 32) throw new Error('AUDIT_HASH_KEY must be at least 32 bytes, base64-encoded');
  return new Uint8Array(k);
}

@Global()
@Module({
  controllers: [AuditController],
  providers: [
    {
      provide: AuditSink,
      useFactory: (db: Db) => new DbAuditSink(db, hashKey()),
      inject: [DB],
    },
    { provide: AuditQueryService, useFactory: (db: Db) => new AuditQueryService(db), inject: [DB] },
  ],
  exports: [AuditSink, AuditQueryService],
})
export class AuditModule {}
