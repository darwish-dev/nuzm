import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { AiBudgetsForm } from '../../../../../components/AiBudgetsForm';
import { AiTabs } from '../../../../../components/AiTabs';
import {
  AUTO_APPLY_PERMISSION,
  BUDGET_WRITE_PERMISSION,
  type ProjectCapDto,
} from '../../../../../lib/ai';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/**
 * UI-M09-11: AI budgets and caps. Everyone with `ai:read` sees them; `ai:budgets:write` (owner, admin, billing admin) may change them. A new budget version
 * (after a save, or a reload after a 412) replaces the form's values with the stored ones.
 */
export default async function AiBudgets({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('ai:read'))
    return (
      <>
        <PageTitle>{t(locale, 'aiu.budgets.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    async () => {
      const budgets = await unwrap(s.api.GET('/v1/ai/budgets', {}));
      const options: { id: string; name: string }[] = [];
      if (s.can('project:read'))
        try {
          const projects = await unwrap(
            s.api.GET('/v1/projects', { params: { query: { limit: 100 } } }),
          );
          for (const p of projects.items) options.push({ id: p.id, name: p.name });
        } catch {
          /* without names the rows show ids and no cap can be added */
        }
      return { budgets, options };
    },
    ({ budgets, options }) => (
      <AiBudgetsForm
        locale={locale}
        org={budgets.org}
        projects={budgets.projects as unknown as ProjectCapDto[]}
        version={budgets.version}
        projectOptions={options}
        canWrite={s.can(BUDGET_WRITE_PERMISSION)}
        canAutoApply={s.can(AUTO_APPLY_PERMISSION)}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'aiu.budgets.title')}</PageTitle>
      <AiTabs locale={locale} current="budgets" />
      <p className="nz-muted">{t(locale, 'aiu.budgets.help')}</p>
      {body}
    </>
  );
}
