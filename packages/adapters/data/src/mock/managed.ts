import {
  completeCapabilities,
  type CacheCapabilityId,
  type DatabaseCapabilityId,
} from '../contracts/capabilities';
import type {
  BackupRef,
  InstanceInspection,
  IntegrityReport,
  IssuedSecret,
  Network,
  TableCheck,
} from '../contracts/common';
import type { AccountContext, HealthReport, OperationResult } from '../upstream';
import { MockCore, canonical, clone, sha256, type Clock } from './core';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
export interface MockInstance {
  ref: string;
  token: string;
  engine: string;
  version: string;
  name: string;
  providerRegionId: string;
  planRef: string;
  storageGb: number;
  network: Network;
  tags: Record<string, string>;
  status: InstanceInspection['status'];
  tables: Tables;
  creds: Map<string, { credentialId: string; role: string; username: string }>;
  backups: Map<string, { ref: BackupRef; data: Tables; token: string }>;
  persistence?: string;
  hostSeq: number;
}

/**
 * Shared core of the in-memory database and cache simulators. The data model is real enough for the restore tests: instances hold tables of
 * rows, a backup is a copy, a restore-to-new copies it into a new instance, and the integrity check hashes the sampled tables, so
 * "restore reproduces the source" and "corruption is detected" are genuine comparisons — of simulated data (NOT VERIFIED, mock).
 */
export abstract class MockManaged<
  K extends 'database' | 'cache',
  C extends string,
