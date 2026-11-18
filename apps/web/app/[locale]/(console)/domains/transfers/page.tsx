import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, ForbiddenState, Icon, Ltr, PageTitle, Table } from '@nuzm/ui';
import { TransferForm } from '../../../../../components/DomainPanels';
import { domainTone } from '../../../../../lib/domains';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M07-07: transfers list and the start-transfer form (authorization code is write-only); locked and unsupported states have their own messages. */
export default async function Transfers({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('domain:read'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.tr.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const list = await view(
    locale,
    () => unwrap(s.api.GET('/v1/domains/transfers', { params: { query: { limit: 100 } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'dom.tr.empty')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'dom.tr.title')}
          rows={data.items as { id: string; name: string; state: string; createdAt: string }[]}
          rowKey={(r) => r.id}
          columns={[
            { key: 'n', header: t(locale, 'dom.col.name'), render: (r) => <Ltr>{r.name}</Ltr> },
            {
              key: 's',
              header: t(locale, 'dom.col.state'),
              icon: 'pulse',
              render: (r) => (
                <Badge
                  tone={domainTone(
                    r.state === 'completed'
                      ? 'active'
                      : r.state === 'failed'
                        ? 'failed'
                        : 'pending',
                  )}
                >
                  {tDynamic(locale, `dom.tr.state.${r.state}`, r.state)}
                </Badge>
              ),
            },
            { key: 'c', header: '', render: (r) => formatDateTime(r.createdAt, locale) },
          ]}
        />
      ),
  );
  return (
    <>
      <a className="nzc-back" href={`/${locale}/domains`}>
        <Icon name="chevron" size={16} />
        {t(locale, 'dom.tab.list')}
      </a>
      <PageTitle>{t(locale, 'dom.tr.title')}</PageTitle>
      {s.can('domain:write') && (
        // the "Transfer a domain" button of the domains page lands here
        <section
          id="start"
          className="nzc-dsearch"
          aria-labelledby="tr-h"
          style={{ scrollMarginBlockStart: 18 }}
        >
          <div className="nzc-dsearch-inner">
            <h2 id="tr-h">{t(locale, 'dom.tr.start')}</h2>
            <p className="nzc-dsearch-sub">{t(locale, 'dom.tr.hero.body')}</p>
            <ol className="nzc-steps-row">
              <li>{t(locale, 'dom.tr.step1')}</li>
              <li>{t(locale, 'dom.tr.step2')}</li>
              <li>{t(locale, 'dom.tr.step3')}</li>
            </ol>
            <TransferForm locale={locale} />
          </div>
        </section>
      )}
      <section aria-labelledby="tr-list">
        <div className="nzc-dres-head">
          <h2 id="tr-list">{t(locale, 'dom.tr.list')}</h2>
        </div>
        {list}
      </section>
    </>
  );
}
