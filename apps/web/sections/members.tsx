import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { EmptyState, PageTitle } from '@nuzm/ui';
import { Badge, Ltr } from '@nuzm/ui';
import { tDynamic } from '@nuzm/i18n';
import { MemberActions } from '../components/TeamPanels';
import { requireSession } from '../lib/server';
import { view } from '../lib/view';

export default async function Members({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const orgId = s.org?.orgId;
  const body = !orgId
    ? null
    : await view(
        locale,
        async () =>
          await unwrap(
            s.api.GET('/v1/organizations/{orgId}/members', {
              params: { path: { orgId }, query: { limit: 100 } },
            }),
          ),
        (page) =>
          page.items.length === 0 ? (
            <EmptyState
              title={t(locale, 'state.empty.title')}
              body={t(locale, 'state.empty.body')}
            />
          ) : (
            <ul className="nzc-members" aria-label={t(locale, 'members.title')}>
              {page.items.map((r) => {
                const label = r.displayName ?? r.email;
                return (
                  <li key={r.id}>
                    <span className="nzc-members-avatar" aria-hidden="true">
                      {label.trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="nzc-members-who">
                      <strong>
                        {r.displayName ?? '—'}
                        {r.userId === s.me.id && (
                          <span className="nzc-members-you">{t(locale, 'members.you')}</span>
                        )}
                      </strong>
                      <small>
                        <Ltr>{r.email}</Ltr>
                      </small>
                    </span>
                    <span className="nzc-members-joined">
                      <small>{t(locale, 'field.joined')}</small>
                      <time dateTime={r.joinedAt}>{formatDateTime(r.joinedAt, locale)}</time>
                    </span>
                    <span className="nzc-members-role">
                      {s.can('member:manage') ? (
                        <MemberActions
                          locale={locale}
                          orgId={orgId}
                          member={r}
                          isSelf={r.userId === s.me.id}
                          mfaFactorId={s.me.mfaFactorId ?? null}
                        />
                      ) : (
                        <Badge>{tDynamic(locale, `role.${r.role}`, r.role)}</Badge>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          ),
      );
  return (
    <>
      <PageTitle>{t(locale, 'members.title')}</PageTitle>
      {body}
    </>
  );
}
