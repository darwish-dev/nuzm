import { Icon } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import { pick } from '../../lib/site-content';
import { PUBLIC_SERVICE_PLANS, type PublicPlanService } from '../../lib/public-service-plans';

export function ServicePlans({ locale, slug }: { locale: Locale; slug: string }) {
  if (!Object.hasOwn(PUBLIC_SERVICE_PLANS, slug)) return null;
  const plans = PUBLIC_SERVICE_PLANS[slug as PublicPlanService];
  if (!plans.length) return null;
  return (
    <section
      className="section wrap svc-section svc-plans-section"
      id="plans"
      aria-labelledby="svc-plans-title"
    >
      <div className="svc-head">
        <span className="eyebrow">{locale === 'ar' ? 'الباقات والأسعار' : 'PLANS & PRICING'}</span>
        <h2 id="svc-plans-title">
          {locale === 'ar' ? 'مساحة تناسب طموحك.' : 'Room for your next move.'}
        </h2>
      </div>
      <div className="svc-public-plans">
        {plans.map((plan) => (
          <article key={plan.id} className="svc-public-plan">
            <h3>{pick(plan.name, locale)}</h3>
            <p>{pick(plan.description, locale)}</p>
            <div className="svc-public-price">
              <strong>
                {new Intl.NumberFormat(locale, {
                  style: 'currency',
                  currency: plan.currency,
                  maximumFractionDigits: 2,
                }).format(plan.monthlyAmountMinor / 100)}
              </strong>
              <span>{locale === 'ar' ? '/ شهر' : '/ month'}</span>
            </div>
            <ul>
              {plan.features.map((feature, i) => (
                <li key={i}>
                  <Icon name="check" size={15} />
                  {pick(feature, locale)}
                </li>
              ))}
            </ul>
            <a className="button button-white" href={`/${locale}${plan.href}`}>
              {locale === 'ar' ? 'اختر الباقة' : 'Choose plan'}
              <Icon name="arrow" size={15} />
            </a>
          </article>
        ))}
      </div>
    </section>
  );
}
