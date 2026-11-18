import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t } from '@nuzm/i18n';
import { EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { TemplateEditor, TemplatePreview } from '../../../../../components/EmailPanels';
import { EmailTabs } from '../../../../../components/DataParts';
import { groupTemplates } from '../../../../../lib/data';
import { gate } from '../../../../../lib/gate';
import { view } from '../../../../../lib/view';

/** UI-M08-12: templates by key with their versions, and the editor with a sandboxed RTL/LTR preview. Saving creates the next version. */
export default async function Templates({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const g = await gate(params, 'email:read', 'm8.em.tab.templates');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { from } = await searchParams;
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/email/templates', { params: { query: { limit: 200 } } })),
    (data) => {
      const initial = from ? (data.items.find((x) => x.id === from) ?? null) : null;
      const groups = groupTemplates(data.items);
      return (
        <>
          {s.can('email:template:write') && (
            <TemplateEditor
              key={initial?.id ?? 'new'}
              locale={locale}
              initial={initial}
              mfaFactorId={s.me.mfaFactorId ?? null}
            />
          )}
          <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
            {t(locale, 'm8.tp.list')}
          </h2>
          {groups.length === 0 ? (
            <EmptyState title={t(locale, 'm8.tp.empty')} body={t(locale, 'm8.tp.emptyBody')} />
          ) : (
            groups.map((gr) => (
              <Table
                key={gr.key}
                caption={gr.key}
                rows={gr.versions}
                rowKey={(v) => v.id}
                columns={[
                  {
                    key: 'v',
                    header: t(locale, 'm8.tp.version'),
                    render: (v) => <Ltr>{`${gr.key} v${v.version}`}</Ltr>,
                  },
                  { key: 'n', header: t(locale, 'field.name'), render: (v) => v.name },
                  {
                    key: 'l',
                    header: t(locale, 'field.locale'),
                    render: (v) => t(locale, `m8.tp.locale.${v.locale}`),
                  },
                  {
                    key: 'c',
                    header: t(locale, 'field.created'),
                    render: (v) => formatDateTime(v.createdAt, locale),
                  },
                  {
                    key: 'a',
                    header: t(locale, 'field.action'),
                    render: (v) => (
                      <div className="nz-row">
                        <TemplatePreview locale={locale} tpl={v} />
                        {s.can('email:template:write') && (
                          <a href={`/${locale}/email/templates?from=${v.id}`}>
                            {t(locale, 'm8.tp.newVersion')}
                          </a>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            ))
          )}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm8.em.title')}</PageTitle>
      <EmailTabs locale={locale} current="templates" />
      {body}
    </>
  );
}
