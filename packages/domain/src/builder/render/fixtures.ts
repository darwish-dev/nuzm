import { emptySiteModel, type Locale, type Localized, type SiteModel } from '../site-model';

/** Test fixtures of the renderer (shipped in the package, but only imported by specs). */
export const UPLOAD_HASH = 'a'.repeat(64);
export const UPLOAD_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const both = (ar: string, en: string): Localized => ({ ar, en });

/** A rich bilingual model with every section type on three pages, an organization and an absolute base URL. */
export function richModel(): SiteModel {
  return {
    schemaVersion: 1,
    locales: ['ar', 'en'],
    defaultLocale: 'ar',
    brand: {
      name: both('مطعم النخلة', 'Palm Restaurant'),
      logoAssetId: 'logo',
      colors: { primary: '#0f766e', accent: '#b45309', background: '#ffffff', text: '#1f2937' },
    },
    tokens: { radius: 'md', spacing: 'normal', fontFamily: 'sans', width: 'normal' },
    seo: {
      siteTitle: both('مطعم النخلة | مأكولات شرقية', 'Palm Restaurant | Oriental Food'),
      description: both(
        'مطعم النخلة يقدم أشهى المأكولات الشرقية الطازجة في قلب الرياض مع خدمة سريعة وأجواء عائلية مريحة.',
        'Palm Restaurant serves fresh oriental dishes in the heart of Riyadh with fast service and a relaxed family atmosphere.',
      ),
      ogImageAssetId: 'photo',
      baseUrl: 'https://palm.example.com',
      organization: {
        name: 'Palm Restaurant',
        type: 'Restaurant',
        phone: '+966 11 000 0000',
        email: 'hello@palm.example.com',
        address: both('شارع الملك فهد، الرياض', 'King Fahd Road, Riyadh'),
        geo: { lat: 24.7136, lng: 46.6753 },
        openingHours: ['Mo-Su 10:00-23:00'],
      },
    },
    nav: {
      items: [
        { pageId: 'home' },
        { pageId: 'about', label: both('من نحن', 'About') },
        { pageId: 'contact' },
      ],
    },
    footer: {
      text: both('جميع الحقوق محفوظة لمطعم النخلة', 'All rights reserved, Palm Restaurant'),
      links: [{ label: both('تواصل معنا', 'Contact'), pageId: 'contact' }],
    },
    pages: [
      {
        id: 'home',
        slug: 'home',
        title: both('الرئيسية', 'Home'),
        seo: {
          description: both(
            'أشهى المأكولات الشرقية الطازجة',
            'The freshest oriental dishes in town',
          ),
        },
        sections: [
          {
            id: 'hero1',
            type: 'hero',
            style: { background: 'primary', align: 'start' },
            props: {
              heading: both('أهلاً بكم في النخلة', 'Welcome to Palm'),
              subheading: both('مذاق أصيل منذ ١٩٩٠', 'Authentic taste since 1990'),
              ctaLabel: both('احجز طاولة', 'Book a table'),
              cta: { pageId: 'contact' },
              imageAssetId: 'hero',
            },
          },
          {
            id: 'intro',
            type: 'text',
            props: {
              heading: both('قصتنا', 'Our story'),
              body: both(
                'بدأنا بمطبخ صغير.\nوكبرنا بفضلكم.\n\nنستخدم مكونات طازجة كل يوم.',
                'We started with a small kitchen.\nWe grew thanks to you.\n\nWe use fresh ingredients every day.',
              ),
            },
          },
          {
            id: 'feat',
            type: 'features',
            style: { background: 'muted', align: 'center' },
            props: {
              heading: both('لماذا نحن', 'Why us'),
              items: [
                {
                  icon: '★',
                  title: both('جودة', 'Quality'),
                  text: both('أفضل المكونات', 'The best ingredients'),
                },
                {
                  icon: '⚡',
                  title: both('سرعة', 'Speed'),
                  text: both('خدمة سريعة', 'Fast service'),
                },
                { title: both('أجواء', 'Ambience'), text: both('جلسات عائلية', 'Family seating') },
              ],
            },
          },
          {
            id: 'price',
            type: 'pricing',
            props: {
              heading: both('الباقات', 'Packages'),
              plans: [
                {
                  name: both('عائلية', 'Family'),
                  price: '1200.50',
                  currency: 'SAR',
                  period: both('شهريًا', 'per month'),
                  description: both('لأربعة أشخاص', 'For four people'),
                },
                { name: both('فردية', 'Single'), price: '99', currency: 'USD' },
              ],
            },
          },
          {
            id: 'faq1',
            type: 'faq',
            props: {
              heading: both('أسئلة شائعة', 'FAQ'),
              items: [
                {
                  question: both('هل تقبلون الحجز؟', 'Do you take bookings?'),
                  answer: both('نعم، عبر صفحة التواصل.', 'Yes, via the contact page.'),
                },
                {
                  question: both('هل يوجد موقف؟', 'Is there parking?'),
                  answer: both('نعم، مجاني.', 'Yes, free.'),
                },
              ],
            },
          },
        ],
      },
      {
        id: 'about',
        slug: 'about',
        title: both('من نحن', 'About us'),
        sections: [
          {
            id: 'pic',
            type: 'image',
            props: { assetId: 'photo', caption: both('مطبخنا', 'Our kitchen') },
          },
          {
            id: 'gal',
            type: 'gallery',
            props: {
              images: [{ assetId: 'g1', caption: both('طبق ١', 'Dish 1') }, { assetId: 'g2' }],
            },
          },
          {
            id: 'test',
            type: 'testimonials',
            style: { background: 'muted' },
            props: {
              heading: both('آراء العملاء', 'What guests say'),
              items: [
                {
                  quote: both('أفضل مطعم جربته', 'The best restaurant I have tried'),
                  author: 'Sara',
                  role: both('زبونة', 'Guest'),
                },
                { quote: both('خدمة ممتازة', 'Excellent service'), author: 'Omar' },
              ],
            },
          },
        ],
      },
      {
        id: 'contact',
        slug: 'contact',
        title: both('تواصل معنا', 'Contact'),
        sections: [
          {
            id: 'form1',
            type: 'contact_form',
            props: {
              heading: both('أرسل لنا رسالة', 'Send us a message'),
              intro: both('نرد خلال يوم', 'We reply within a day'),
              formId: 'contact',
            },
          },
          {
            id: 'map1',
            type: 'map',
            props: {
              heading: both('موقعنا', 'Find us'),
              address: both('شارع الملك فهد، الرياض', 'King Fahd Road, Riyadh'),
              query: 'King Fahd Road Riyadh',
            },
          },
        ],
      },
    ],
    assets: [
      {
        id: 'logo',
        kind: 'image',
        source: 'placeholder',
        alt: both('شعار النخلة', 'Palm logo'),
        label: 'Palm',
        width: 160,
        height: 160,
      },
      {
        id: 'hero',
        kind: 'image',
        source: 'placeholder',
        alt: both('طبق مشاوي', 'A grilled platter'),
        label: 'Hero',
      },
      {
        id: 'g1',
        kind: 'image',
        source: 'placeholder',
        alt: both('طبق أول', 'First dish'),
        label: 'Dish 1',
      },
      {
        id: 'g2',
        kind: 'image',
        source: 'placeholder',
        alt: both('طبق ثان', 'Second dish'),
        label: 'Dish 2',
      },
      {
        id: 'photo',
        kind: 'image',
        source: 'upload',
        alt: both('مطبخ المطعم', 'The restaurant kitchen'),
        contentHash: UPLOAD_HASH,
        mime: 'image/png',
        width: 800,
        height: 600,
      },
    ],
    forms: [
      {
        id: 'contact',
        name: 'Contact',
        fields: [
          { name: 'name', type: 'text', label: both('الاسم', 'Name'), required: true },
          { name: 'email', type: 'email', label: both('البريد', 'Email'), required: true },
          { name: 'phone', type: 'tel', label: both('الجوال', 'Phone') },
          { name: 'message', type: 'textarea', label: both('رسالتك', 'Message'), required: true },
        ],
        submitLabel: both('إرسال', 'Send'),
        successMessage: both('شكرًا، وصلتنا رسالتك', 'Thanks, we got your message'),
      },
    ],
  };
}

/** The same site restricted to one locale. */
export function singleLocale(m: SiteModel, locale: Locale): SiteModel {
  const only = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(only);
    if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length > 0 && keys.every((k) => k === 'ar' || k === 'en'))
        return { [locale]: o[locale] };
      return Object.fromEntries(keys.map((k) => [k, only(o[k])]));
    }
    return v;
  };
  const out = only(m) as SiteModel;
  return { ...out, locales: [locale], defaultLocale: locale };
}

export const minimalModel = (): SiteModel => emptySiteModel(both('موقع', 'Site'));

/** Rich model with `n` extra pages, for the performance check. */
export function manyPages(n: number): SiteModel {
  const m = richModel();
  const template = m.pages[0]!;
  for (let i = 0; i < n; i++) {
    m.pages.push({
      ...structuredClone(template),
      id: `extra${i}`,
      slug: `extra-${i}`,
      sections: structuredClone(template.sections).map((s) => ({ ...s, id: `${s.id}x${i}` })),
    });
  }
  return m;
}
