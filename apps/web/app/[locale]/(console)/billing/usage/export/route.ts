import { unwrap } from '@nuzm/sdk';
import { isLocale } from '@nuzm/i18n';
import { toCsv, trimDec } from '../../../../../../lib/billing';
import { requireSession } from '../../../../../../lib/server';

const day = (v: string | null, end = false) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${end ? '23:59:59' : '00:00:00'}Z` : undefined;
const MAX_ROWS = 5000;

/** CSV of the filtered usage (same API call as the screen). Every cell is formula-injection safe (see lib/billing.ts). */
export async function GET(req: Request, ctx: { params: Promise<{ locale: string }> }) {
  const { locale } = await ctx.params;
  if (!isLocale(locale)) return new Response('not found', { status: 404 });
  const s = await requireSession(locale);
  const u = new URL(req.url).searchParams;
  const g = u.get('granularity');
  const granularity = g === 'hour' || g === 'month' ? g : 'day';
  const rows: string[][] = [
    [
      'bucketStart',
      'meterId',
      'resourceId',
      'quantity',
      'unit',
      'eventCount',
      'billingPeriodStart',
      'dataRegion',
    ],
  ];
  let cursor: string | undefined;
  try {
    for (let i = 0; i < 25 && rows.length <= MAX_ROWS; i++) {
      const page = await unwrap(
        s.api.GET('/v1/usage', {
          params: {
            query: {
              limit: 200,
              granularity,
              meter: u.get('meter') || undefined,
              from: day(u.get('from')),
              to: day(u.get('to'), true),
              cursor,
            },
          },
        }),
      );
      for (const p of page.items)
        rows.push([
          p.bucketStart,
          p.meterId,
          p.resourceId ?? '',
          trimDec(p.quantity),
          p.unit,
          String(p.eventCount),
          p.billingPeriodStart,
          p.dataRegion,
        ]);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  } catch {
    return new Response('export failed', { status: 502 });
  }
  return new Response(toCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="usage.csv"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
