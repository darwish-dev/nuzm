import { isLocale } from '@nuzm/i18n';
import { apiDownload, requireSession } from '../../../../../../../lib/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The invoice PDF (`?lang=ar|en`), streamed with the caller's session. A held standard invoice answers 409 from the API. */
export async function GET(req: Request, ctx: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await ctx.params;
  if (!isLocale(locale) || !UUID.test(id)) return new Response('not found', { status: 404 });
  const s = await requireSession(locale);
  const lang = new URL(req.url).searchParams.get('lang') === 'en' ? 'en' : 'ar';
  return apiDownload(`/v1/billing/invoices/${id}/pdf?lang=${lang}`, s.org?.orgId);
}
