import { ProblemException } from '../../../common/errors';

/**
 * Where a version's artifact lives. M11 reads a publisher's artifact ONCE at submission (to hash and scan it) and once at install (to copy it). The real store (object storage
 * through M08 `/v1/storage/buckets`, or the builder's export) is NOT on this base: the default answers `unsupported_capability`, tests inject an in-memory store. NOT VERIFIED.
 */
export abstract class ArtifactStore {
  abstract read(ref: string): Promise<Buffer>;
}
export class UnavailableArtifactStore extends ArtifactStore {
  read(): Promise<never> {
    return Promise.reject(new ProblemException('unsupported_capability', 'no artifact store is configured on this deployment'));
  }
}

/**
 * Installing a website or app template creates a `builder.projects` row in the BUYER's organization (a copy, new id). `builder.*` is owned by M09 and is NOT on this base, so this is a port:
 * the default answers `unsupported_capability`; tests inject a fake. Wiring the real M09 service is one provider change (docs/reports/M11-m09-interface-assumptions.md). NOT VERIFIED.
 */
export abstract class ProjectInstallPort {
  abstract install(i: {
    buyerOrgId: string;
    workspaceId: string;
    type: 'website-template' | 'app-template';
    artifactRef: string;
    contentHash: string;
    dataRegion: string;
    actorUserId: string;
    idempotencyKey: string;
  }): Promise<{ projectId: string }>;
}
export class UnavailableProjectInstallPort extends ProjectInstallPort {
  install(): Promise<never> {
    return Promise.reject(new ProblemException('unsupported_capability', 'installing website and app templates needs the builder (M09/M10), which is not available on this deployment'));
  }
}
