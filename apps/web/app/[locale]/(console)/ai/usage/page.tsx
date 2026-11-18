import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Banner, Card, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { AiTabs } from '../../../../../components/AiTabs';
import { TopUpCard } from '../../../../../components/AiUsagePanels';
import {
  TOPUP_PERMISSION,
  byCreditsDesc,
  groupDigits,
  modelRows,
  projectRows,
} from '../../../../../lib/ai';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/**
 * UI-M09-10: credit balance, usage by model and by project (last 30 days), and the top-up card. Visible to every role that may read AI
 * (`ai:read`); the top-up action only to those who may create quotes. The whole surface answers 404 while `ai.enabled` is off (shown as the error state).
 */
export default async function AiUsage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('ai:read'))
    return (
      <>
        <PageTitle>{t(locale, 'aiu.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    async () => {
      const credits = await unwrap(s.api.GET('/v1/ai/credits', {}));
      // project names are a convenience: without `project:read` (or on any failure) the usage rows show the project id instead
      const names = new Map<string, string>();
      if (s.can('project:read'))
        try {
          const projects = await unwrap(
            s.api.GET('/v1/projects', { params: { query: { limit: 100 } } }),
          );
          for (const p of projects.items) names.set(p.id, p.name);
        } catch {
          /* ids are shown instead */
        }
      return { credits, names };
    },
    ({ credits, names }) => {
      const models = byCreditsDesc(modelRows(credits.usage.byModel));
      const projects = byCreditsDesc(projectRows(credits.usage.byProject));
      return (
        <>
          {credits.lowCredit && (
            <Banner tone="warn">
              {t(locale, 'aiu.low', { credits: groupDigits(credits.availableCredits) })}
            </Banner>
          )}
          <div className="nz-grid">
            <Card aria-labelledby="aiu-avail-h">
              <h2 id="aiu-avail-h" className="nz-h2">
                {t(locale, 'aiu.available')}
              </h2>
              <p style={{ fontSize: '1.75rem', margin: 0 }}>
                <Ltr>{groupDigits(credits.availableCredits)}</Ltr>
              </p>
              <p className="nz-muted">{t(locale, 'aiu.available.help')}</p>
            </Card>
            <Card aria-labelledby="aiu-res-h">
              <h2 id="aiu-res-h" className="nz-h2">
                {t(locale, 'aiu.reserved')}
              </h2>
              <p style={{ fontSize: '1.75rem', margin: 0 }}>
                <Ltr>{groupDigits(credits.reservedCredits)}</Ltr>
              </p>
              <p className="nz-muted">{t(locale, 'aiu.reserved.help')}</p>
            </Card>
            <Card aria-labelledby="aiu-30-h">
              <h2 id="aiu-30-h" className="nz-h2">
                {t(locale, 'aiu.last30')}
              </h2>
              <p style={{ fontSize: '1.75rem', margin: 0 }}>
                <Ltr>{groupDigits(credits.last30DaysCredits)}</Ltr>
              </p>
              <p className="nz-muted">
                {t(locale, 'aiu.wallet', { credits: groupDigits(credits.walletCredits) })}
              </p>
            </Card>
          </div>

          <h2 className="nz-h2">{t(locale, 'aiu.byModel')}</h2>
          {models.length === 0 ? (
            <EmptyState title={t(locale, 'aiu.empty.title')} body={t(locale, 'aiu.empty.body')} />
          ) : (
            <Table
              caption={t(locale, 'aiu.byModel')}
              rows={models}
              rowKey={(r) => r.modelRef}
              columns={[
                {
                  key: 'm',
                  header: t(locale, 'aiu.col.model'),
                  render: (r) => <Ltr>{r.modelRef}</Ltr>,
                },
                { key: 'c', header: t(locale, 'aiu.col.calls'), render: (r) => r.calls },
                {
                  key: 'i',
                  header: t(locale, 'aiu.col.tokensIn'),
                  render: (r) => <Ltr>{groupDigits(r.tokensIn)}</Ltr>,
                },
                {
                  key: 'o',
                  header: t(locale, 'aiu.col.tokensOut'),
                  render: (r) => <Ltr>{groupDigits(r.tokensOut)}</Ltr>,
                },
                {
                  key: 'cr',
                  header: t(locale, 'aiu.col.credits'),
                  render: (r) => <Ltr>{groupDigits(r.credits)}</Ltr>,
                },
              ]}
            />
          )}

          <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
            {t(locale, 'aiu.byProject')}
          </h2>
          {projects.length === 0 ? (
            <EmptyState title={t(locale, 'aiu.empty.title')} body={t(locale, 'aiu.empty.body')} />
          ) : (
            <Table
              caption={t(locale, 'aiu.byProject')}
              rows={projects}
              rowKey={(r) => r.projectId ?? 'none'}
              columns={[
                {
                  key: 'p',
                  header: t(locale, 'aiu.col.project'),
                  render: (r) =>
                    r.projectId === null
                      ? t(locale, 'aiu.noProject')
                      : (names.get(r.projectId) ?? <Ltr>{r.projectId}</Ltr>),
                },
                { key: 'c', header: t(locale, 'aiu.col.calls'), render: (r) => r.calls },
                {
                  key: 'cr',
                  header: t(locale, 'aiu.col.credits'),
                  render: (r) => <Ltr>{groupDigits(r.credits)}</Ltr>,
                },
              ]}
            />
          )}
          <p className="nz-muted">{t(locale, 'aiu.usage.window')}</p>

          <TopUpCard locale={locale} canRequest={s.can(TOPUP_PERMISSION)} />
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'aiu.title')}</PageTitle>
      <AiTabs locale={locale} current="usage" />
      {body}
    </>
  );
}
