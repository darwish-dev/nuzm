import { Icon } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import { plansForPage, type PlanGroupData } from '../../lib/public-service-plans';
import { PlanTabs } from './PlanTabs';

/** The plan section of a service page: tabs for the plan families and a pricing table for each. Nothing is rendered for a page with nothing published. */
export function PlanSection({
  locale,
  slug,
  groups,
}: {
  locale: Locale;
  slug: string;
  groups: PlanGroupData[];
}) {
  if (groups.length === 0) return null;
  const ar = locale === 'ar';
  const usage = groups[0]!.id === 'usage';
  return (
    <section
      className="section wrap svc-section svc-plans-section"
      id="plans"
      aria-labelledby="svc-plans-title"
      data-service={slug}
    >
      <div className="svc-head">
        <span className="eyebrow">
          {usage ? (ar ? 'الأسعار' : 'PRICING') : ar ? 'الباقات والأسعار' : 'PLANS & PRICING'}
        </span>
        <h2 id="svc-plans-title">
          {usage
            ? ar
              ? 'تدفع مقابل ما تستخدمه فقط.'
              : 'Pay only for what you use.'
            : ar
              ? 'اختر ما يناسب مشروعك.'
              : 'Pick what fits your project.'}
        </h2>
      </div>
      <PlanTabs
        groups={groups}
        labels={{
          tabs: ar ? 'نوع الباقة' : 'Plan type',
          included: ar ? 'ما تتضمنه:' : 'Included:',
          runs: ar ? 'يعمل مع:' : 'Runs:',
          off: ar ? ' (غير متاح)' : ' (not included)',
        }}
      />
      {slug === 'hosting' || slug === 'cloud' ? (
        <p className="pl-all">
          <a href="/hosting/plans">
            {ar ? 'قارن كل الباقات في لوحة التحكم' : 'Compare all plans in your dashboard'}
            <Icon name="arrow" size={15} />
          </a>
        </p>
      ) : null}
    </section>
  );
}

/** Server wrapper: fetches what the API has published for this service and shows it. */
export async function ServicePlans({ locale, slug }: { locale: Locale; slug: string }) {
  return <PlanSection locale={locale} slug={slug} groups={await plansForPage(slug, locale)} />;
}
