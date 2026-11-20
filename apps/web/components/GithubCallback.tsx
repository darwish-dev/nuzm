'use client';
import { useEffect, useRef, useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { EmptyState } from '@nuzm/ui';
import { bapi, useBuilderCall } from '../lib/builder-client';
import { ProblemNote } from './BuilderBits';

/** Completes the GitHub App installation once (the API checks the signed state); then the customer goes back to their projects. */
export function GithubCallback({
  locale,
  callback,
}: {
  locale: Locale;
  callback: { installationId: number; state: string } | null;
}) {
  const call = useBuilderCall();
  const [account, setAccount] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (!callback || once.current) return;
    once.current = true;
    void call.run(
      () => bapi.post<{ accountLogin: string }>('/v1/builder/github/connect', { body: callback }),
      (d) => setAccount(d.accountLogin),
    );
  }, [callback, call]);
  const back = (
    <a className="nz-btn" data-variant="primary" href={`/${locale}/builder/projects?type=webapp`}>
      {t(locale, 'ais.gh.callback.back')}
    </a>
  );
  if (!callback)
    return (
      <EmptyState
        title={t(locale, 'ais.gh.callback.invalid.title')}
        body={t(locale, 'ais.gh.callback.invalid.body')}
      />
    );
  if (call.problem)
    return (
      <>
        <ProblemNote locale={locale} problem={call.problem} />
        {back}
      </>
    );
  if (!account)
    return (
      <p role="status" aria-busy="true" className="nz-muted">
        {t(locale, 'state.loading')}
      </p>
    );
  return (
    <>
      <p role="status">{t(locale, 'ais.gh.callback.done', { account })}</p>
      {back}
    </>
  );
}
