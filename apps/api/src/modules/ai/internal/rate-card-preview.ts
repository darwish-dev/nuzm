import {
  FxUnavailableError,
  StaticFxRateSource,
  deriveRateCard,
  validateRateCardHistory,
  type FxQuote,
} from '@nuzm/adapter-model';

/**
 * Rate-card PREVIEW for the owner (D6): the customer price per million tokens derived from the vendor's list price, an FX quote, a margin and a credit unit, with every input shown.
 * Pure and offline: it invents no rate (the FX quote, the margin and the vendor price are the CALLER's), saves nothing, and never touches a provider. The output is the JSON of the
 * `configure` action's `rateCard` field plus the basis to record; the owner pastes it into the admin console, which versions it (`GET …/{id}/rate-card-versions`).
 */
export interface RateCardPreviewInput {
  vendorCurrency: string;
  walletCurrency: string;
  creditUnitMinor: number;
  marginBps: number;
  /** where the vendor price comes from (a document id or a dated page): required, never a default */
  vendorPriceRef: string;
  prices: Record<string, { inputPerMillion: string; outputPerMillion: string }>;
  /** the FX quote used when the currencies differ (the caller supplies it, with its date and source) */
  fx?: FxQuote;
  /** a label for the draft version (default `draft`) */
  version?: string;
}
export type RateCardPreviewResult =
  | {
      ok: true;
      rateCard: {
        models: Record<string, { creditsPerMillionInput: string; creditsPerMillionOutput: string }>;
      };
      basis: unknown;
      warnings: string[];
    }
  | { ok: false; problems: string[] };

export async function previewRateCard(
  i: RateCardPreviewInput,
  at: Date = new Date(),
): Promise<RateCardPreviewResult> {
  const quotes = i.vendorCurrency === i.walletCurrency ? [] : i.fx ? [i.fx] : [];
  try {
    const card = await deriveRateCard(new StaticFxRateSource(quotes), at, i.version ?? 'draft', {
      vendorCurrency: i.vendorCurrency,
      walletCurrency: i.walletCurrency,
      creditUnitMinor: i.creditUnitMinor,
      marginBps: i.marginBps,
      vendorPriceRef: i.vendorPriceRef,
      prices: i.prices,
    });
    const history = validateRateCardHistory([card]);
    if (history.length > 0) return { ok: false, problems: history };
    const warnings: string[] = [];
    if (i.marginBps === 0)
      warnings.push('the margin is zero: the customer price equals the converted vendor price');
    if (i.vendorCurrency !== i.walletCurrency && i.fx)
      warnings.push(
        `FX ${i.fx.from}→${i.fx.to} ${i.fx.rate} as of ${i.fx.asOf} (${i.fx.source}): confirm it is the rate the owner wants to use`,
      );
    return { ok: true, rateCard: { models: card.models }, basis: card.basis, warnings };
  } catch (e) {
    if (e instanceof FxUnavailableError)
      return { ok: false, problems: [`no usable FX rate (${e.reason}): supply a dated quote`] };
    if (e instanceof RangeError) return { ok: false, problems: [e.message] };
    throw e;
  }
}
