import { isLocale } from '@nuzm/i18n';
import { apiDownload, requireSession } from '../../../../../../../lib/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stored e-invoice XML (simulated environments only; 409 until it exists). */
export async function GET(_req: Request, ctx: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await ctx.params;
  if (!isLocale(locale) || !UUID.test(id)) return new Response('not found', { status: 404 });
  const s = await requireSession(locale);
  return apiDownload(`/v1/billing/invoices/${id}/xml`, s.org?.orgId);
}
