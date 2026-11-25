import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Banner, ForbiddenState, Icon, PageTitle } from '@nuzm/ui';
import { requireSession } from './server';
import { view } from './view';
import { REASON_KEY, type ToolId, type ToolReason } from './hosting-tools';

type Session = Awaited<ReturnType<typeof requireSession>>;
export interface ToolPageData {
  s: Session;
  locale: Locale;
  id: string;
  site: {
    name: string;
    runtime: string;
    version: number;
    primaryDomain?: string | null;
    domains: { domain: string; state: string }[];
  };
  cap: {
    state: 'available' | 'unavailable';
    reason?: ToolReason;
    limits?: Record<string, number>;
    versions?: string[];
  };
  /** the domains of the site the tools can act on (the primary one first) */
  domains: string[];
}

/**
 * The frame of a website-tool page: the back link, the title, the permission check, and the API's own answer to "does this tool work for this website now?" (role, plan,
 * panel version and service, connection). A tool that does not work shows WHY in words, never a broken form.
 */
export async function toolPage(
  params: Promise<{ locale: string; id: string }>,
  o: { tool: ToolId; permission: string; title: MessageKey },
  render: (d: ToolPageData) => ReactNode,
) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const head = (
    <>
      <PageTitle>{t(locale, o.title)}</PageTitle>
      <a className="nzc-back" href={`/hosting/sites/${id}`}>
        <Icon name="chevron" size={16} />
        {t(locale, 'ht.back')}
      </a>
    </>
  );
  if (!s.can(o.permission))
    return (
      <>
        {head}
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    async () => ({
      site: await unwrap(s.api.GET('/v1/hosting/sites/{id}', { params: { path: { id } } })),
      tools: await unwrap(s.api.GET('/v1/hosting/sites/{id}/tools', { params: { path: { id } } })),
    }),
    ({ site, tools }) => {
      const cap = tools.tools.find((x) => x.id === o.tool);
      if (!cap || cap.state === 'unavailable')
        return (
          <Banner tone="warn">
            {t(locale, REASON_KEY[(cap?.reason ?? 'connection') as ToolReason])}
          </Banner>
        );
      const domains = [
        ...new Set([
          ...(site.primaryDomain ? [site.primaryDomain] : []),
          ...site.domains
            .filter((d) => d.state === 'active' || d.state === 'verified')
            .map((d) => d.domain),
        ]),
      ];
      return (
        <>
          <Badge>{t(locale, 'ht.notVerified')}</Badge>
          {render({ s, locale, id, site, cap: cap as ToolPageData['cap'], domains })}
        </>
      );
    },
  );
  return (
    <>
      {head}
      {body}
    </>
  );
}
