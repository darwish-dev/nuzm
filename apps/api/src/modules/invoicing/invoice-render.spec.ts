import { describe, expect, it } from 'vitest';
import { DOC_LABELS } from './internal/doc-labels';
import { esc, money, renderDocumentHtml, type RenderDocument } from './internal/invoice-render';

const doc = (over: Partial<RenderDocument> = {}): RenderDocument => ({
  kind: 'invoice',
  numberText: 'NZM-00000007',
  environment: 'sandbox',
  issuedAt: '2026-11-17T09:00:00Z',
  dueAt: '2026-12-01T09:00:00Z',
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  currency: 'SAR',
  lines: [
    {
      description: 'Usage compute.vcpu_hours',
      quantity: '12.5',
      unit: 'vcpu_hour',
      netMinor: '63',
      taxMinor: '9',
      rateBps: 1500,
    },
  ],
  subtotalMinor: '63',
  taxMinor: '9',
  totalMinor: '72',
  seller: {
    legalName: { ar: 'نظم', en: 'Nuzm' },
    vatNumber: null,
    crNumber: null,
    address: {},
    placeholder: true,
  },
  buyer: {
    legalName: { ar: 'شركة الأفق', en: 'Horizon Co' },
    vatNumber: '300000000000003',
    crNumber: '1010000000',
    address: { street: 'King Fahd Road', city: 'Riyadh', country: 'SA' },
  },
  taxReviewRequired: false,
  ...over,
});

describe('label catalog', () => {
  it('Arabic and English define exactly the same keys, none empty', () => {
    expect(Object.keys(DOC_LABELS.ar).sort()).toEqual(Object.keys(DOC_LABELS.en).sort());
    for (const l of ['ar', 'en'] as const)
      for (const v of Object.values(DOC_LABELS[l])) expect(v.length).toBeGreaterThan(0);
  });
});

describe('money display (integer minor units, Latin digits)', () => {
  it.each([
    ['0', '0.00 SAR'],
    ['5', '0.05 SAR'],
    ['63', '0.63 SAR'],
    ['100', '1.00 SAR'],
    ['123456789', '1,234,567.89 SAR'],
  ])('%s → %s', (m, out) => expect(money(m, 'SAR', 'en')).toBe(out));
  it('is identical in Arabic (no locale digits that could be misread)', () =>
    expect(money('123456', 'SAR', 'ar')).toBe(money('123456', 'SAR', 'en')));
  it('refuses anything that is not an integer string', () => {
    for (const bad of ['1.5', '1e3', '', 'abc', '١٢'])
      expect(() => money(bad, 'SAR', 'en')).toThrow();
  });
});

describe('invoice HTML', () => {
  it('Arabic is right-to-left with the Arabic title, English is left-to-right', () => {
    const ar = renderDocumentHtml(doc(), 'ar');
    expect(ar).toContain('<html lang="ar" dir="rtl">');
    expect(ar).toContain('فاتورة ضريبية');
    expect(ar).toContain('شركة الأفق');
    const en = renderDocumentHtml(doc(), 'en');
    expect(en).toContain('<html lang="en" dir="ltr">');
    expect(en).toContain('Tax invoice');
    expect(en).toContain('Horizon Co');
  });
  it('shows both languages of each party name and keeps numbers in isolated runs', () => {
    const ar = renderDocumentHtml(doc(), 'ar');
    expect(ar).toContain('Horizon Co'); // the English name as the secondary line
    expect(ar).toContain('<bdi dir="ltr">NZM-00000007</bdi>');
    expect(ar).toContain('<bdi dir="ltr">300000000000003</bdi>');
  });
  it('prints the totals, the tax rate and the QR placeholder area', () => {
    const h = renderDocumentHtml(doc(), 'en');
    expect(h).toContain('0.72 SAR');
    expect(h).toContain('15%');
    expect(h).toContain('QR code area');
  });
  it('sandbox documents carry the watermark; live ones do not; a review flag adds the notice', () => {
    expect(renderDocumentHtml(doc(), 'en')).toContain('SANDBOX — NOT A TAX DOCUMENT');
    expect(renderDocumentHtml(doc({ environment: 'live' }), 'en')).not.toContain('SANDBOX');
    expect(renderDocumentHtml(doc({ taxReviewRequired: true }), 'en')).toContain('tax advisor');
    expect(renderDocumentHtml(doc(), 'en')).toContain('not registered'); // placeholder seller
  });
  it('escapes every customer-controlled value (no HTML injection into a legal document)', () => {
    const evil = '<script>alert(1)</script>"\'&';
    const h = renderDocumentHtml(
      doc({
        buyer: {
          legalName: { ar: evil, en: evil },
          vatNumber: evil,
          crNumber: null,
          address: { street: evil },
        },
        lines: [
          {
            description: evil,
            quantity: evil,
            unit: evil,
            netMinor: '1',
            taxMinor: '0',
            rateBps: 0,
          },
        ],
      }),
      'en',
    );
    expect(h).not.toContain('<script>alert(1)</script>');
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
  it('a credit note names the original invoice and the reason', () => {
    const h = renderDocumentHtml(
      doc({ kind: 'credit_note', referenceNumber: 'NZM-00000001', reason: 'duplicate charge' }),
      'en',
    );
    expect(h).toContain('Credit note');
    expect(h).toContain('<bdi dir="ltr">NZM-00000001</bdi>');
    expect(h).toContain('duplicate charge');
  });
});
