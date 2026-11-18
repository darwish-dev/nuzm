import { isLocale } from '@nuzm/i18n';
import { previousPeriod, validPeriod } from '../../../../../../lib/m11';
import { apiDownload, requireSession } from '../../../../../../lib/server';

/** CSV of one reseller statement (the API's own `?format=csv`): same session, same organization, nothing recomputed here. */
export async function GET(req: Request, ctx: { params: Promise<{ locale: string }> }) {
  const { locale } = await ctx.params;
  if (!isLocale(locale)) return new Response('not found', { status: 404 });
  const s = await requireSession(locale);
  if (!s.org || s.org.type !== 'reseller' || !s.can('reseller:finance'))
    return new Response('forbidden', { status: 403 });
  const raw = new URL(req.url).searchParams.get('period') ?? '';
  const period = validPeriod(raw) ? raw : previousPeriod();
  const profiles = await s.api.GET('/v1/resellers', {});
  const reseller = (profiles.data?.items ?? []).find(
    (r) => (r as { role?: string }).role === 'reseller',
  ) as { id: string } | undefined;
  if (!reseller) return new Response('not found', { status: 404 });
  return apiDownload(
    `/v1/resellers/${reseller.id}/statements?period=${period}&format=csv`,
    s.org.orgId,
  );
}
