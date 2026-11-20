import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Banner, ForbiddenState, PageTitle } from '@nuzm/ui';
import { AiAdminTabs } from '../../../../../components/AiAdminTabs';
import { SkillsRegistry, type AdminSkill } from '../../../../../components/AiSkillsPanel';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/**
 * AI Studio Skills registry (ADR-064, D-40): third-party skills arrive in quarantine (pinned to a commit, scanned, never executed), are reviewed
 * (licence known, executable skills by two people other than the importer) and can be disabled. Reading needs `admin:ai:read`; importing and
 * disabling `admin:ai:manage`; reviewing `admin:ai:approve` (the API enforces each).
 */
export default async function AiSkills({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:ai:read'))
    return (
      <>
        <PageTitle>{t(locale, 'ais.adm.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const { status } = await searchParams;
  const st = ['in_review', 'approved', 'rejected', 'disabled'].includes(status ?? '')
    ? status
    : undefined;
  const body = await view(
    locale,
    async () => {
      const r = await s.api.GET('/v1/admin/ai/skills', {
        params: { query: st ? { status: st as 'approved' } : {} },
      });
      return ((r.data as { items?: AdminSkill[] } | undefined)?.items ?? []) as AdminSkill[];
    },
    (items) => (
      <SkillsRegistry
        locale={locale}
        items={items}
        status={st ?? null}
        canManage={s.can('admin:ai:manage')}
        canApprove={s.can('admin:ai:approve')}
        mfaFactorId={s.me.mfaFactorId ?? null}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'ais.adm.title')}</PageTitle>
      <AiAdminTabs locale={locale} current="skills" />
      <Banner tone="warn">{t(locale, 'ais.adm.notice')}</Banner>
      {body}
    </>
  );
}
