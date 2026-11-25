import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@nuzm/i18n';
import { isUuid } from './compute';
import { serverCompute } from './compute-server';
import { requireSession } from './server';
import { APP_ROUTE_TAB } from './webapp-workspace';
import { workspaceHref } from './mobile';

/**
 * The former pages of a web-app project (`/builder/projects/{id}/spec`, `/design`, `/ide`, `/tests`, `/deployments`, `/exports`, `/versions`) now live inside the
 * builder workspace as panels (`?tab=`). A web-app project is sent there, so a saved link or a bookmark keeps working; any other project (a website uses
 * `/versions` and `/deployments` of its own) and any project that cannot be read here falls through to the page's own behaviour, which does the permission checks.
 * It redirects outside the page's loader on purpose: the loaders catch errors, and a redirect is one.
 */
export async function redirectWebapp(
  params: Promise<{ locale: string; id: string }>,
  segment: keyof typeof APP_ROUTE_TAB,
): Promise<void> {
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  let type: string | null;
  try {
    const s = await requireSession(locale);
    if (!s.org) return;
    const c = await serverCompute(s.org.orgId);
    const r = await c.get<{ type?: string }>(`/v1/builder/projects/${id}`);
    type = r.response.ok ? (r.data?.type ?? null) : null;
  } catch {
    return;
  }
  if (type === 'webapp') redirect(workspaceHref(locale, id, APP_ROUTE_TAB[segment]));
}

/**
 * The sections of a WEBSITE project (`/versions`, `/seo`, `/forms`, `/cms`, `/deployments`) are panels of the studio for that site: an old address, a bookmark or a
 * link from another screen opens the studio with the panel open (`?panel=`). Other project types, and a project that cannot be read here, keep the page's own behaviour.
 */
export async function redirectToStudio(
  params: Promise<{ locale: string; id: string }>,
  section: 'versions' | 'seo' | 'forms' | 'cms' | 'deployments',
): Promise<void> {
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  let type: string | null;
  try {
    const s = await requireSession(locale);
    if (!s.org) return;
    const c = await serverCompute(s.org.orgId);
    const r = await c.get<{ type?: string }>(`/v1/builder/projects/${id}`);
    type = r.response.ok ? (r.data?.type ?? null) : null;
  } catch {
    return;
  }
  if (type === 'website') redirect(`/builder/projects/${id}?panel=${section}`);
}
