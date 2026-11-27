import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Card, ForbiddenState, Ltr, PageTitle } from '@nuzm/ui';
import { PrivacyTabs } from '../components/PrivacyTabs';
import { AiRegionSwitch, ResidencyForm } from '../components/PrivacyPanels';
import { requireSession } from '../lib/server';
import { view } from '../lib/view';

/** UI-M04-05: the organization's residency policy: tighten only (the platform floor is shown), with the floor-violation message from the API. */
export default async function DataResidency({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('privacy:residency:read'))
    return (
      <>
        <PageTitle>{t(locale, 'pv.res.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/compliance/residency-policy', {})),
    (p) => (
      <>
        <AiRegionSwitch
          key={`ai-${p.version}`}
          locale={locale}
          version={p.version}
          mode={p.mode}
          countries={p.allowedCountriesByClass}
          canEdit={s.can('privacy:residency:manage')}
        />
        <ResidencyForm
          key={p.version}
          locale={locale}
          version={p.version}
          mode={p.mode}
          countries={p.allowedCountriesByClass}
          floorClasses={Object.keys(p.floor.byClass)}
          canEdit={s.can('privacy:residency:manage')}
        />
        <Card aria-labelledby="rs-floor">
          <h2 className="nz-h2" id="rs-floor">
            {t(locale, 'pv.res.floor')}
          </h2>
          <ul>
            {Object.entries(p.floor.byClass).map(([k, m]) => (
              <li key={k}>
                <Ltr>{k}</Ltr>: {tDynamic(locale, `pv.res.mode.${m}`, m)}
              </li>
            ))}
          </ul>
        </Card>
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'pv.res.title')}</PageTitle>
      <PrivacyTabs locale={locale} current="residency" can={s.can} />
      <p className="nz-muted">{t(locale, 'pv.res.help')}</p>
      {body}
    </>
  );
}
