import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import type { PriceBookService } from '../../billing';
import type { PriceContext, PricerResult, QuotePricer } from '../../commerce';
import { priceLines, type DataProviderService } from '../../data';

/**
 * `email` quotes (docs/04): one item `{type: 'mailbox', quotaMb}` — a mailbox for one month (`email.mailbox_months`) plus its quota as GiB-months
 * (`email.mailbox_storage_gb_months`). Transactional messages have no quote: they are metered per provider-accepted message. An offer exists only when an enabled
 * mailbox provider reports provisioning as supported; a meter with no price is `kind_not_available`.
 */
export class EmailPricer implements QuotePricer {
  readonly kind = 'email' as const;
  constructor(
    private readonly db: Db,
    private readonly prices: PriceBookService,
    private readonly providers: DataProviderService,
  ) {}
  async price(ctx: PriceContext, items: unknown[]): Promise<PricerResult> {
    if (items.length !== 1)
      throw new ProblemException(
        'validation_failed',
        'an email quote has exactly one item: {type: mailbox, quotaMb}',
      );
    const i = items[0] as Record<string, unknown>;
    if (i.type !== 'mailbox')
      throw new ProblemException('validation_failed', 'type must be mailbox');
    if (
      !Number.isInteger(i.quotaMb) ||
      (i.quotaMb as number) < 100 ||
      (i.quotaMb as number) > 1_048_576
    )
      throw new ProblemException('validation_failed', 'quotaMb must be an integer of 100..1048576');
    const p = await this.providers.resolveEnabled(ctx.orgId, 'mailbox');
    if (p.row.probe?.capabilities?.['mailbox.provision'] !== 'supported' || !p.row.probe?.passed)
      throw new ProblemException(
        'unsupported_capability',
        "the provider's probe does not report mailbox provisioning as supported",
      );
    const gib = ((BigInt(i.quotaMb as number) * 10n ** 8n) / 1024n).toString().padStart(9, '0');
    const gibQty = `${gib.slice(0, -8)}.${gib.slice(-8)}`;
    const priced = await priceLines(this.db, this.prices, ctx, [
      {
        meterId: 'email.mailbox_months',
        quantity: '1',
        unit: 'mailbox_month',
        description: 'Mailbox (one month)',
        details: { type: 'mailbox', quotaMb: i.quotaMb, providerId: p.row.id },
      },
      {
        meterId: 'email.mailbox_storage_gb_months',
        quantity: gibQty,
        unit: 'gib_month',
        description: `${gibQty} GiB mailbox storage (monthly estimate)`,
        details: { quotaMb: i.quotaMb },
      },
    ]);
    return { items: priced.items, priceBookVersionId: priced.priceBookVersionId };
  }
}
