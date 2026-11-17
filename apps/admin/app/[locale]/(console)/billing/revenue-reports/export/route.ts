import { notFound } from 'next/navigation';
import { isLocale } from '@nuzm/i18n';
import { REPORTS, validRange } from '../../../../../../lib/finance';
import { apiDownload, requireStaff } from '../../../../../../lib/server';

/** CSV of one finance report, streamed with the staff session (the API neutralises formula-looking cells and audits the read). */
export async function GET(req: Request, ctx: { params: Promise<{ locale: string }> }) {
  const { locale } = await ctx.params;
  if (!isLocale(locale)) notFound();
  await requireStaff(locale);
  const url = new URL(req.url);
  const report = url.searchParams.get('report') ?? '';
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  if (!(REPORTS as readonly string[]).includes(report) || !validRange(from, to))
    return new Response('invalid report or period', {
      status: 422,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  return apiDownload(
    `/v1/admin/billing/revenue-reports?${new URLSearchParams({ report, from, to, format: 'csv' }).toString()}`,
  );
}
