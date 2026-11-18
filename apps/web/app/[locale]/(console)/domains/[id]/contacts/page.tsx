import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle, Icon } from '@nuzm/ui';
import { ContactsForm } from '../../../../../../components/DomainPanels';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** UI-M07-06: contacts per the registrar's requirements, privacy availability, the consent notice and the cross-border (residency) blocked state. Masked without domain:write. */
export default async function Contacts({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('domain:read'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.contacts.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/domains/{id}', { params: { path: { id } } })),
    (d) => {
      const r =
        (d.contacts as { registrant?: Record<string, unknown> } | undefined)?.registrant ?? {};
      const a = (r.address ?? {}) as Record<string, string>;
      return (
        <ContactsForm
          locale={locale}
          id={d.id}
          version={d.version}
          canEdit={s.can('domain:write') && d.capabilities.contacts === true}
          privacyOn={d.privacyState === 'on'}
          initial={{
            firstName: String(r.firstName ?? ''),
            lastName: String(r.lastName ?? ''),
            organization: String(r.organization ?? ''),
            email: String(r.email ?? ''),
            phone: String(r.phone ?? ''),
            street: a.street ?? '',
            city: a.city ?? '',
            postalCode: a.postalCode ?? '',
            country: a.country ?? 'SA',
          }}
        />
      );
    },
  );
  return (
    <>
      <a className="nzc-back" href={`/${locale}/domains/${id}`}>
        <Icon name="chevron" size={16} />
        {t(locale, 'dom.detail.title')}
      </a>
      <PageTitle>{t(locale, 'dom.contacts.title')}</PageTitle>
      {body}
    </>
  );
}
