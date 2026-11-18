import { createHash } from 'node:crypto';
import type { BackupRef, IntegrityReport, TableCheck } from '../contracts/common';
import type {
  OperationResult,
  ComputePort,
  ComputeInstanceRefPort,
  ComputeInstanceStatePort,
  ComputeProvisionRequestPort,
  AccountContext,
} from '../upstream';
import { MockCore, canonical, clone, sha256, type Clock } from '../mock/core';
import { AgentRefusedError, CommandVerifier, type SignedCommand } from './agent-protocol';

type Tables = Record<string, Record<string, unknown>[]>;

/** The agent-side port the orchestrator talks to. The real transport (mTLS, D-20 style) is a later decision; this interface is the contract. */
export interface NodeAgentPort {
  execute(
    nodeRef: string,
    command: SignedCommand,
  ): Promise<
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; refusal: string; retryable: boolean }
  >;
}

interface Node {
  ref: string;
  engine?: string;
  version?: string;
  listen?: 'private' | 'allowlist';
  tls: boolean;
  tables: Tables;
  roles: Map<string, { credentialId: string; role: string }>;
  backups: Map<string, { ref: BackupRef; data: Tables; bucket: string; region: string }>;
  archiveBucket?: string;
  dataRegion?: string;
  patched?: string;
  verifier: CommandVerifier;
}

/** Records what the nodes archived: lets tests assert "backups land in a bucket of the instance's own data_region". */
export class FakeArchive {
  readonly objects: { bucket: string; key: string; region: string; bytes: number }[] = [];
}

/**
 * In-memory node agent + fleet: verifies every command with the shared `CommandVerifier` (signature, node binding, expiry, nonce, allow-list,
 * argument schema) and then simulates the engine. NOT a database: it holds rows so that restore/integrity are real comparisons of SIMULATED data.
 */
export class FakeNodeFleet implements NodeAgentPort {
  readonly archive = new FakeArchive();
  readonly nodes = new Map<string, Node>();
  /** Every command that reached an executor (refused commands never appear here). */
  readonly executed: { nodeRef: string; cmd: string }[] = [];
  private failNext: { cmd: string; kind: 'unavailable' }[] = [];
  constructor(
    private readonly key: Uint8Array,
    private readonly clock: Clock,
  ) {}
  failOnce(cmd: string) {
    this.failNext.push({ cmd, kind: 'unavailable' });
  }
  addNode(ref: string) {
    this.nodes.set(ref, {
      ref,
      tls: false,
      tables: {},
      roles: new Map(),
      backups: new Map(),
      verifier: new CommandVerifier(this.key, ref, () => this.clock.now()),
    });
  }
  removeNode(ref: string) {
    this.nodes.delete(ref);
  }
  seedTable(ref: string, table: string, rows: Record<string, unknown>[]) {
    this.node(ref).tables[table] = clone(rows);
  }
  corruptBackup(ref: string, backupId: string) {
    const b = this.node(ref).backups.get(backupId);
    const first = b && Object.keys(b.data)[0];
    if (b && first && b.data[first]?.[0])
      b.data[first]![0] = { ...b.data[first]![0]!, corrupted: true };
  }
  authenticates(ref: string, credentialId: string) {
    return this.nodes.get(ref)?.roles.has(credentialId) ?? false;
  }
  private node(ref: string): Node {
    const n = this.nodes.get(ref);
    if (!n) throw new Error(`no node ${ref}`);
    return n;
  }
  private manifest(t: Tables, sample: number): TableCheck[] {
    return Object.keys(t)
      .sort()
      .slice(0, sample)
      .map((table) => ({
        table,
        rowCount: t[table]!.length,
        checksum: sha256(canonical(t[table])),
      }));
  }

