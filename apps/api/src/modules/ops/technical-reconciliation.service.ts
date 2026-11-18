import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../common/audit';

/**
 * Technical reconciliations TR-01..TR-04 (docs/05 §7, M12 §6a), stored ONLY in cloud.resource_reconciliations (extended by migration 1750).
 *  TR-01 cloud.resources vs provider inventory: 0 orphaned billable resources, 0 unknown-state > 1 h
 *  TR-02 hosting.nodes/sites vs node report: 0 sites without allocation, 0 oversold nodes, no site missing from / unknown to its node
 *  TR-03 domains.domains vs registrar state/expiry: 0 mismatches
 *  TR-04 data.* / email.* resources vs provider state: 0 mismatches
 * Every comparison against a PROVIDER needs a source: with none (`null`) that half is NOT EVALUATED and the evidence mode is `database_only`; results from
 * recorded fixtures are `fixture`, never `live`. Nothing here calls a provider by itself: sources are injected (adapters in production, fixtures in tests).
 */
export type TrType = 'TR-01' | 'TR-02' | 'TR-03' | 'TR-04';
export type EvidenceMode = 'fixture' | 'sandbox' | 'live' | 'database_only';
export interface Finding {
  kind: string;
  subjectKind: string;
  subjectRef: string;
  result: 'drift' | 'orphan_suspected' | 'missing';
  observed: Record<string, unknown>;
  resourceId?: string;
}
export interface TrResult {
  type: TrType;
  runId: string;
  checked: number;
  findings: Finding[];
  notEvaluated: string[];
  mode: EvidenceMode;
}

export interface TrSources {
  mode: EvidenceMode;
  /** Provider inventory per provider account: refs and states, or null when no adapter/fixture can list it. */
  computeInventory(providerAccountId: string): Promise<{ ref: string; state: string }[] | null>;
  /** What the node agent reports for a node: site names on the node, or null. */
  nodeSites(nodeName: string): Promise<string[] | null>;
  /** The registrar's view for an account: domain names with state and expiry, or null. */
  registrarDomains(
    registrarAccountId: string,
  ): Promise<{ name: string; state: string; expiresAt?: string }[] | null>;
  /** Provider objects for data/email resources of a kind (`data.database_instances`, `data.storage_buckets`, `email.mailboxes`). */
  providerObjects(kind: string): Promise<{ ref: string; state: string }[] | null>;
}
export const NO_SOURCES: TrSources = {
  mode: 'database_only',
  computeInventory: async () => null,
  nodeSites: async () => null,
  registrarDomains: async () => null,
  providerObjects: async () => null,
};

type Row = Record<string, unknown>;
const DAY = 86_400_000;

