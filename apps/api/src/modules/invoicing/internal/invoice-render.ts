import { formatDocDate, label, type DocLocale as Locale } from './doc-labels';

/** Everything the renderer needs: a snapshot, never a live read (an issued document must print the same forever). */
export interface RenderParty {
  legalName: { ar: string; en: string };
  vatNumber: string | null;
  crNumber: string | null;
  address: Record<string, string>;
  placeholder?: boolean;
}
export interface RenderLine {
  description: string;
  quantity: string;
  unit: string;
  netMinor: string;
  taxMinor: string;
  rateBps: number;
}
export interface RenderDocument {
  kind: 'invoice' | 'credit_note';
  numberText: string;
  referenceNumber?: string; // credit note: the original invoice number
  reason?: string;
  environment: 'sandbox' | 'live';
  issuedAt: string;
  dueAt?: string;
  periodStart?: string;
  periodEnd?: string;
  currency: string;
  lines: RenderLine[];
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
  seller: RenderParty;
  buyer: RenderParty;
  taxReviewRequired: boolean;
}

/** HTML-escape every dynamic value: names, descriptions and addresses are customer-controlled text. */
export const esc = (v: unknown): string =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Integer minor units → "1,234.50 SAR" with Latin digits in both languages (unambiguous on a legal document). */
export function money(minor: string, currency: string, locale: Locale): string {
  if (!/^-?\d+$/.test(minor)) throw new Error('amount must be an integer string');
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${whole}.${digits.slice(-2)} ${currency}${locale === 'ar' ? '' : ''}`;
}
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
const day = formatDocDate;

const party = (title: string, p: RenderParty, locale: Locale) => `
  <section class="party">
    <h2>${esc(title)}</h2>
    <p class="name">${esc(p.legalName[locale])}</p>
    <p class="alt" dir="${locale === 'ar' ? 'ltr' : 'rtl'}" lang="${locale === 'ar' ? 'en' : 'ar'}">${esc(p.legalName[locale === 'ar' ? 'en' : 'ar'])}</p>
    ${p.vatNumber ? `<p>${esc(label(locale, 'vatNo'))}: <bdi dir="ltr">${esc(p.vatNumber)}</bdi></p>` : ''}
    ${p.crNumber ? `<p>${esc(label(locale, 'crNo'))}: <bdi dir="ltr">${esc(p.crNumber)}</bdi></p>` : ''}
    ${
      Object.keys(p.address).length
        ? `<p>${esc(label(locale, 'address'))}: ${esc(
            ['street', 'buildingNumber', 'district', 'city', 'postalCode', 'country']
              .map((k) => p.address[k])
              .filter(Boolean)
              .join(', '),
          )}</p>`
        : ''
    }
    ${p.placeholder ? `<p class="warn">${esc(label(locale, 'placeholderEntity'))}</p>` : ''}
  </section>`;

/**
 * Self-contained HTML of an invoice or credit note (print-ready, A4). RTL for Arabic via `dir`, logical CSS properties, `<bdi dir="ltr">` around
 * numbers and identifiers so they keep their direction inside Arabic text. The QR area is a labelled placeholder until the ZATCA
 * module exists. Sandbox documents carry a visible watermark.
 */
export function renderDocumentHtml(d: RenderDocument, locale: Locale): string {
  const rtl = locale === 'ar';
  const title = label(locale, d.kind === 'invoice' ? 'title' : 'creditNote');
  const cell = (s: string, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${s}</td>`;
  return `<!doctype html>
<html lang="${locale}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${esc(title)} ${esc(d.numberText)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { font-family: "Noto Naskh Arabic", "Amiri", "Geeza Pro", "Segoe UI", Tahoma, Arial, sans-serif; color: #111827; font-size: 11pt; line-height: 1.5; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 4mm; } h2 { font-size: 11pt; margin: 0 0 1mm; color: #4b5563; }
  .meta, .parties { display: flex; gap: 8mm; justify-content: space-between; margin-block-end: 6mm; }
  .party { flex: 1; border: 1px solid #d1d5db; border-radius: 3mm; padding: 3mm; }
  .party p { margin: 0 0 1mm; } .name { font-weight: 700; } .alt { color: #4b5563; } .warn { color: #93370d; }
  table { width: 100%; border-collapse: collapse; margin-block: 4mm; table-layout: fixed; font-size: 9.5pt; }
  th, td { border-block-end: 1px solid #e5e7eb; padding: 2mm; text-align: start; vertical-align: top; }
  th { background: #f3f4f6; font-size: 9pt; padding-inline: 1.5mm; overflow-wrap: anywhere; } td.num, th.num { text-align: end; white-space: nowrap; } td { overflow-wrap: anywhere; }
  .totals { margin-inline-start: auto; width: 80mm; table-layout: auto; font-size: 11pt; } .totals td { border: 0; padding-block: 1mm; }
  .grand td { font-weight: 700; border-block-start: 2px solid #111827; font-size: 12pt; }
  .qr { border: 1px dashed #9ca3af; width: 38mm; height: 38mm; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 8pt; color: #4b5563; padding: 2mm; }
  .watermark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 0; }
  .watermark span { transform: rotate(-30deg); font-size: 34pt; font-weight: 700; color: rgba(147, 55, 13, 0.10); border: 3px solid rgba(147, 55, 13, 0.10); padding: 4mm 8mm; }
  .notice { color: #93370d; margin-block: 3mm; }
</style>
</head>
<body>
${d.environment === 'sandbox' ? `<div class="watermark"><span>${esc(label(locale, 'sandbox'))}</span></div>` : ''}
<h1>${esc(title)}</h1>
<div class="meta">
  <div>
    <p>${esc(label(locale, d.kind === 'invoice' ? 'number' : 'cnNumber'))}: <bdi dir="ltr">${esc(d.numberText)}</bdi></p>
    ${d.referenceNumber ? `<p>${esc(label(locale, 'refInvoice'))}: <bdi dir="ltr">${esc(d.referenceNumber)}</bdi></p>` : ''}
    <p>${esc(label(locale, 'issueDate'))}: <bdi dir="ltr">${esc(day(d.issuedAt, locale))}</bdi></p>
    ${d.dueAt ? `<p>${esc(label(locale, 'dueDate'))}: <bdi dir="ltr">${esc(day(d.dueAt, locale))}</bdi></p>` : ''}
    ${d.periodStart && d.periodEnd ? `<p>${esc(label(locale, 'period'))}: <bdi dir="ltr">${esc(d.periodStart)} – ${esc(d.periodEnd)}</bdi></p>` : ''}
    ${d.reason ? `<p>${esc(label(locale, 'reason'))}: ${esc(d.reason)}</p>` : ''}
  </div>
  <div class="qr" role="img" aria-label="${esc(label(locale, 'qr'))}">${esc(label(locale, 'qr'))}</div>
</div>
<div class="parties">${party(label(locale, 'seller'), d.seller, locale)}${party(label(locale, 'buyer'), d.buyer, locale)}</div>
<table>
  <colgroup><col style="width:27%"><col style="width:14%"><col style="width:14%"><col style="width:12%"><col style="width:15%"><col style="width:18%"></colgroup>
  <thead><tr>
    <th>${esc(label(locale, 'col.description'))}</th><th class="num">${esc(label(locale, 'col.quantity'))}</th><th class="num">${esc(label(locale, 'col.net'))}</th>
    <th class="num">${esc(label(locale, 'col.rate'))}</th><th class="num">${esc(label(locale, 'col.vat'))}</th><th class="num">${esc(label(locale, 'col.total'))}</th>
  </tr></thead>
  <tbody>
  ${d.lines
    .map(
      (l) =>
        `<tr>${cell(esc(l.description))}${cell(`<bdi dir="ltr">${esc(l.quantity)} ${esc(l.unit)}</bdi>`, 'num')}${cell(`<bdi dir="ltr">${esc(money(l.netMinor, d.currency, locale))}</bdi>`, 'num')}${cell(`<bdi dir="ltr">${esc(pct(l.rateBps))}</bdi>`, 'num')}${cell(`<bdi dir="ltr">${esc(money(l.taxMinor, d.currency, locale))}</bdi>`, 'num')}${cell(`<bdi dir="ltr">${esc(money((BigInt(l.netMinor) + BigInt(l.taxMinor)).toString(), d.currency, locale))}</bdi>`, 'num')}</tr>`,
    )
    .join('\n  ')}
  </tbody>
</table>
<table class="totals">
  <tr><td>${esc(label(locale, 'subtotal'))}</td><td class="num"><bdi dir="ltr">${esc(money(d.subtotalMinor, d.currency, locale))}</bdi></td></tr>
  <tr><td>${esc(label(locale, 'vat'))}</td><td class="num"><bdi dir="ltr">${esc(money(d.taxMinor, d.currency, locale))}</bdi></td></tr>
  <tr class="grand"><td>${esc(label(locale, 'total'))}</td><td class="num"><bdi dir="ltr">${esc(money(d.totalMinor, d.currency, locale))}</bdi></td></tr>
</table>
${d.taxReviewRequired ? `<p class="notice">${esc(label(locale, 'review'))}</p>` : ''}
</body>
</html>`;
}