> extends MockCore {
  protected readonly instances = new Map<string, MockInstance>();
  protected readonly byToken = new Map<string, string>();
  protected caps: Partial<Record<C, 'supported' | 'unsupported' | 'unknown'>>;
  private seq = 0;
  protected abstract readonly capIds: readonly C[];
  protected abstract readonly kindPrefix: string;
  constructor(clock: Clock, caps: Partial<Record<C, 'supported' | 'unsupported' | 'unknown'>>) {
    super(clock);
    this.caps = caps;
  }

  // ---- controls ----------------------------------------------------------------------------------------------------------
  setCapabilities(p: Partial<Record<C, 'supported' | 'unsupported' | 'unknown'>>): void {
    this.caps = { ...this.caps, ...p };
  }
  billableCount(): number {
    return [...this.instances.values()].filter((i) => i.status !== 'deleted').length;
  }
  billableByToken(token: string): number {
    const r = this.byToken.get(token);
    return r && this.instances.get(r)?.status !== 'deleted' ? 1 : 0;
  }
  /** Test control: put rows into an instance's table. */
  seedTable(ref: string, table: string, rows: Row[]): void {
    this.mustGet(ref).tables[table] = clone(rows);
  }
  tableRows(ref: string, table: string): Row[] {
    return clone(this.mustGet(ref).tables[table] ?? []);
  }
  /** Test control: silently damage a stored backup (the recorded manifest stays as it was). */
  corruptBackup(ref: string, backupRef: string): void {
    const b = this.mustGet(ref).backups.get(backupRef);
    if (!b) throw new Error('no such backup');
    const first = Object.keys(b.data)[0];
    if (first && b.data[first]?.[0]) b.data[first]![0] = { ...b.data[first]![0]!, corrupted: true };
  }
  /** Test control: damage live data (injected corruption for the restore-verification job). */
  corruptTable(ref: string, table: string): void {
    const t = this.mustGet(ref).tables[table];
    if (t?.[0]) t[0] = { ...t[0], corrupted: true };
  }
  instanceStatus(ref: string): string | undefined {
    return this.instances.get(ref)?.status;
  }
  credentialIds(ref: string): string[] {
    return [...this.mustGet(ref).creds.keys()];
  }
  /** Test control: does a credential id still authenticate? */
  authenticates(ref: string, credentialId: string): boolean {
    return this.instances.get(ref)?.creds.has(credentialId) ?? false;
  }
  protected mustGet(ref: string): MockInstance {
    const i = this.instances.get(ref);
    if (!i) throw new Error(`no such instance ${ref}`);
    return i;
  }
  protected supports(id: C): boolean {
    return this.caps[id] === 'supported';
  }

  // ---- shared adapter surface --------------------------------------------------------------------------------------------
  async probe(_ctx: AccountContext) {
    return {
      capabilities: completeCapabilities(this.capIds, this.caps),
      evidence: [this.ev('probe', `mock capability report for ${this.id}`)],
      probedAt: this.iso(),
    };
  }
  async health(_ctx: AccountContext): Promise<HealthReport> {
    return {
      state: 'healthy',
      checkedAt: this.iso(),
      detail: 'mock',
      evidence: [this.ev('health', 'mock')],
    };
  }
  abstract readonly id: string;
  abstract readonly kind: K;
  readonly contractVersion = '1.0.0';

  protected createInstance(
    token: string,
    spec: {
      engine: string;
      version: string;
      name: string;
      providerRegionId: string;
      planRef: string;
      storageGb: number;
      network: Network;
      tags: Record<string, string>;
      persistence?: string;
    },
    tables: Tables = {},
  ): MockInstance {
    const ref = `${this.kindPrefix}-${(++this.seq).toString().padStart(4, '0')}`;
    const inst: MockInstance = {
      ref,
      token,
      ...spec,
      tags: { ...spec.tags },
      status: 'running',
      tables,
      creds: new Map(),
      backups: new Map(),
      hostSeq: this.seq,
    };
    this.instances.set(ref, inst);
    this.byToken.set(token, ref);
    return inst;
  }
  protected inspectOf(i: MockInstance): InstanceInspection {
    return {
      providerRef: i.ref,
      status: i.status,
      engine: i.engine,
      version: i.version,
      endpoint:
        i.status === 'deleted'
          ? null
          : {
              host: `${i.ref}.mock.invalid`,
              port: i.engine === 'redis' ? 6379 : i.engine === 'mysql' ? 3306 : 5432,
            },
      tlsRequired: true,
      providerRegionId: i.providerRegionId,
      planRef: i.planRef,
      storageGb: i.storageGb,
      network: i.network,
      tags: i.tags,
      observedAt: this.iso(),
    };
  }
  async inspect(_ctx: AccountContext, ref: string): Promise<OperationResult<InstanceInspection>> {
    return this.reading('inspect', () => {
      const i = this.instances.get(ref);
      return i
        ? this.ok('inspect', 'inspected', this.inspectOf(i), ref)
        : this.fail('inspect', 'not_found', 'NOT_FOUND', 'no such instance');
    });
  }
  protected async findInstanceByToken(
    token: string,
  ): Promise<OperationResult<{ providerRef: string } | null>> {
    return this.reading('findByToken', () => {
      const r = this.byToken.get(token);
      const i = r ? this.instances.get(r) : undefined;
      return this.ok(
        'findByToken',
        i ? 'found' : 'absent',
        i && i.status !== 'deleted' ? { providerRef: i.ref } : null,
        i?.ref,
      );
    });
  }
  protected async deleteInstance(ref: string): Promise<OperationResult<void>> {
    return this.mutating('delete', () => {
      const i = this.instances.get(ref);
      if (!i) return this.ok('delete', 'already absent'); // delete is idempotent
      i.status = 'deleted';
      i.creds.clear();
      return this.ok('delete', 'deleted');
    });
  }
  protected async issue(
    ref: string,
    role: string,
    keepPrevious: boolean,
    token: string,
    capPrefix: 'database' | 'cache',
  ): Promise<OperationResult<IssuedSecret>> {
    return this.mutating('issueCredential', () => {
      if (!this.supports(`${capPrefix}.credential-rotation` as C))
        return this.fail(
          'issueCredential',
          'unsupported',
          'UNSUPPORTED',
          'credential issuing is not supported',
        );
      const i = this.instances.get(ref);
      if (!i || i.status === 'deleted')
        return this.fail('issueCredential', 'not_found', 'NOT_FOUND', 'no such instance');
      if (keepPrevious && !this.supports(`${capPrefix}.dual-credentials` as C))
        return this.fail(
          'issueCredential',
          'unsupported',
          'UNSUPPORTED',
          'dual credentials are not supported',
        );
      const credentialId = `cred-${sha256(`${ref}|${role}|${token}`).slice(0, 12)}`;
      if (!i.creds.has(credentialId)) {
        if (!keepPrevious) for (const [id, c] of i.creds) if (c.role === role) i.creds.delete(id);
        i.creds.set(credentialId, {
          credentialId,
          role,
          username: `u_${role}_${credentialId.slice(5, 11)}`,
        });
      }
      const c = i.creds.get(credentialId)!;
      return this.ok('issueCredential', 'issued', {
        credentialId,
        username: c.username,
        fields: { password: `mock-secret-${sha256(`${credentialId}|${token}`).slice(0, 24)}` },
      });
    });
  }
  protected async revoke(ref: string, credentialId: string): Promise<OperationResult<void>> {
    return this.mutating('revokeCredential', () => {
      const i = this.instances.get(ref);
      if (!i) return this.ok('revokeCredential', 'instance absent');
      i.creds.delete(credentialId); // idempotent
      return this.ok('revokeCredential', 'revoked');
    });
  }
  protected async list(
    ref: string,
  ): Promise<OperationResult<{ credentialId: string; role: string }[]>> {
    return this.reading('listCredentials', () => {
      const i = this.instances.get(ref);
      if (!i) return this.fail('listCredentials', 'not_found', 'NOT_FOUND', 'no such instance');
      return this.ok(
        'listCredentials',
        'listed',
        [...i.creds.values()].map((c) => ({ credentialId: c.credentialId, role: c.role })),
      );
    });
  }

  protected manifestOf(t: Tables, sample: number): TableCheck[] {
    return Object.keys(t)
      .sort()
      .slice(0, sample)
      .map((table) => ({
        table,
        rowCount: t[table]!.length,
        checksum: sha256(canonical(t[table])),
      }));
  }
  protected async backupOf(
    ref: string,
    type: BackupRef['type'],
    token: string,
    capPrefix: 'database' | 'cache',
  ): Promise<OperationResult<BackupRef>> {
    return this.mutating('backup', () => {
      if (!this.supports(`${capPrefix}.backup` as C))
        return this.fail('backup', 'unsupported', 'UNSUPPORTED', 'backups are not supported');
      const i = this.instances.get(ref);
      if (!i || i.status === 'deleted')
        return this.fail('backup', 'not_found', 'NOT_FOUND', 'no such instance');
      for (const b of i.backups.values())
        if (b.token === token) return this.ok('backup', 'replay', b.ref, b.ref.backupRef);
      const data = clone(i.tables);
      const backupRef = `bk-${sha256(`${ref}|${token}`).slice(0, 12)}`;
      const body = canonical(data);
      const b: BackupRef = {
        backupRef,
        type,
        sizeBytes: Buffer.byteLength(body),
        checksum: sha256(body),
        storageRef: `mock-system-bucket/${ref}/${backupRef}`,
        takenAt: this.iso(),
        state: 'available',
        manifest: this.supports(`${capPrefix}.integrity-check` as C)
          ? this.manifestOf(data, 1000)
          : undefined,
      };
      i.backups.set(backupRef, { ref: b, data, token });
      return this.ok('backup', 'backup taken', b, backupRef);
    });
  }
  async listBackups(_ctx: AccountContext, ref: string): Promise<OperationResult<BackupRef[]>> {
    return this.reading('listBackups', () => {
      const i = this.instances.get(ref);
      if (!i) return this.fail('listBackups', 'not_found', 'NOT_FOUND', 'no such instance');
      return this.ok(
        'listBackups',
        'listed',
        [...i.backups.values()].map((b) => b.ref).filter((b) => b.state !== 'deleted'),
      );
    });
  }
  async findBackupByToken(
    _ctx: AccountContext,
    ref: string,
    token: string,
  ): Promise<OperationResult<BackupRef | null>> {
    return this.reading('findBackupByToken', () => {
      const i = this.instances.get(ref);
      const b = i && [...i.backups.values()].find((x) => x.token === token);
      return this.ok('findBackupByToken', b ? 'found' : 'absent', b?.ref ?? null);
    });
  }
  async deleteBackup(
    _ctx: AccountContext,
    ref: string,
    backupRef: string,
  ): Promise<OperationResult<void>> {
    return this.mutating('deleteBackup', () => {
      const b = this.instances.get(ref)?.backups.get(backupRef);
      if (b) b.ref = { ...b.ref, state: 'deleted' };
      return this.ok('deleteBackup', 'deleted');
    });
  }
  protected async restoreNew(
    sourceRef: string,
    backupRef: string,
    token: string,
    target: {
      name: string;
      providerRegionId: string;
      planRef: string;
      storageGb: number;
      network: Network;
      tags: Record<string, string>;
    },
    capPrefix: 'database' | 'cache',
  ): Promise<OperationResult<{ providerRef: string }>> {
    return this.mutating('restoreToNew', () => {
      if (!this.supports(`${capPrefix}.restore-to-new` as C))
        return this.fail(
          'restoreToNew',
          'unsupported',
          'UNSUPPORTED',
          'restore-to-new is not supported',
        );
      const existing = this.byToken.get(token);
      if (existing) return this.ok('restoreToNew', 'replay', { providerRef: existing }, existing);
      const src = this.instances.get(sourceRef);
      const bk = src?.backups.get(backupRef);
      if (!src || !bk || bk.ref.state !== 'available')
        return this.fail('restoreToNew', 'not_found', 'NOT_FOUND', 'no such backup');
      if (target.providerRegionId !== src.providerRegionId)
        return this.fail(
          'restoreToNew',
          'validation',
          'CROSS_REGION',
          'restore stays in the source provider region',
        );
      const inst = this.createInstance(
        token,
        { ...target, engine: src.engine, version: src.version, persistence: src.persistence },
        clone(bk.data),
      );
      return this.ok('restoreToNew', 'restored', { providerRef: inst.ref }, inst.ref, 'accepted');
    });
  }
  protected async integrity(
    ref: string,
    sample: number,
    capPrefix: 'database' | 'cache',
  ): Promise<OperationResult<IntegrityReport>> {
    return this.reading('integrityCheck', () => {
      if (!this.supports(`${capPrefix}.integrity-check` as C))
        return this.fail(
          'integrityCheck',
          'unsupported',
          'UNSUPPORTED',
          'integrity check is not supported',
        );
      const i = this.instances.get(ref);
      if (!i || i.status === 'deleted')
        return this.fail('integrityCheck', 'not_found', 'NOT_FOUND', 'no such instance');
      return this.ok('integrityCheck', 'checked', {
        engineCheck: 'ok',
        tables: this.manifestOf(i.tables, sample),
        checkedAt: this.iso(),
      });
    });
  }
}
export type { DatabaseCapabilityId, CacheCapabilityId };