export class TechnicalReconciliationService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly sources: TrSources = NO_SOURCES,
  ) {}

  async run(type: TrType, by: string | null): Promise<TrResult> {
    const runId = uuidv7();
    const res: TrResult = {
      type,
      runId,
      checked: 0,
      findings: [],
      notEvaluated: [],
      mode: this.sources.mode,
    };
    await this.db.withPlatformScope(async (c) => {
      if (type === 'TR-01') await this.tr01(c, res);
      else if (type === 'TR-02') await this.tr02(c, res);
      else if (type === 'TR-03') await this.tr03(c, res);
      else await this.tr04(c, res);
      const write = (
        kind: string,
        ref: string,
        result: string,
        observed: Record<string, unknown>,
        resourceId?: string,
      ) =>
        c.query(
          `INSERT INTO cloud.resource_reconciliations (id, resource_id, trigger, observed, result, action_taken, actor_user_id, tr_type, subject_kind, subject_ref, evidence_mode) VALUES ($1,$2,'scheduled',$3,$4,'none',$5,$6,$7,$8,$9)`,
          [
            uuidv7(),
            resourceId ?? null,
            JSON.stringify({ ...observed, runId }),
            result,
            by,
            type,
            kind,
            ref,
            res.mode,
          ],
        );
      for (const f of res.findings)
        await write(
          f.subjectKind,
          f.subjectRef,
          f.result,
          { kind: f.kind, ...f.observed },
          f.resourceId,
        );
      // a clean run is recorded too: the evidence of "0 variance" is a row, not an absence of rows
      await write('run', runId, res.findings.length ? 'drift' : 'in_sync', {
        checked: res.checked,
        findings: res.findings.length,
        notEvaluated: res.notEvaluated,
      });
    });
    if (res.findings.length)
      await this.audit.record({
        action: 'reconciliation.technical.findings',
        actorUserId: by ?? undefined,
        actorType: by ? 'user' : 'system',
        resource: { type: 'reconciliation', id: res.runId },
        outcome: 'failure',
        detail: {
          type,
          findings: res.findings.length,
          kinds: [...new Set(res.findings.map((f) => f.kind))],
        },
      });
    return res;
  }

  async runAll(by: string | null): Promise<TrResult[]> {
    const out: TrResult[] = [];
    for (const t of ['TR-01', 'TR-02', 'TR-03', 'TR-04'] as const) out.push(await this.run(t, by));
    return out;
  }

  private async tr01(c: import('pg').PoolClient, r: TrResult) {
    const rows = (
      await c.query<Row>(
        `SELECT id, provider_account_id, provider_ref, state, updated_at FROM cloud.resources WHERE state NOT IN ('DELETED','DRAFT','QUOTED','AWAITING_PAYMENT')`,
      )
    ).rows;
    r.checked = rows.length;
    for (const x of rows)
      if (x.state === 'UNKNOWN' && Date.now() - (x.updated_at as Date).getTime() > 3_600_000)
        r.findings.push({
          kind: 'unknown_state_over_1h',
          subjectKind: 'cloud.resources',
          subjectRef: x.id as string,
          result: 'drift',
          observed: { state: 'UNKNOWN', since: (x.updated_at as Date).toISOString() },
          resourceId: x.id as string,
        });
    const accounts = [...new Set(rows.map((x) => x.provider_account_id as string))];
    for (const acct of (
      await c.query<{ id: string }>(`SELECT id FROM cloud.provider_accounts`)
    ).rows
      .map((a) => a.id)
      .filter((a) => accounts.includes(a) || true)) {
      const inv = await this.sources.computeInventory(acct);
      if (inv === null) {
        if (!r.notEvaluated.includes('provider inventory'))
          r.notEvaluated.push('provider inventory');
        continue;
      }
      const mine = rows.filter((x) => x.provider_account_id === acct);
      const known = new Map(
        mine.filter((x) => x.provider_ref).map((x) => [x.provider_ref as string, x]),
      );
      for (const x of mine)
        if (x.provider_ref && x.state === 'ACTIVE' && !inv.some((i) => i.ref === x.provider_ref))
          r.findings.push({
            kind: 'missing_at_provider',
            subjectKind: 'cloud.resources',
            subjectRef: x.id as string,
            result: 'missing',
            observed: { providerRef: x.provider_ref },
            resourceId: x.id as string,
          });
      for (const i of inv)
        if (!known.has(i.ref) && i.state !== 'terminated' && i.state !== 'deleted')
          r.findings.push({
            kind: 'orphaned_billable_resource',
            subjectKind: 'provider.instance',
            subjectRef: i.ref,
            result: 'orphan_suspected',
            observed: { providerAccountId: acct, providerState: i.state },
          });
      r.checked += inv.length;
    }
  }

  private async tr02(c: import('pg').PoolClient, r: TrResult) {
    const noAlloc = (
      await c.query<Row>(
        `SELECT s.id, s.node_name, s.status FROM hosting.sites s LEFT JOIN hosting.site_allocations a ON a.site_id = s.id WHERE s.status IN ('creating','active','suspended','restoring') AND a.site_id IS NULL`,
      )
    ).rows;
    for (const s of noAlloc)
      r.findings.push({
        kind: 'site_without_allocation',
        subjectKind: 'hosting.sites',
        subjectRef: s.id as string,
        result: 'drift',
        observed: { status: s.status },
      });
    const over = (
      await c.query<Row>(
        `SELECT n.id, n.name, d.dim, cap.sellable, d.used FROM hosting.nodes n JOIN hosting.node_capacity cap ON cap.node_id = n.id
         JOIN LATERAL (VALUES ('cpu_millicores', (SELECT coalesce(sum(cpu_millicores),0) FROM hosting.site_allocations WHERE node_id = n.id)),
                              ('memory_mb', (SELECT coalesce(sum(memory_mb),0) FROM hosting.site_allocations WHERE node_id = n.id)),
                              ('disk_mb', (SELECT coalesce(sum(disk_mb),0) FROM hosting.site_allocations WHERE node_id = n.id))) AS d(dim, used) ON d.dim = cap.dim
        WHERE d.used > cap.sellable`,
      )
    ).rows;
    for (const o of over)
      r.findings.push({
        kind: 'oversold_node',
        subjectKind: 'hosting.nodes',
        subjectRef: o.id as string,
        result: 'drift',
        observed: {
          node: o.name,
          dim: o.dim,
          allocated: String(o.used),
          sellable: String(o.sellable),
        },
      });
    const sites = (
      await c.query<Row>(
        `SELECT s.node_name, n.name AS node FROM hosting.sites s JOIN hosting.nodes n ON n.id = s.node_id WHERE s.status = 'active'`,
      )
    ).rows;
    r.checked = sites.length + noAlloc.length;
    for (const node of [...new Set(sites.map((s) => s.node as string))]) {
      const report = await this.sources.nodeSites(node);
      if (report === null) {
        if (!r.notEvaluated.includes('node report')) r.notEvaluated.push('node report');
        continue;
      }
      const ours = sites.filter((s) => s.node === node).map((s) => s.node_name as string);
      for (const n of ours)
        if (!report.includes(n))
          r.findings.push({
            kind: 'site_missing_on_node',
            subjectKind: 'hosting.sites',
            subjectRef: n,
            result: 'missing',
            observed: { node },
          });
      for (const n of report)
        if (!ours.includes(n))
          r.findings.push({
            kind: 'site_unknown_to_platform',
            subjectKind: 'hosting.node_sites',
            subjectRef: `${node}/${n}`,
            result: 'orphan_suspected',
            observed: { node },
          });
    }
  }

  private async tr03(c: import('pg').PoolClient, r: TrResult) {
    const doms = (
      await c.query<Row>(
        `SELECT id, name, state, registrar_account_id, expires_at FROM domains.domains WHERE state IN ('active','renewal_at_risk','expired')`,
      )
    ).rows;
    r.checked = doms.length;
    for (const acct of [...new Set(doms.map((d) => d.registrar_account_id as string))]) {
      const snap = await this.sources.registrarDomains(acct);
      if (snap === null) {
        if (!r.notEvaluated.includes('registrar state')) r.notEvaluated.push('registrar state');
        continue;
      }
      for (const d of doms.filter((x) => x.registrar_account_id === acct)) {
        const s = snap.find((x) => x.name === d.name);
        if (!s) {
          r.findings.push({
            kind: 'domain_missing_at_registrar',
            subjectKind: 'domains.domains',
            subjectRef: d.id as string,
            result: 'missing',
            observed: { name: d.name },
          });
          continue;
        }
        if (
          d.expires_at &&
          s.expiresAt &&
          Math.abs((d.expires_at as Date).getTime() - new Date(s.expiresAt).getTime()) > DAY
        )
          r.findings.push({
            kind: 'expiry_mismatch',
            subjectKind: 'domains.domains',
            subjectRef: d.id as string,
            result: 'drift',
            observed: {
              name: d.name,
              ours: (d.expires_at as Date).toISOString(),
              registrar: s.expiresAt,
            },
          });
        if (d.state === 'active' && s.state !== 'active')
          r.findings.push({
            kind: 'state_mismatch',
            subjectKind: 'domains.domains',
            subjectRef: d.id as string,
            result: 'drift',
            observed: { name: d.name, ours: d.state, registrar: s.state },
          });
      }
      for (const s of snap)
        if (!doms.some((d) => d.name === s.name && d.registrar_account_id === acct))
          r.findings.push({
            kind: 'domain_unknown_to_platform',
            subjectKind: 'registrar.domain',
            subjectRef: s.name,
            result: 'orphan_suspected',
            observed: { registrarAccountId: acct },
          });
    }
  }

  private async tr04(c: import('pg').PoolClient, r: TrResult) {
    for (const table of ['data.database_instances', 'data.storage_buckets', 'email.mailboxes']) {
      const [schema, name] = table.split('.') as [string, string];
      const has = (
        await c.query(
          `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'provider_ref'`,
          [schema, name],
        )
      ).rowCount;
      if (!has) {
        r.notEvaluated.push(`${table}: no provider_ref column`);
        continue;
      }
      const mine = (
        await c.query<Row>(
          `SELECT id, provider_ref, state FROM ${table} WHERE provider_ref IS NOT NULL AND state NOT IN ('deleted','failed')`,
        )
      ).rows;
      r.checked += mine.length;
      const snap = await this.sources.providerObjects(table);
      if (snap === null) {
        if (!r.notEvaluated.includes('provider state')) r.notEvaluated.push('provider state');
        continue;
      }
      for (const x of mine) {
        const p = snap.find((s) => s.ref === x.provider_ref);
        if (!p)
          r.findings.push({
            kind: 'missing_at_provider',
            subjectKind: table,
            subjectRef: x.id as string,
            result: 'missing',
            observed: { providerRef: x.provider_ref },
          });
        else if (
          ['active', 'running'].includes(x.state as string) &&
          !['active', 'running', 'available'].includes(p.state)
        )
          r.findings.push({
            kind: 'state_mismatch',
            subjectKind: table,
            subjectRef: x.id as string,
            result: 'drift',
            observed: { ours: x.state, provider: p.state },
          });
      }
      for (const p of snap)
        if (!mine.some((x) => x.provider_ref === p.ref))
          r.findings.push({
            kind: 'unknown_to_platform',
            subjectKind: table,
            subjectRef: p.ref,
            result: 'orphan_suspected',
            observed: { provider: p.state },
          });
    }
  }
}
