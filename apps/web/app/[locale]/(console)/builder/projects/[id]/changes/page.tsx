import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t } from '@nuzm/i18n';
import { EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { ChangeComposer } from '../../../../../../../components/BuilderChanges';
import { BuilderTabs } from '../../../../../../../components/BuilderParts';
import { isUuid } from '../../../../../../../lib/builder';
import { bgate, bview } from '../../../../../../../lib/builder-gate';

/** UI-M10-05: versions of the project, the diff of the last change and a compose-a-patch form (safe-diff changes). Git sub-paths wait for SCR-M10-01. */
export default async function Changes({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ op?: string; path?: string; hash?: string }>;
}) {
  const g = await bgate(params, 'builder:read', 'm10.chg.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  const q = await searchParams;
  if (!isUuid(id)) notFound();
  return bview(
    locale,
    () => unwrap(s.api.GET('/v1/builder/projects/{id}', { params: { path: { id } } })),
    (p) => {
      const versions = (p.versions ?? []).filter(
        (v): v is typeof v & { id: string } => typeof v.id === 'string',
      );
      return (
        <>
          <PageTitle>{p.name}</PageTitle>
          <BuilderTabs locale={locale} id={id} current="changes" />
          <h2 className="nz-h2">{t(locale, 'm10.chg.title')}</h2>
          <p className="nz-muted">{t(locale, 'm10.chg.gitNote')}</p>
          {versions.length === 0 ? (
            <EmptyState
              title={t(locale, 'm10.ov.noVersions')}
              body={t(locale, 'm10.ov.noVersionsBody')}
            />
          ) : (
            <Table
              caption={t(locale, 'm10.ov.versions')}
              rows={versions}
              rowKey={(v) => v.id}
              columns={[
                {
                  key: 'i',
                  header: t(locale, 'm10.chg.version'),
                  render: (v) => (
                    <>
                      <Ltr>{v.id.slice(0, 8)}</Ltr>
                      {v.id === p.headVersionId ? ` (${t(locale, 'm10.chg.head')})` : ''}
                    </>
                  ),
                },
                { key: 'l', header: t(locale, 'm10.ov.label'), render: (v) => v.label ?? '—' },
                {
                  key: 's',
                  header: t(locale, 'm10.ov.source'),
                  render: (v) => (v.source ? <Ltr>{v.source}</Ltr> : '—'),
                },
                {
                  key: 'c',
                  header: t(locale, 'field.created'),
                  render: (v) => (v.createdAt ? formatDateTime(v.createdAt, locale) : '—'),
                },
              ]}
            />
          )}
          {s.can('builder:write') ? (
            <div style={{ marginBlockStart: 16 }}>
              <ChangeComposer
                locale={locale}
                projectId={id}
                versions={versions}
                headVersionId={p.headVersionId ?? null}
                mfaFactorId={s.me.mfaFactorId ?? null}
                prefill={{ op: q.op, path: q.path, hash: q.hash }}
              />
            </div>
          ) : (
            <p className="nz-muted">{t(locale, 'm10.chg.noWrite')}</p>
          )}
        </>
      );
    },
  );
}
