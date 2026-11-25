/**
 * The SERVER-APP deployment target (Phase 3, P3-S07): the design as a port, and the refusal until it can exist. A built full-stack application (server code plus its database)
 * is NEVER published to the shared-hosting target: HestiaCP is shared hosting with unverified customer isolation, and generated server code needs the qualified isolated runtime
 * (P3-S02, the Execution Gateway: closed profiles, attestation, quotas) with a managed PostgreSQL of its own (B-DB, an OPEN owner decision).
 *
 * What a release of a server app is (so the same versioning and rollback rules as a static release apply): an immutable build bundle with a manifest hash, a start command from a
 * closed profile (never a free-form shell string), a health path, environment variable REFERENCES (vault, never values), and a database binding (a managed database reference plus
 * the migration set to apply). Deploy = verify bundle hash, run migrations on the managed database (expand-only, reversible), start the new release beside the old one, health-check it,
 * switch traffic, keep the previous release warm for rollback. Rollback = switch traffic back (database migrations are expand/contract, so the previous release still works).
 *
 * Nothing here runs anything: there is no runtime and no database to run it on. Every method of the only implementation refuses with a named blocker; `NOT VERIFIED` stays the
 * status of the whole target until a real runtime and database exist and a live run is recorded.
 */
export type ServerAppBlocker =
  | 'P3-S02 qualified isolated runtime (ExecutionPort with an isolation attestation; D-21, HG-10-02, ADR-069)'
  | 'B-DB managed PostgreSQL for generated apps (owner decision: where it runs)'
  | 'HG-05 a node for the runtime and HG-06 access to it';

export interface ServerAppRelease {
  /** deployment id (a UUID fits `assertReleaseId`) */
  releaseId: string;
  /** manifest hash of the build bundle (same rule as a static artifact) */
  bundleHash: string;
  /** a profile of the closed catalogue (for example `start-node`), never a command string */
  startProfile: string;
  healthPath: string;
  /** names -> vault references; a value here is a defect */
  envRefs: Record<string, string>;
  database: { managedDatabaseRef: string; migrationSetHash: string } | null;
}

export interface ServerAppTargetPort {
  readonly simulated: boolean;
  /** what is missing for this target to run at all (empty = nothing known to be missing) */
  blockers(): ServerAppBlocker[];
  deploy(siteId: string, release: ServerAppRelease): Promise<{ url: string }>;
  health(siteId: string, releaseId: string): Promise<{ status: number }>;
  switchTraffic(siteId: string, releaseId: string): Promise<{ previousReleaseId: string | null }>;
  rollback(siteId: string, toReleaseId: string): Promise<void>;
  /** the release that is serving, read from the runtime (never remembered) */
  current(siteId: string): Promise<string | null>;
}

export class ServerAppTargetUnavailable extends Error {
  readonly code = 'unsupported_capability' as const;
  constructor(readonly blockers: ServerAppBlocker[]) {
    super(`server application deployment is NOT VERIFIED and refused: ${blockers.join('; ')}`);
    this.name = 'ServerAppTargetUnavailable';
  }
}

/** The only implementation today: refuses every call, names what is missing, creates nothing. */
export class UnavailableServerAppTarget implements ServerAppTargetPort {
  readonly simulated = false;
  blockers(): ServerAppBlocker[] {
    return [
      'P3-S02 qualified isolated runtime (ExecutionPort with an isolation attestation; D-21, HG-10-02, ADR-069)',
      'B-DB managed PostgreSQL for generated apps (owner decision: where it runs)',
      'HG-05 a node for the runtime and HG-06 access to it',
    ];
  }
  private no(): never {
    throw new ServerAppTargetUnavailable(this.blockers());
  }
  deploy(): never {
    return this.no();
  }
  health(): never {
    return this.no();
  }
  switchTraffic(): never {
    return this.no();
  }
  rollback(): never {
    return this.no();
  }
  current(): never {
    return this.no();
  }
}

/** Refuse a release that would carry a secret value or a free-form command: checked before ANY target (including a future real one) sees it. */
export function assertServerAppReleaseSafe(r: ServerAppRelease): void {
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(r.releaseId))
    throw new Error('release id must be 8-64 characters of a-z, 0-9 and "-"');
  if (!/^[a-f0-9]{64}$/.test(r.bundleHash)) throw new Error('the bundle hash must be a sha256 hex');
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(r.startProfile))
    throw new Error('the start profile must be a name from the closed catalogue, not a command');
  if (!/^\/[A-Za-z0-9._~/%-]*$/.test(r.healthPath))
    throw new Error('the health path must be an absolute path');
  for (const [k, v] of Object.entries(r.envRefs)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) throw new Error(`environment name ${k} is not valid`);
    if (!/^vault:\/\/[A-Za-z0-9._/-]{3,200}$/.test(v))
      throw new Error(`environment ${k} must be a vault reference, never a value`);
  }
}
