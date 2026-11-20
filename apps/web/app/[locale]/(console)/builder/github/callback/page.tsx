import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { GithubCallback } from '../../../../../../components/GithubCallback';
import { installCallback } from '../../../../../../lib/ai-studio';
import { bgate } from '../../../../../../lib/builder-gate';

/** Where GitHub sends the customer after installing the Nuzm GitHub App (its Setup URL). The signed `state` binds it to this user and organization. */
export default async function GithubCallbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const g = await bgate(params, 'builder:write', 'ais.gh.callback.title');
  if (!g.ok) return g.node;
  const { locale } = g;
  const cb = installCallback(await searchParams);
  return (
    <>
      <PageTitle>{t(locale, 'ais.gh.callback.title')}</PageTitle>
      <GithubCallback locale={locale} callback={cb} />
    </>
  );
}
