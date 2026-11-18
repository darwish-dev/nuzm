import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { InvoiceService, TaxService } from '../../invoicing';
import type { RatingService } from '../../metering';
import { IssuerModelGate, scenarioPack, type IssuerResolution } from './issuer';
import { RESELLER_FLAG, badRequest, iso, type Row } from './model';
import { retailAmount, ruleAt } from './pricing';
import type { ResellerService } from './reseller.service';

export interface StatementLine {
  subOrgId: string;
  meterId: string;
  quantity: string;
  wholesaleMinor: string;
  retailMinor: string;
  marginMinor: string;
  ruleSetVersion: number | null;
}
export interface StatementDto {
  resellerId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  /** `true` while the period is still open: the figures can change and nothing is stored. A closed period is stored once and never changes. */
  provisional: boolean;
  totals: { wholesaleMinor: string; retailMinor: string; marginMinor: string; taxMinor: string };
  taxStatus: 'provisional';
  ledger: { wholesaleMinor: string; varianceMinor: string };
  issuer: IssuerResolution;
  subOrganizations: number;
  lines: StatementLine[];
  createdAt: string | null;
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const lastDay = (periodStart: string) => {
  const d = new Date(`${periodStart}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};
const csvCell = (v: string) => {
  const t = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/**
 * Reseller statements (M11 S54.3): per sub-organization and meter, the WHOLESALE cost (the platform's own rating of that organization's usage), the RETAIL amount (the price rule in force at the
 * end of the period applied to it: integer arithmetic), the margin, the VAT estimate, and the figure the LEDGER shows for the same organizations and period (variance 0 when the invoices were
 * closed from the same rating). Only aggregates and metadata: no content of a sub-organization is read. A closed period is stored once (immutable); the open period is computed on demand.
 * The invoice-issuer model is part of the statement: while D-24 is open it says `disabled` / BLOCKED and no retail invoice exists.
 */
export class StatementService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly resellers: ResellerService,
    private readonly rating: Pick<RatingService, 'rate'>,
    private readonly tax: Pick<TaxService, 'estimate'>,
    private readonly invoices: Pick<InvoiceService, 'usageNetForPeriod'>,
    private readonly gate: IssuerModelGate,
    private readonly flags: { enabled(orgId: string | null, key: string): Promise<boolean> },
    private readonly now: () => Date = () => new Date(),
  ) {}

  defaultPeriod(): string {
    const n = this.now();
    const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1));
    return d.toISOString().slice(0, 7);
  }

  async statement(
    orgId: string,
    actor: string,
    perms: ReadonlySet<string>,
    resellerId: string,
    periodIn?: string,
  ): Promise<StatementDto> {
    const reseller = await this.resellers.ownOnly(orgId, resellerId); // existence first: a foreign id is 404 whatever the flag says
    if (!(await this.flags.enabled(orgId, RESELLER_FLAG)))
      throw new ProblemException(
        'feature_disabled',
        'reseller programs are not enabled for this organization',
      );
    if (!perms.has('reseller:finance') && !perms.has('*'))
      throw new ProblemException('forbidden', 'requires reseller:finance');
    const period = periodIn ?? this.defaultPeriod();
    if (!PERIOD.test(period)) throw badRequest('period must be YYYY-MM');
    const periodStart = `${period}-01`;
    const periodEnd = lastDay(periodStart);
    const currency = (reseller.currency as string).trim();
    const closed = periodEnd < this.now().toISOString().slice(0, 10);

    if (closed) {
      const stored = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT * FROM programs.reseller_statements WHERE reseller_id = $1 AND period_start = $2 AND currency = $3`,
              [reseller.id, periodStart, currency],
            )
          ).rows[0],
      )) as Row | undefined;
      if (stored) return this.fromStored(stored, period, periodEnd);
    }
    const dto = await this.compute(
      orgId,
      reseller,
      period,
      periodStart,
      periodEnd,
      currency,
      !closed,
    );
    if (closed) {
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `INSERT INTO programs.reseller_statements (id, org_id, reseller_id, period_start, period_end, currency, wholesale_minor, retail_minor, margin_minor, tax_minor, lines, rule_set_version, issuer_model, ledger_wholesale_minor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (reseller_id, period_start, currency) DO NOTHING`,
          [
            uuidv7(),
            orgId,
            reseller.id,
            periodStart,
            periodEnd,
            currency,
            dto.totals.wholesaleMinor,
            dto.totals.retailMinor,
            dto.totals.marginMinor,
            dto.totals.taxMinor,
            JSON.stringify(dto.lines),
            dto.lines.find((l) => l.ruleSetVersion)?.ruleSetVersion ?? null,
            dto.issuer.model,
            dto.ledger.wholesaleMinor,
          ],
        ),
      );
      const stored = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT * FROM programs.reseller_statements WHERE reseller_id = $1 AND period_start = $2 AND currency = $3`,
              [reseller.id, periodStart, currency],
            )
          ).rows[0],
      )) as Row;
      await this.audit.record({
        action: 'reseller.statement.generated',
        actorUserId: actor,
        orgId,
        resource: { type: 'reseller_statement', id: stored.id },
        outcome: 'success',
        detail: { period },
      });
      return this.fromStored(stored, period, periodEnd);
    }
    return dto;
  }

  private fromStored(r: Row, period: string, periodEnd: string): StatementDto {
    const lines = r.lines as StatementLine[];
    const ledger = r.ledger_wholesale_minor === null ? '0' : String(r.ledger_wholesale_minor);
    return {
      resellerId: r.reseller_id,
      period,
      periodStart: `${period}-01`,
      periodEnd,
      currency: (r.currency as string).trim(),
      provisional: false,
      totals: {
        wholesaleMinor: String(r.wholesale_minor),
        retailMinor: String(r.retail_minor),
        marginMinor: String(r.margin_minor),
        taxMinor: String(r.tax_minor),
      },
      taxStatus: 'provisional',
      ledger: {
        wholesaleMinor: ledger,
        varianceMinor: (BigInt(r.wholesale_minor) - BigInt(ledger)).toString(),
      },
      issuer: this.gate.current(),
      subOrganizations: new Set(lines.map((l) => l.subOrgId)).size,
      lines,
      createdAt: iso(r.created_at),
    };
  }

  private async compute(
    orgId: string,
    reseller: Row,
    period: string,
    periodStart: string,
    periodEnd: string,
    currency: string,
    provisional: boolean,
  ): Promise<StatementDto> {
    const subs = (await this.resellers.activeSubOrgs(orgId, reseller.id)).filter(
      (s) => (s.accepted_at as Date).toISOString().slice(0, 10) <= periodEnd,
    );
    const rules = await this.resellers.storedRules(orgId, reseller.id);
    const at = new Date(`${periodEnd}T23:59:59Z`);
    const lines: StatementLine[] = [];
    let ledger = 0n;
    for (const s of subs) {
      const run = await this.rating.rate(s.sub_org_id, periodStart, { currency });
      const byMeter = new Map<string, { w: bigint; q: bigint }>();
      for (const r of run.rows) {
        const e = byMeter.get(r.meterId) ?? { w: 0n, q: 0n };
        e.w += BigInt(r.amountMinor);
        e.q += decimalToScaled(r.billableQuantity);
        byMeter.set(r.meterId, e);
      }
      for (const [meterId, e] of [...byMeter.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const rule = ruleAt(rules, { meterId }, at);
        const retail = retailAmount(e.w, scaledToDecimal(e.q), rule?.markup ?? null);
        lines.push({
          subOrgId: s.sub_org_id,
          meterId,
          quantity: scaledToDecimal(e.q),
          wholesaleMinor: e.w.toString(),
          retailMinor: retail.toString(),
          marginMinor: (retail - e.w).toString(),
          ruleSetVersion: rule?.ruleSetVersion ?? null,
        });
      }
      ledger += await this.invoices.usageNetForPeriod(s.sub_org_id, periodStart, currency);
    }
    const w = lines.reduce((a, l) => a + BigInt(l.wholesaleMinor), 0n);
    const r = lines.reduce((a, l) => a + BigInt(l.retailMinor), 0n);
    const taxMinor =
      r > 0n
        ? ((await this.tax.estimate(orgId, [r], this.now()).catch(() => null))?.taxMinor ?? 0n)
        : 0n;
    return {
      resellerId: reseller.id,
      period,
      periodStart,
      periodEnd,
      currency,
      provisional,
      totals: {
        wholesaleMinor: w.toString(),
        retailMinor: r.toString(),
        marginMinor: (r - w).toString(),
        taxMinor: taxMinor.toString(),
      },
      taxStatus: 'provisional',
      ledger: { wholesaleMinor: ledger.toString(), varianceMinor: (w - ledger).toString() },
      issuer: this.gate.current(),
      subOrganizations: subs.length,
      lines,
      createdAt: null,
    };
  }

  toCsv(s: StatementDto): string {
    const head = [
      'period',
      'subOrganizationId',
      'meter',
      'quantity',
      'wholesale_minor',
      'retail_minor',
      'margin_minor',
      'currency',
    ];
    const rows = s.lines.map((l) => [
      s.period,
      l.subOrgId,
      l.meterId,
      l.quantity,
      l.wholesaleMinor,
      l.retailMinor,
      l.marginMinor,
      s.currency,
    ]);
    rows.push([
      s.period,
      'TOTAL',
      '',
      '',
      s.totals.wholesaleMinor,
      s.totals.retailMinor,
      s.totals.marginMinor,
      s.currency,
    ]);
    return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  /**
   * Issue a (retail) invoice for a sub-organization. BLOCKED: the gate answers 409 `issuer_model_blocked` for every model while D-24 is open, BEFORE anything is created. Kept as the single entry point so
   * that a future approved model plugs in behind the gate and nothing else can create such an invoice.
   */
  async issueSubOrgInvoice(
    orgId: string,
    perms: ReadonlySet<string>,
    resellerId: string,
    subOrgId: string,
    period: string,
  ): Promise<never> {
    if (!perms.has('reseller:finance') && !perms.has('*'))
      throw new ProblemException('forbidden', 'requires reseller:finance');
    await this.resellers.ownOnly(orgId, resellerId);
    if (!PERIOD.test(period)) throw badRequest('period must be YYYY-MM');
    this.gate.assertEnabled();
    // unreachable until D-24 is decided and a model is approved in code review: there is intentionally no invoice-creating code here
    throw new ProblemException(
      'issuer_model_blocked',
      `invoice issuing for ${subOrgId} is not implemented for the approved model yet`,
    );
  }

  /** Scenario pack for the tax advisor (HG-03-04), from a statement's figures. A dry run: no document is created. */
  scenarios(s: StatementDto, vatRateBps = 1500) {
    return scenarioPack({
      wholesaleMinor: BigInt(s.totals.wholesaleMinor),
      retailMinor: BigInt(s.totals.retailMinor),
      vatRateBps,
      currency: s.currency,
    });
  }
}

const SCALE = 10n ** 8n;
function decimalToScaled(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) return 0n;
  return BigInt(m[1]!) * SCALE + BigInt((m[2] ?? '').padEnd(8, '0'));
}
function scaledToDecimal(n: bigint): string {
  const i = n / SCALE;
  const f = (n % SCALE).toString().padStart(8, '0').replace(/0+$/, '');
  return f ? `${i}.${f}` : `${i}`;
}
