import { ProblemException } from '../../../common/errors';

/**
 * The invoice-issuer model for reseller sub-organizations (M11 S54.4; D-24 is OPEN, HG-03-04 PENDING).
 *   platform_issues_wholesale : the platform invoices the reseller at wholesale; the reseller invoices its customers itself.
 *   reseller_issues_own       : the reseller issues retail invoices to its sub-organizations under its own legal entity.
 *   disabled                  : nobody issues retail invoices for sub-organizations (the default, and the ONLY value the database accepts).
 * The agent must not decide D-24: `APPROVED_ISSUER_MODEL` is `null`, and it can only be changed by a person in a reviewed commit AFTER the decision is recorded in docs/07 and the tax advisor has signed
 * (HG-03-04); the invoicing.billing_entities CHECK constraint must be widened by a migration at the same time. Until then every request for a model other than `disabled` resolves to `disabled` with
 * status BLOCKED, and no API, setting or environment variable can switch one on.
 */
export type IssuerModel = 'platform_issues_wholesale' | 'reseller_issues_own' | 'disabled';
export const ISSUER_MODELS: readonly IssuerModel[] = ['platform_issues_wholesale', 'reseller_issues_own', 'disabled'];
export const APPROVED_ISSUER_MODEL: Exclude<IssuerModel, 'disabled'> | null = null;

export interface IssuerResolution {
  model: IssuerModel;
  status: 'disabled' | 'BLOCKED' | 'enabled';
  requested: string | null;
  reason: string;
}

export function resolveIssuerModel(requested: string | undefined | null, approved: IssuerModel | null = APPROVED_ISSUER_MODEL): IssuerResolution {
  if (requested === undefined || requested === null || requested === '' || requested === 'disabled')
    return { model: 'disabled', status: 'disabled', requested: requested ?? null, reason: 'no issuer model is enabled (D-24 open)' };
  if (!ISSUER_MODELS.includes(requested as IssuerModel)) return { model: 'disabled', status: 'BLOCKED', requested, reason: `unknown issuer model '${requested}': treated as disabled` };
  if (approved !== null && requested === approved) return { model: approved, status: 'enabled', requested, reason: 'the model approved in D-24' };
  return { model: 'disabled', status: 'BLOCKED', requested, reason: `BLOCKED: '${requested}' is not the model approved in D-24 (D-24 is open); it cannot be enabled by configuration` };
}

export class IssuerModelGate {
  private readonly res: IssuerResolution;
  constructor(requested: string | undefined | null = process.env.RESELLER_ISSUER_MODEL, approved: IssuerModel | null = APPROVED_ISSUER_MODEL) {
    this.res = resolveIssuerModel(requested, approved);
  }
  current(): IssuerResolution {
    return this.res;
  }
  /** Throws 409 `issuer_model_blocked` unless the active model is enabled (i.e. approved). Called before ANY invoice for a sub-organization is created. */
  assertEnabled(): IssuerModel {
    if (this.res.status !== 'enabled') throw new ProblemException('issuer_model_blocked', this.res.reason);
    return this.res.model;
  }
}

/**
 * Scenario pack for the tax advisor (HG-03-04): what the lines WOULD be under each model for one set of figures. A dry run: it never creates a document. (wholesale, retail, refund, marketplace)
 */
export interface ScenarioInput {
  wholesaleMinor: bigint;
  retailMinor: bigint;
  vatRateBps: number;
  currency: string;
}
export interface ScenarioLine {
  description: string;
  issuer: string;
  recipient: string;
  netMinor: string;
  vatMinor: string;
  note: string;
}
export function scenarioPack(i: ScenarioInput): { scenario: string; model: IssuerModel; lines: ScenarioLine[] }[] {
  const vat = (n: bigint) => ((n * BigInt(i.vatRateBps)) / 10_000n).toString();
  const margin = i.retailMinor - i.wholesaleMinor;
  return [
    {
      scenario: 'wholesale',
      model: 'platform_issues_wholesale',
      lines: [{ description: 'Platform usage at wholesale', issuer: 'Nuzm', recipient: 'reseller', netMinor: i.wholesaleMinor.toString(), vatMinor: vat(i.wholesaleMinor), note: 'the reseller resells under its own legal entity' }],
    },
    {
      scenario: 'retail',
      model: 'reseller_issues_own',
      lines: [
        { description: 'Platform usage at retail', issuer: 'reseller', recipient: 'sub-organization', netMinor: i.retailMinor.toString(), vatMinor: vat(i.retailMinor), note: `margin ${margin.toString()} ${i.currency} stays with the reseller; its own e-invoicing obligations apply (ZATCA)` },
        { description: 'Platform usage at wholesale', issuer: 'Nuzm', recipient: 'reseller', netMinor: i.wholesaleMinor.toString(), vatMinor: vat(i.wholesaleMinor), note: 'the platform bills the reseller' },
      ],
    },
    {
      scenario: 'refund',
      model: 'reseller_issues_own',
      lines: [
        { description: 'Credit note to the sub-organization', issuer: 'reseller', recipient: 'sub-organization', netMinor: i.retailMinor.toString(), vatMinor: vat(i.retailMinor), note: 'full refund of the retail invoice' },
        { description: 'Credit note to the reseller', issuer: 'Nuzm', recipient: 'reseller', netMinor: i.wholesaleMinor.toString(), vatMinor: vat(i.wholesaleMinor), note: 'only if the platform refunds the wholesale charge: a policy decision' },
      ],
    },
    {
      scenario: 'marketplace',
      model: 'platform_issues_wholesale',
      lines: [{ description: 'Marketplace licence', issuer: 'Nuzm (principal assumed)', recipient: 'buyer', netMinor: i.retailMinor.toString(), vatMinor: vat(i.retailMinor), note: 'publisher share is ACCRUED (ledger 2600), not paid out (D-26); principal-vs-agent treatment needs the advisor' }],
    },
  ];
}