  async execute(nodeRef: string, command: SignedCommand) {
    const n = this.nodes.get(nodeRef);
    if (!n) return { ok: false as const, refusal: 'no_such_node', retryable: false };
    let v: ReturnType<CommandVerifier['verify']>;
    try {
      v = n.verifier.verify(command);
    } catch (e) {
      if (e instanceof AgentRefusedError)
        return { ok: false as const, refusal: e.refusal, retryable: false };
      throw e;
    }
    const f = this.failNext.findIndex((x) => x.cmd === v.cmd);
    if (f >= 0) {
      this.failNext.splice(f, 1);
      return { ok: false as const, refusal: 'agent_unavailable', retryable: true };
    }
    this.executed.push({ nodeRef, cmd: v.cmd });
    const a = v.args;
    switch (v.cmd) {
      case 'bootstrap':
        n.engine = a.engine as string;
        n.version = a.version as string;
        n.listen = a.listen as 'private' | 'allowlist';
        n.tls = true;
        n.archiveBucket = a.archiveBucket as string;
        n.dataRegion = a.dataRegion as string;
        return { ok: true as const, result: { bootstrapped: true } };
      case 'status':
        return {
          ok: true as const,
          result: {
            bootstrapped: n.engine !== undefined,
            engine: n.engine ?? null,
            version: n.version ?? null,
            listen: n.listen ?? null,
            tls: n.tls,
            port: n.engine === 'mysql' ? 3306 : n.engine === 'redis' ? 6379 : 5432,
          },
        };
      case 'create_role': {
        const id = a.credentialId as string;
        if (!a.keepPrevious) for (const [k, r] of n.roles) if (r.role === a.role) n.roles.delete(k);
        n.roles.set(id, { credentialId: id, role: a.role as string });
        return {
          ok: true as const,
          result: { password: `agent-secret-${sha256(`${nodeRef}|${id}`).slice(0, 24)}` },
        };
      }
      case 'drop_role':
        n.roles.delete(a.credentialId as string);
        return { ok: true as const, result: {} };
      case 'list_roles':
        return { ok: true as const, result: { roles: [...n.roles.values()] } };
      case 'base_backup': {
        const id = a.backupId as string;
        const prev = n.backups.get(id);
        if (prev) return { ok: true as const, result: { backup: prev.ref } };
        const data = clone(n.tables);
        const text = canonical(data);
        const key = `${nodeRef}/${id}`;
        const ref: BackupRef = {
          backupRef: id,
          type: a.kind as BackupRef['type'],
          sizeBytes: Buffer.byteLength(text),
          checksum: sha256(text),
          storageRef: `${n.archiveBucket}/${key}`,
          takenAt: new Date(this.clock.now()).toISOString(),
          state: 'available',
          manifest: this.manifest(data, 1000),
        };
        n.backups.set(id, { ref, data, bucket: n.archiveBucket!, region: n.dataRegion! });
        this.archive.objects.push({
          bucket: n.archiveBucket!,
          key,
          region: n.dataRegion!,
          bytes: ref.sizeBytes,
        });
        return { ok: true as const, result: { backup: ref } };
      }
      case 'list_backups':
        return {
          ok: true as const,
          result: {
            backups: [...n.backups.values()].map((b) => b.ref).filter((b) => b.state !== 'deleted'),
          },
        };
      case 'restore_new': {
        const src = this.nodes.get(a.sourceNodeRef as string);
        const b = src?.backups.get(a.backupId as string);
        if (!src || !b) return { ok: false as const, refusal: 'no_such_backup', retryable: false };
        n.tables = clone(b.data);
        n.engine = src.engine;
        n.version = src.version;
        n.tls = true;
        n.listen = src.listen;
        return { ok: true as const, result: { restored: true } };
      }
      case 'restore_in_place': {
        const b = n.backups.get(a.backupId as string);
        if (!b) return { ok: false as const, refusal: 'no_such_backup', retryable: false };
        n.tables = clone(b.data);
        return { ok: true as const, result: { restored: true } };
      }
      case 'integrity_check':
        return {
          ok: true as const,
          result: {
            engineCheck: 'ok',
            tables: this.manifest(n.tables, a.sampleTables as number),
          } satisfies Pick<IntegrityReport, 'engineCheck' | 'tables'>,
        };
      case 'apply_patch':
        n.patched = a.policy as string;
        return { ok: true as const, result: { applied: a.policy } };
      case 'usage': {
        const backupBytes = [...n.backups.values()].reduce((s, b) => s + b.ref.sizeBytes, 0);
        return {
          ok: true as const,
          result: { storageBytes: 20 * 1024 ** 3, backupBytes, runningSeconds: 3600 },
        };
      }
    }
  }
}

