import { Module } from '@nestjs/common';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { IdentityModule } from '../identity';
import { AdminKnowledgeResourcesController } from './admin-knowledge-resources.controller';
import { AdminKnowledgeUploadsController } from './admin-knowledge-uploads.controller';
import { KnowledgeLibraryGuard } from './internal/flag';
import {
  FsObjectStore,
  KnowledgeObjectStore,
  UnconfiguredObjectStore,
} from './internal/object-store';
import { ResourceService } from './internal/resource.service';
import { UploadService } from './internal/upload.service';

/**
 * AI Intelligence Center (ADR-065, SCR-K-01), slice S-K1: the library foundation. Admin uploads (resumable, quarantined), resources, versions, metadata,
 * disable and archive, behind the platform-wide flag `knowledge.library` (default OFF). Ingestion, analysis, retrieval and the customer experience are later slices.
 * The object store is the development filesystem adapter outside production and "unconfigured" in production until the provider is chosen (D-42).
 */
@Module({
  imports: [IdentityModule],
  controllers: [AdminKnowledgeUploadsController, AdminKnowledgeResourcesController],
  providers: [
    KnowledgeLibraryGuard,
    {
      provide: KnowledgeObjectStore,
      useFactory: (): KnowledgeObjectStore =>
        process.env.NODE_ENV === 'production'
          ? new UnconfiguredObjectStore()
          : new FsObjectStore(
              process.env.KNOWLEDGE_STORE_DIR ?? join(tmpdir(), 'nuzm-knowledge-store'),
            ),
    },
    {
      provide: UploadService,
      useFactory: (db: Db, audit: AuditSink, store: KnowledgeObjectStore) =>
        new UploadService(db, audit, store),
      inject: [DB, AuditSink, KnowledgeObjectStore],
    },
    {
      provide: ResourceService,
      useFactory: (db: Db, audit: AuditSink) => new ResourceService(db, audit),
      inject: [DB, AuditSink],
    },
  ],
  exports: [ResourceService, UploadService, KnowledgeObjectStore],
})
export class KnowledgeModule {}
