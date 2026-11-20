import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, ButtonLink, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';
import { VerifyButton } from '../../../../../components/DomainAdminPanels';

/** UI-M07-09: registrar accounts, health and capability matrix; every vendor result is tagged NOT VERIFIED until live evidence exists (HG-07-01). */
export default async function Registrars({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:domains:read'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.admin.reg.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/registrars', {})),
    (data) =>
      data.accounts.length === 0 ? (
        <EmptyState title={t(locale, 'dom.admin.reg.empty')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'dom.admin.reg.title')}
          rows={data.accounts}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'p',
              header: t(locale, 'dom.admin.reg.col.provider'),
              render: (r) => <Ltr>{r.providerCode}</Ltr>,
            },
            { key: 'a', header: t(locale, 'dom.admin.reg.col.account'), render: (r) => r.label },
            {
              key: 'g',
              header: t(locale, 'dom.admin.reg.col.region'),
              icon: 'pin',
              render: (r) => <Ltr>{r.dataRegion}</Ltr>,
            },
            {
              key: 'h',
              header: t(locale, 'dom.admin.reg.col.health'),
              icon: 'pulse',
              render: (r) => (
                <Badge
                  tone={
                    r.health === 'healthy'
                      ? 'success'
                      : r.health === 'unhealthy'
                        ? 'danger'
                        : 'warn'
                  }
                >
                  {r.health}
                </Badge>
              ),
            },
            {
              key: 'c',
              header: t(locale, 'dom.admin.reg.col.caps'),
              render: (r) => (
                <Ltr>
                  {Object.entries(r.capabilities)
                    .filter(([, v]) => v === 'supported')
                    .map(([k]) => k.replace('registrar.', ''))
                    .join(', ') || '—'}
                </Ltr>
              ),
            },
            {
              key: 'e',
              header: t(locale, 'dom.admin.reg.col.evidence'),
              render: (r) => (
                <Badge tone={r.verification === 'LIVE-VERIFIED' ? 'success' : 'warn'}>
                  {r.verification === 'LIVE-VERIFIED'
                    ? t(locale, 'dom.admin.live')
                    : t(locale, 'dom.admin.verified')}
                </Badge>
              ),
            },
            {
              key: 'v',
              header: '',
              render: (r) =>
                s.can('admin:domains:manage') ? (
                  <VerifyButton locale={locale} id={r.id} mfaFactorId={s.me.mfaFactorId ?? null} />
                ) : null,
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'dom.admin.reg.title')}</PageTitle>
      <p>
        <ButtonLink variant="secondary" href={`/${locale}/domains/registrars/dnet`}>
          {t(locale, 'dom.dnet.open')}
        </ButtonLink>
      </p>
      {body}
    </>
  );
}
