import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Card, ForbiddenState, PageTitle, Icon } from '@nuzm/ui';
import { HostingLink } from '../../../../../../components/DomainPanels';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** UI-M07-08: link a domain to a hosting site: proposed records preview, SSL status; disabled while hosting (M06) is not available. */
export default async function Hosting({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('domain:write'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.host.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    async () =>
      unwrap(s.api.GET('/v1/domains/{id}/hosting-links', { params: { path: { id } } })).catch(
        () => null,
      ),
    (cur) => (
      <>
        <HostingLink locale={locale} domainId={id} hostingAvailable={cur !== null} />
        {cur && cur.records.length > 0 ? (
          <Card>
            <h3>{t(locale, 'dom.host.current')}</h3>
            <ul>
              {cur.records.map((r, i) => (
                <li key={i} dir="ltr">
                  {r.name} {r.type}{' '}
                  {typeof r.value === 'string' ? r.value : JSON.stringify(r.value)}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </>
    ),
  );
  return (
    <>
      <a className="nzc-back" href={`/domains/${id}`}>
        <Icon name="chevron" size={16} />
        {t(locale, 'dom.detail.title')}
      </a>
      <PageTitle>{t(locale, 'dom.host.title')}</PageTitle>
      {body}
    </>
  );
}
