import { ProblemException } from '../../../common/errors';

/** A consumer of a database connection (an M06 hosting site, an M10 app). */
export interface DatabaseBinding {
  consumerKind: string;
  consumerId: string;
}
export interface RotationNotice {
  databaseId: string;
  /** The vault reference of the NEW credential: the consumer reads the secret itself; the notice never carries it. */
  newVaultRef: string;
  previousVaultRef: string;
  windowEndsAt: string;
}

/**
 * `DatabaseBindingPort` (M08 handoff to M06 and M10): bind a managed database to a hosting site or an app, refuse deleting a database that is in
 * use (409 `in_use`) and tell the consumers when a credential rotates so that they switch to the new credential INSIDE the dual-credential window
 * (zero downtime). The default implementation knows no consumers; M06/M10 provide the real one (assumptions doc U-08).
 */
export abstract class DatabaseBindingPort {
  abstract bindings(orgId: string, databaseId: string): Promise<DatabaseBinding[]>;
  async assertNotInUse(orgId: string, databaseId: string): Promise<void> {
    const b = await this.bindings(orgId, databaseId);
    if (b.length > 0)
      throw new ProblemException(
        'in_use',
        `the database is bound to ${b.length} consumer(s); unbind it first`,
      );
  }
  abstract notifyRotation(orgId: string, notice: RotationNotice): Promise<void>;
}
export class NoBindings extends DatabaseBindingPort {
  async bindings(): Promise<DatabaseBinding[]> {
    return [];
  }
  async notifyRotation(): Promise<void> {
    /* no consumer exists yet */
  }
}
/** In-memory implementation for tests and local demos: lets a test bind a fake consumer and observe the notices. */
export class MemoryBindings extends DatabaseBindingPort {
  readonly bound = new Map<string, DatabaseBinding[]>();
  readonly notices: { orgId: string; notice: RotationNotice }[] = [];
  bind(databaseId: string, b: DatabaseBinding) {
    this.bound.set(databaseId, [...(this.bound.get(databaseId) ?? []), b]);
  }
  async bindings(_org: string, databaseId: string) {
    return this.bound.get(databaseId) ?? [];
  }
  async notifyRotation(orgId: string, notice: RotationNotice) {
    this.notices.push({ orgId, notice });
  }
}
