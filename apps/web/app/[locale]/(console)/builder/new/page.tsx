import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BuilderWizard } from '../../../../../components/BuilderWizard';
import { unwrapCall } from '../../../../../lib/compute';
import type { Credits } from '../../../../../lib/builder';
import { builderGuard, builderView } from '../../../../../lib/builder-view';

/** UI-M09-02: the new-site wizard (describe → languages → template → budget → review). */
export default async function NewProject({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const g = await builderGuard(locale, 'builder:write', 'bld.wiz.title');
  if (!g.ok) return g.denied;
  const canRun = g.s.can('ai:write');
  const body = await builderView(
    locale,
    async () => {
      // the balance is informational: a failure to read it must not block the wizard
      const r = await g.c.get<Credits>('/v1/ai/credits');
      if (r.response.status === 404) await unwrapCall(Promise.resolve(r)); // the whole surface is off: "not available"
      return r.response.ok ? (r.data ?? null) : null;
    },
    (wallet) => <BuilderWizard locale={locale} credits={wallet} canRun={canRun} />,
  );
  return (
    <>
      <PageTitle>{t(locale, 'bld.wiz.title')}</PageTitle>
      {body}
    </>
  );
}
