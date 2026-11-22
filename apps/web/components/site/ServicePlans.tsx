import { Icon } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import {
  GROUP_TITLE,
  fetchPublicPlans,
  formatPlanPrice,
  planFeatures,
  plansForService,
  runtimeKinds,
  type PublicPlan,
} from '../../lib/public-service-plans';

/** The plan cards of a service page: published plans only (limits and price from the API), grouped by family. Renders nothing for a page with no published plans. */
const RUNTIME_ROWS = ['PHP', 'Node.js', 'Python', 'Static'] as const;

/** The plan cards of a service page, laid out as a pricing table: name, price, a full-width button, what is included and what it runs. Published plans only (limits and price from the API), grouped by family. Renders nothing for a page with no published plans. */
export function PlanCards({
  locale,
  slug,
  plans,
}: {
  locale: Locale;
  slug: string;
  plans: PublicPlan[];
}) {
  const groups = plansForService(slug, plans);
  if (groups.length === 0) return null;
  const ar = locale === 'ar';
  return (
    <section
      className="section wrap svc-section svc-plans-section"
      id="plans"
      aria-labelledby="svc-plans-title"
    >
      <div className="svc-head">
        <span className="eyebrow">{ar ? 'الباقات والأسعار' : 'PLANS & PRICING'}</span>
        <h2 id="svc-plans-title">
          {ar ? 'اختر ما يناسب مشروعك.' : 'Pick what fits your project.'}
        </h2>
      </div>
      {groups.map(({ group, plans: list }) => (
        <div key={group} className="pl-group">
          {groups.length > 1 && <h3 className="pl-group-title">{GROUP_TITLE[group][locale]}</h3>}
          <div className="pl-grid" data-count={list.length}>
            {list.map((plan, i) => {
              const featured = list.length === 3 && i === 1;
              const kinds = runtimeKinds(plan.runtimes);
              return (
                <article key={plan.key} className={`pl-card${featured ? ' is-featured' : ''}`}>
                  <h3 className="pl-name">{plan.name[locale]}</h3>
                  <p className="pl-sub">
                    {planFeatures(plan, locale)[0]} · {planFeatures(plan, locale)[1]}
                  </p>
                  <div className="pl-price">
                    <strong>
                      {formatPlanPrice(plan.price.amountMinor, plan.price.currency, locale)}
                    </strong>
                    <span>{ar ? '/شهر' : '/mo'}</span>
                  </div>
                  <a
                    className={`button pl-button ${featured ? 'button-blue' : 'button-outline'}`}
                    href="/hosting/sites/new"
                  >
                    {ar ? 'اختر الباقة' : 'Choose plan'}
                  </a>
                  <p className="pl-fine">
                    {ar
                      ? 'تُحاسَب شهريًا لكل موقع. يُؤكَّد توفّر الباقة لحسابك ومنطقتك قبل الشراء.'
                      : 'Billed monthly, per site. Availability for your account and region is confirmed before you buy.'}
                  </p>
                  <div className="pl-block">
                    <h4>{ar ? 'ما تتضمنه:' : 'Included:'}</h4>
                    <ul>
                      {planFeatures(plan, locale).map((f) => (
                        <li key={f}>
                          <Icon name="check" size={15} />
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="pl-block">
                    <h4>{ar ? 'يعمل مع:' : 'Runs:'}</h4>
                    <ul dir="ltr">
                      {RUNTIME_ROWS.map((r) => {
                        const has = kinds.includes(r);
                        return (
                          <li key={r} className={has ? undefined : 'is-off'}>
                            {has ? <Icon name="check" size={15} /> : <i aria-hidden="true">–</i>}
                            {r}
                            {!has && (
                              <span className="sr-only">
                                {ar ? ' (غير متاح)' : ' (not included)'}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      ))}
      <p className="pl-all">
        <a href="/hosting/plans">
          {ar ? 'قارن كل الباقات في لوحة التحكم' : 'Compare all plans in your dashboard'}
          <Icon name="arrow" size={15} />
        </a>
      </p>
    </section>
  );
}

/** Server wrapper: fetches the published plans and shows the cards. */
export async function ServicePlans({ locale, slug }: { locale: Locale; slug: string }) {
  const plans = await fetchPublicPlans();
  return <PlanCards locale={locale} slug={slug} plans={plans} />;
}
