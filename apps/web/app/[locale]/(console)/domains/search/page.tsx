import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, ButtonLink, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { DomainTabs } from '../../../../../components/DomainTabs';
import { money, reasonKey } from '../../../../../lib/domains';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M07-02: search with price, premium flag and eligibility; a TLD that is not sold is shown disabled WITH the reason; unknown answers are never "available". */
export default async function Search({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; tlds?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const sp = await searchParams;
  const s = await requireSession(locale);
  if (!s.org || !s.can('domain:search'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.search.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const form = (
    <form
      method="get"
      className="nz-card"
      aria-label={t(locale, 'dom.search.title')}
      style={{ maxInlineSize: 560 }}
    >
      <div className="nz-field">
        <label htmlFor="sq">{t(locale, 'dom.search.q')}</label>
        <input id="sq" name="q" className="nz-input" dir="ltr" defaultValue={sp.q ?? ''} required />
      </div>
      <div className="nz-field">
        <label htmlFor="st">{t(locale, 'dom.search.tlds')}</label>
        <input id="st" name="tlds" className="nz-input" dir="ltr" defaultValue={sp.tlds ?? ''} />
      </div>
      <button className="nz-btn" type="submit">
        {t(locale, 'dom.search.go')}
      </button>
    </form>
  );
  const results = sp.q
    ? await view(
        locale,
        () =>
          unwrap(
            s.api.GET('/v1/domains/search', {
              params: { query: { q: sp.q!, ...(sp.tlds ? { tlds: sp.tlds } : {}) } },
            }),
          ),
        (data) => (
          <Table
            caption={t(locale, 'dom.search.title')}
            rows={data.items}
            rowKey={(r) => r.name}
            columns={[
              { key: 'n', header: t(locale, 'dom.col.name'), render: (r) => <Ltr>{r.name}</Ltr> },
              {
                key: 's',
                header: t(locale, 'dom.col.state'),
                render: (r) =>
                  r.eligibility.state === 'blocked' ? (
                    <>
                      <Badge tone="warn">{t(locale, 'dom.search.blocked')}</Badge>{' '}
                      <span className="nz-muted">{t(locale, reasonKey(r.eligibility.rule))}</span>
                    </>
                  ) : r.available === true ? (
                    <Badge tone="success">
                      {t(locale, 'dom.search.available')}
                      {r.premium ? ` — ${t(locale, 'dom.search.premium')}` : ''}
                    </Badge>
                  ) : r.available === false ? (
                    <Badge>{t(locale, 'dom.search.taken')}</Badge>
                  ) : (
                    <>
                      <Badge tone="warn">{t(locale, 'dom.search.unknown')}</Badge>{' '}
                      <span className="nz-muted">{t(locale, 'dom.search.stale')}</span>
                    </>
                  ),
              },
              {
                key: 'p',
                header: t(locale, 'dom.search.col.price'),
                render: (r) =>
                  r.price ? <Ltr>{money(r.price.amountMinor, r.price.currency)}</Ltr> : '—',
              },
              {
                key: 'a',
                header: '',
                render: (r) =>
                  r.purchasable && s.can('domain:write') ? (
                    <ButtonLink
                      href={`/${locale}/domains/checkout?name=${encodeURIComponent(r.name)}`}
                    >
                      {t(locale, 'dom.search.buy')}
                    </ButtonLink>
                  ) : null,
              },
            ]}
          />
        ),
      )
    : null;
  return (
    <>
      <PageTitle>{t(locale, 'dom.search.title')}</PageTitle>
      <DomainTabs locale={locale} current="search" can={s.can} />
      <p className="nz-muted">{t(locale, 'dom.search.help')}</p>
      {form}
      {results}
    </>
  );
}