/** Fake `ComputePort` (stands in for M05's ComputeAdapter): idempotent per token, fault injection, billable count. */
export class FakeCompute extends MockCore implements ComputePort {
  private readonly byToken = new Map<string, string>();
  private readonly inst = new Map<
    string,
    ComputeInstanceStatePort & { deleted?: boolean; token: string }
  >();
  private seq = 0;
  constructor(
    clock: Clock,
    private readonly onCreate: (ref: string) => void = () => undefined,
    private readonly onDelete: (ref: string) => void = () => undefined,
  ) {
    super(clock);
  }
  billableCount() {
    return [...this.inst.values()].filter((i) => !i.deleted).length;
  }
  billableByToken(t: string) {
    const r = this.byToken.get(t);
    return r && !this.inst.get(r)?.deleted ? 1 : 0;
  }
  provision(
    _c: AccountContext,
    req: ComputeProvisionRequestPort,
  ): Promise<OperationResult<ComputeInstanceRefPort>> {
    return this.mutating('provision', () => {
      const prior = this.byToken.get(req.idempotencyToken);
      if (prior) return this.ok('provision', 'replay', { providerRef: prior }, prior, 'accepted');
      const ref = `fakeecs-${(++this.seq).toString().padStart(4, '0')}`;
      this.inst.set(ref, {
        providerRef: ref,
        status: 'running',
        providerRegionId: req.providerRegionId,
        planRef: req.planRef,
        publicIps: [],
        privateIps: [`10.0.0.${this.seq}`],
        tags: { ...req.tags, 'nuzm-token': req.idempotencyToken },
        observedAt: this.iso(),
        token: req.idempotencyToken,
      });
      this.byToken.set(req.idempotencyToken, ref);
      this.onCreate(ref);
      return this.ok('provision', 'created', { providerRef: ref }, ref, 'accepted');
    });
  }
  inspect(_c: AccountContext, ref: string): Promise<OperationResult<ComputeInstanceStatePort>> {
    return this.reading('inspect', () => {
      const i = this.inst.get(ref);
      return i
        ? this.ok(
            'inspect',
            'ok',
            { ...i, status: i.deleted ? 'deleted' : i.status, observedAt: this.iso() },
            ref,
          )
        : this.fail('inspect', 'not_found', 'NOT_FOUND', 'no such instance');
    });
  }
  findByToken(
    _c: AccountContext,
    token: string,
  ): Promise<OperationResult<ComputeInstanceRefPort | null>> {
    return this.reading('findByToken', () => {
      const r = this.byToken.get(token);
      const i = r ? this.inst.get(r) : undefined;
      return this.ok(
        'findByToken',
        i && !i.deleted ? 'found' : 'absent',
        i && !i.deleted ? { providerRef: i.providerRef } : null,
      );
    });
  }
  delete(_c: AccountContext, ref: string): Promise<OperationResult<void>> {
    return this.mutating('delete', () => {
      const i = this.inst.get(ref);
      if (i && !i.deleted) {
        i.deleted = true;
        this.onDelete(ref);
      }
      return this.ok('delete', 'deleted');
    });
  }
}

export const fleetKey = (seed = 'fake-fleet-key'): Uint8Array =>
  createHash('sha256').update(seed).digest();
