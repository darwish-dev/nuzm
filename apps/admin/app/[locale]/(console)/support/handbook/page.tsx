import { t, tDynamic } from '@nuzm/i18n';
import { Banner, Card, Ltr, PageTitle, Table } from '@nuzm/ui';
import { OpsTabs } from '../../../../../components/M12Tabs';
import { gate } from '../../../../../lib/gate';
import { HANDBOOK_GROUPS, RUNBOOK_INDEX_PATH, runbookPath } from '../../../../../lib/handbook';

/**
 * UI-M12-17: support handbook: a static index of the runbooks in `docs/runbooks/`. Plain-text repository paths, no links and no data fetch. The M12
 * runbooks are drafts that have not been exercised (AC-M12-18). The escalation matrix is not recorded in the repository yet, and is not invented here.
 */
export default async function Handbook({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gate(params, 'admin:ops:read', 'm12.hb.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  return (
    <>
      <PageTitle>{t(locale, 'm12.hb.title')}</PageTitle>
      <OpsTabs locale={locale} current="handbook" can={s.can} />
      <Banner tone="warn">{t(locale, 'm12.hb.status')}</Banner>
      <p className="nz-muted">
        {t(locale, 'm12.hb.help')} <Ltr>{RUNBOOK_INDEX_PATH}</Ltr>
      </p>
      <Card aria-labelledby="hb-esc">
        <h2 className="nz-h2" id="hb-esc">
          {t(locale, 'm12.hb.escalation')}
        </h2>
        <p>{t(locale, 'm12.hb.escalationBody')}</p>
      </Card>
      {HANDBOOK_GROUPS.map((grp) => (
        <section key={grp.key} aria-label={t(locale, `m12.hb.cat.${grp.key}`)}>
          <Table
            caption={t(locale, `m12.hb.cat.${grp.key}`)}
            rows={[...grp.slugs]}
            rowKey={(slug) => slug}
            columns={[
              {
                key: 'f',
                header: t(locale, 'm12.hb.col.file'),
                render: (slug) => <Ltr>{runbookPath(slug)}</Ltr>,
              },
              {
                key: 'p',
                header: t(locale, 'm12.hb.col.purpose'),
                render: (slug) => tDynamic(locale, `m12.hb.e.${slug}`, slug),
              },
            ]}
          />
        </section>
      ))}
    </>
  );
}
