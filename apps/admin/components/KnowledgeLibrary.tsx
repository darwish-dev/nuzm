import { t, formatDateTime, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Button, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import {
  PLATFORMS,
  RESOURCE_TYPES,
  STATUSES,
  filtersToSearch,
  statusTone,
  type KnowledgePage,
  type LibraryFilters,
} from '../lib/knowledge';
import { KnowledgeUpload } from './KnowledgeUpload';

/**
 * The library list (SCR-K-01): a plain GET filter form (works without JavaScript), a table of the platform library, and a "show more" link that carries the
 * cursor. The upload panel is the only client part.
 */
export function KnowledgeLibrary({
  locale,
  page,
  filters,
  canManage,
}: {
  locale: Locale;
  page: KnowledgePage;
  filters: LibraryFilters;
  canManage: boolean;
}) {
  const filtered = Object.entries(filters).some(([k, v]) => k !== 'cursor' && v);
  const detail = (id: string) => `/${locale}/ai-intelligence/library/${id}`;
  const option = (prefix: string, v: string) => (
    <option key={v} value={v}>
      {t(locale, `${prefix}.${v}` as MessageKey)}
    </option>
  );
  return (
    <>
      {canManage && <KnowledgeUpload locale={locale} />}
      <form
        method="get"
        className="nz-card kn-filters"
        role="search"
        aria-label={t(locale, 'kn.filter.label')}
      >
        <div className="kn-filter-grid">
          <Field id="kn-q" label={t(locale, 'kn.filter.search')}>
            {(a) => (
              <Input {...a} name="q" type="search" defaultValue={filters.q ?? ''} maxLength={100} />
            )}
          </Field>
          <Field id="kn-type" label={t(locale, 'kn.filter.type')}>
            {(a) => (
              <Select {...a} name="type" defaultValue={filters.type ?? ''}>
                <option value="">{t(locale, 'kn.filter.all')}</option>
                {RESOURCE_TYPES.map((v) => option('kn.type', v))}
              </Select>
            )}
          </Field>
          <Field id="kn-status" label={t(locale, 'kn.filter.status')}>
            {(a) => (
              <Select {...a} name="status" defaultValue={filters.status ?? ''}>
                <option value="">{t(locale, 'kn.filter.all')}</option>
                {STATUSES.map((v) => option('kn.status', v))}
              </Select>
            )}
          </Field>
          <Field id="kn-platform" label={t(locale, 'kn.filter.platform')}>
            {(a) => (
              <Select {...a} name="platform" defaultValue={filters.platform ?? ''}>
                <option value="">{t(locale, 'kn.filter.all')}</option>
                {PLATFORMS.map((v) => option('kn.platform', v))}
              </Select>
            )}
          </Field>
          <Field id="kn-framework" label={t(locale, 'kn.filter.framework')}>
            {(a) => (
              <Input
                {...a}
                name="framework"
                dir="ltr"
                defaultValue={filters.framework ?? ''}
                maxLength={60}
              />
            )}
          </Field>
        </div>
        <div className="nz-row">
          <Button type="submit">{t(locale, 'kn.filter.apply')}</Button>
          {filtered && (
            <a className="nz-btn" data-variant="secondary" href="?">
              {t(locale, 'kn.filter.reset')}
            </a>
          )}
        </div>
      </form>

      {page.items.length === 0 ? (
        <EmptyState
          title={t(locale, filtered ? 'kn.empty.filtered.title' : 'kn.empty.title')}
          body={t(locale, filtered ? 'kn.empty.filtered.body' : 'kn.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'kn.title')}
          rows={page.items}
          rowKey={(r) => r.id}
          rowHref={(r) => detail(r.id)}
          columns={[
            {
              key: 'name',
              header: t(locale, 'kn.col.name'),
              card: 'title',
              render: (r) => <bdi dir="auto">{r.name}</bdi>,
            },
            {
              key: 'status',
              header: t(locale, 'kn.col.status'),
              card: 'badge',
              render: (r) => (
                <Badge tone={statusTone(r.status)}>
                  {t(locale, `kn.status.${r.status}` as MessageKey)}
                </Badge>
              ),
            },
            {
              key: 'type',
              header: t(locale, 'kn.col.type'),
              card: 'subtitle',
              render: (r) => t(locale, `kn.type.${r.resourceType}` as MessageKey),
            },
            {
              key: 'platform',
              header: t(locale, 'kn.col.platform'),
              card: 'meta',
              render: (r) =>
                r.platform ? t(locale, `kn.platform.${r.platform}` as MessageKey) : '—',
            },
            {
              key: 'fw',
              header: t(locale, 'kn.col.frameworks'),
              card: 'meta',
              render: (r) => (r.frameworks.length ? <Ltr>{r.frameworks.join(', ')}</Ltr> : '—'),
            },
            {
              key: 'vis',
              header: t(locale, 'kn.col.visibility'),
              card: 'meta',
              render: (r) => t(locale, `kn.vis.${r.visibility}` as MessageKey),
            },
            {
              key: 'updated',
              header: t(locale, 'kn.col.updated'),
              card: 'footer',
              render: (r) => formatDateTime(r.updatedAt, locale),
            },
          ]}
        />
      )}
      {page.nextCursor && (
        <p>
          <a
            className="nz-btn"
            data-variant="secondary"
            href={filtersToSearch({ ...filters, cursor: page.nextCursor })}
          >
            {t(locale, 'kn.more')}
          </a>
        </p>
      )}
    </>
  );
}
