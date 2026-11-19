import type { Locale } from '../site-model';

/** Fixed interface strings of the generated pages (not model text). */
type Pair = Record<Locale, string>;
const P = (ar: string, en: string): Pair => ({ ar, en });

export const UI = {
  skip: P('انتقل إلى المحتوى الرئيسي', 'Skip to main content'),
  menu: P('القائمة', 'Menu'),
  navLabel: P('التنقل الرئيسي', 'Main navigation'),
  footerNav: P('روابط التذييل', 'Footer links'),
  switchTo: { ar: 'العربية', en: 'English' } as Pair,
  switchLabel: P('تغيير اللغة', 'Change language'),
  ctaDefault: P('اعرف المزيد', 'Learn more'),
  required: P('مطلوب', 'required'),
  mapOpen: P('افتح الموقع في خرائط OpenStreetMap', 'Open the location in OpenStreetMap'),
  newTab: P('(يفتح في تبويب جديد)', '(opens in a new tab)'),
  preview: P('معاينة: هذه النسخة غير منشورة', 'Preview: this version is not published'),
  hpLabel: P('الموقع الإلكتروني (اتركه فارغًا)', 'Website (leave this empty)'),
  continue: P('متابعة إلى الموقع', 'Continue to the website'),
  currencySAR: P('ر.س', 'SAR'),
  headingFeatures: P('المزايا', 'Features'),
  headingPricing: P('الأسعار', 'Pricing'),
  headingTestimonials: P('آراء العملاء', 'Testimonials'),
  headingFaq: P('الأسئلة الشائعة', 'Frequently asked questions'),
  headingGallery: P('معرض الصور', 'Gallery'),
  headingContact: P('تواصل معنا', 'Contact us'),
  headingMap: P('الموقع', 'Location'),
  headingStats: P('بالأرقام', 'In numbers'),
  headingSteps: P('كيف نعمل', 'How it works'),
} as const;

export const dirOf = (l: Locale): 'rtl' | 'ltr' => (l === 'ar' ? 'rtl' : 'ltr');
