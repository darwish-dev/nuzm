/**
 * Labels of server-rendered legal documents (invoice and credit-note PDFs). They live next to the renderer on purpose: the API compiles
 * with strict Node module resolution and cannot consume the bundler-resolved `@nuzm/i18n` sources, and these strings are part of the
 * document, not of a screen. Both languages must define the same keys (tested).
 */
export type DocLocale = 'ar' | 'en';
export const DOC_LABELS = {
  ar: {
    title: 'فاتورة ضريبية',
    creditNote: 'إشعار دائن',
    sandbox: 'بيئة تجريبية — ليست مستندًا ضريبيًا',
    number: 'رقم الفاتورة',
    cnNumber: 'رقم الإشعار',
    refInvoice: 'الفاتورة الأصلية',
    issueDate: 'تاريخ الإصدار',
    dueDate: 'تاريخ الاستحقاق',
    period: 'فترة الفوترة',
    seller: 'البائع',
    buyer: 'المشتري',
    vatNo: 'الرقم الضريبي',
    crNo: 'السجل التجاري',
    address: 'العنوان',
    'col.description': 'الوصف',
    'col.quantity': 'الكمية',
    'col.net': 'الصافي',
    'col.rate': 'نسبة الضريبة',
    'col.vat': 'قيمة الضريبة',
    'col.total': 'الإجمالي',
    subtotal: 'المجموع قبل الضريبة',
    vat: 'ضريبة القيمة المضافة',
    total: 'الإجمالي المستحق',
    reason: 'السبب',
    qr: 'منطقة رمز الاستجابة السريعة (هيئة الزكاة والضريبة والجمارك — قيد التنفيذ)',
    review: 'تنبيه: المعالجة الضريبية لهذه الفاتورة تحتاج إلى مراجعة المستشار الضريبي.',
    placeholderEntity: 'بيانات البائع تجريبية وغير مسجلة.',
  },
  en: {
    title: 'Tax invoice',
    creditNote: 'Credit note',
    sandbox: 'SANDBOX — NOT A TAX DOCUMENT',
    number: 'Invoice number',
    cnNumber: 'Credit note number',
    refInvoice: 'Original invoice',
    issueDate: 'Issue date',
    dueDate: 'Due date',
    period: 'Billing period',
    seller: 'Seller',
    buyer: 'Buyer',
    vatNo: 'VAT number',
    crNo: 'Commercial registration',
    address: 'Address',
    'col.description': 'Description',
    'col.quantity': 'Quantity',
    'col.net': 'Net',
    'col.rate': 'VAT rate',
    'col.vat': 'VAT',
    'col.total': 'Total',
    subtotal: 'Subtotal before VAT',
    vat: 'Value added tax',
    total: 'Total due',
    reason: 'Reason',
    qr: 'QR code area (ZATCA — not implemented yet)',
    review: 'Notice: the tax treatment of this invoice needs the tax advisor to review it.',
    placeholderEntity: 'The seller details are placeholders and not registered.',
  },
} as const satisfies Record<DocLocale, Record<string, string>>;
export type DocLabel = keyof (typeof DOC_LABELS)['en'];
export const label = (locale: DocLocale, key: DocLabel): string => DOC_LABELS[locale][key];

const TZ = 'Asia/Riyadh'; // docs/13 §5 default
/** Gregorian `YYYY-MM-DD` (Asia/Riyadh) in both languages: no locale-specific digits or direction marks that could reorder inside a right-to-left line. */
export function formatDocDate(iso: string, _locale: DocLocale): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}
