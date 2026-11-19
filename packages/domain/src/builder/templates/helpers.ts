import type { BusinessType } from '../artifacts';
import {
  LOCALES,
  type Asset,
  type FormDef,
  type Locale,
  type Localized,
  type Organization,
  type Page,
  type Section,
  type SiteModel,
  type Tokens,
} from '../site-model';

/**
 * Template authoring helpers (M09 S39). A template file is mostly CONTENT: it receives a `Kit` (section builders bound to the language of the build) and returns
 * pages, assets and forms written natively in Arabic and English. `defineTemplate` turns that into a `SiteTemplate` whose `build()` honours the requested locales,
 * the business name and the colour overrides, and always yields a model that passes `validateSiteModel`.
 */
export interface SiteTemplate {
  /** kebab-case, stable */
  id: string;
  version: number;
  category: BusinessType;
  name: Localized;
  description: Localized;
  pageKinds: string[];
  build(o: {
    name: Localized;
    locales: Locale[];
    colors?: { primary?: string; accent?: string };
    baseUrl?: string;
  }): SiteModel;
}

export const L = (ar: string, en: string): Localized => ({ ar, en });

/** Default page titles (also used as navigation labels and as the labels of requirement questions). */
export const PAGE_LABELS: Record<string, Localized> = {
  home: L('الرئيسية', 'Home'),
  about: L('من نحن', 'About us'),
  services: L('خدماتنا', 'Services'),
  menu: L('القائمة', 'Menu'),
  products: L('المنتجات', 'Products'),
  gallery: L('معرض الصور', 'Gallery'),
  pricing: L('الباقات والأسعار', 'Pricing'),
  faq: L('الأسئلة الشائعة', 'FAQ'),
  contact: L('تواصل معنا', 'Contact'),
  team: L('فريقنا', 'Our team'),
  programs: L('برامجنا', 'Programs'),
  projects: L('مشاريعنا', 'Projects'),
};

type Bg = NonNullable<Section['style']>['background'];
type Align = NonNullable<Section['style']>['align'];
export interface SectionOpts {
  bg?: Bg;
  align?: Align;
}

export interface PageDef {
  kind: string;
  title: Localized;
  seoTitle: Localized;
  seoDescription: Localized;
  sections: Section[];
}
export interface TemplateContent {
  siteDescription: Localized;
  assets: Asset[];
  forms: FormDef[];
  pages: PageDef[];
}

export type FormVariant = 'general' | 'appointment' | 'order' | 'registration' | 'volunteer';
const FORM_VARIANTS: Record<
  FormVariant,
  { name: string; message: Localized; submit: Localized; phoneRequired: boolean }
> = {
  general: {
    name: 'Contact form',
    message: L('رسالتك', 'Your message'),
    submit: L('إرسال', 'Send'),
    phoneRequired: false,
  },
  appointment: {
    name: 'Appointment request',
    message: L('سبب الزيارة', 'Reason for your visit'),
    submit: L('طلب موعد', 'Request an appointment'),
    phoneRequired: true,
  },
  order: {
    name: 'Order inquiry',
    message: L('استفسارك عن الطلب أو المنتج', 'Your question about an order or product'),
    submit: L('إرسال الاستفسار', 'Send inquiry'),
    phoneRequired: false,
  },
  registration: {
    name: 'Registration inquiry',
    message: L('أخبرنا بالبرنامج الذي يهمّك', 'Tell us which program interests you'),
    submit: L('إرسال الطلب', 'Send request'),
    phoneRequired: false,
  },
  volunteer: {
    name: 'Get involved',
    message: L('كيف تودّ المشاركة؟', 'How would you like to take part?'),
    submit: L('إرسال', 'Send'),
    phoneRequired: false,
  },
};

const link = (to: string): { pageId: string } | { url: string } =>
  /^(#|\/|https?:|mailto:|tel:)/.test(to) ? { url: to } : { pageId: to };

const mk = (
  id: string,
  type: Section['type'],
  props: Record<string, unknown>,
  o?: SectionOpts,
): Section => {
  const style: NonNullable<Section['style']> = {};
  if (o?.bg) style.background = o.bg;
  if (o?.align) style.align = o.align;
  return Object.keys(style).length > 0 ? { id, type, props, style } : { id, type, props };
};

const defined = <T extends Record<string, unknown>>(o: T): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** `[arText, enText]` or undefined → optional Localized */
const opt = (ar?: string, en?: string): Localized | undefined =>
  ar !== undefined && en !== undefined ? L(ar, en) : undefined;

export interface Kit {
  /** the language used for plain-string fields (testimonial author, asset label, map query) */
  lang: Locale;
  hero(
    id: string,
    o: { h: Localized; sub?: Localized; cta?: Localized; to?: string; img?: string } & SectionOpts,
  ): Section;
  text(id: string, body: Localized, heading?: Localized, o?: SectionOpts): Section;
  image(id: string, assetId: string, caption?: Localized, o?: SectionOpts): Section;
  /** rows: [assetId, captionAr?, captionEn?] */
  gallery(
    id: string,
    heading: Localized | undefined,
    rows: [string, string?, string?][],
    o?: SectionOpts,
  ): Section;
  /** rows: [icon, titleAr, titleEn, textAr, textEn] */
  features(
    id: string,
    heading: Localized | undefined,
    rows: [string, string, string, string, string][],
    o?: SectionOpts,
  ): Section;
  /** rows: [nameAr, nameEn, price, periodAr, periodEn, descAr, descEn]; prices are SAMPLE amounts the owner edits */
  pricing(
    id: string,
    heading: Localized | undefined,
    rows: [string, string, string, string, string, string, string][],
    o?: SectionOpts,
  ): Section;
  /** rows: [quoteAr, quoteEn, authorAr, authorEn] (generic sample voices the owner replaces) */
  testimonials(
    id: string,
    heading: Localized | undefined,
    rows: [string, string, string, string][],
    o?: SectionOpts,
  ): Section;
  /** rows: [questionAr, questionEn, answerAr, answerEn] */
  faq(
    id: string,
    heading: Localized | undefined,
    rows: [string, string, string, string][],
    o?: SectionOpts,
  ): Section;
  /** rows: [value, labelAr, labelEn]; the values are SAMPLE figures the owner replaces with the business's own */
  stats(
    id: string,
    heading: Localized | undefined,
    rows: [string, string, string][],
    o?: SectionOpts,
  ): Section;
  /** rows: [titleAr, titleEn, textAr, textEn] */
  steps(
    id: string,
    heading: Localized | undefined,
    rows: [string, string, string, string][],
    o?: SectionOpts,
  ): Section;
  /** a closing call-to-action band */
  cta(
    id: string,
    o: { h: Localized; sub?: Localized; label: Localized; to: string } & SectionOpts,
  ): Section;
  contactForm(id: string, heading?: Localized, intro?: Localized, o?: SectionOpts): Section;
  map(id: string, heading?: Localized, o?: SectionOpts): Section;
  img(id: string, label: Localized, alt: Localized): Asset;
  form(variant?: FormVariant): FormDef;
  /** `seo` = [titleAr, titleEn, descriptionAr, descriptionEn] */
  page(
    kind: string,
    seo: [string, string, string, string],
    sections: Section[],
    title?: Localized,
  ): PageDef;
}

export function makeKit(lang: Locale): Kit {
  const pick = (l: Localized): string => l[lang] ?? l.ar ?? l.en ?? '';
  return {
    lang,
    hero: (id, o) =>
      mk(
        id,
        'hero',
        defined({
          heading: o.h,
          subheading: o.sub,
          ctaLabel: o.cta,
          cta: o.cta && o.to ? link(o.to) : undefined,
          imageAssetId: o.img,
        }),
        o,
      ),
    text: (id, body, heading, o) => mk(id, 'text', defined({ heading, body }), o),
    image: (id, assetId, caption, o) => mk(id, 'image', defined({ assetId, caption }), o),
    gallery: (id, heading, rows, o) =>
      mk(
        id,
        'gallery',
        defined({
          heading,
          images: rows.map(([assetId, ar, en]) => defined({ assetId, caption: opt(ar, en) })),
        }),
        o,
      ),
    features: (id, heading, rows, o) =>
      mk(
        id,
        'features',
        defined({
          heading,
          items: rows.map(([icon, ta, te, xa, xe]) => ({
            icon,
            title: L(ta, te),
            text: L(xa, xe),
          })),
        }),
        o,
      ),
    pricing: (id, heading, rows, o) =>
      mk(
        id,
        'pricing',
        defined({
          heading,
          plans: rows.map(([na, ne, price, pa, pe, da, de]) => ({
            name: L(na, ne),
            description: L(da, de),
            period: L(pa, pe),
            price,
            currency: 'SAR',
          })),
        }),
        o,
      ),
    testimonials: (id, heading, rows, o) =>
      mk(
        id,
        'testimonials',
        defined({
          heading,
          items: rows.map(([qa, qe, aa, ae]) => ({ quote: L(qa, qe), author: pick(L(aa, ae)) })),
        }),
        o,
      ),
    faq: (id, heading, rows, o) =>
      mk(
        id,
        'faq',
        defined({
          heading,
          items: rows.map(([qa, qe, aa, ae]) => ({ question: L(qa, qe), answer: L(aa, ae) })),
        }),
        o,
      ),
    stats: (id, heading, rows, o) =>
      mk(
        id,
        'stats',
        defined({
          heading,
          stats: rows.map(([value, la, le]) => ({ value, label: L(la, le) })),
        }),
        o,
      ),
    steps: (id, heading, rows, o) =>
      mk(
        id,
        'steps',
        defined({
          heading,
          steps: rows.map(([ta, te, xa, xe]) => ({ title: L(ta, te), text: L(xa, xe) })),
        }),
        o,
      ),
    cta: (id, o) =>
      mk(
        id,
        'cta',
        defined({ heading: o.h, subheading: o.sub, ctaLabel: o.label, cta: link(o.to) }),
        { bg: 'primary', align: 'center', ...o },
      ),
    contactForm: (id, heading, intro, o) =>
      mk(id, 'contact_form', defined({ heading, intro, formId: 'contact' }), o),
    map: (id, heading = L('موقعنا', 'Find us'), o) =>
      mk(
        id,
        'map',
        { heading, query: pick(L('الرياض، المملكة العربية السعودية', 'Riyadh, Saudi Arabia')) },
        o,
      ),
    img: (id, label, alt) => ({
      id,
      kind: 'image',
      source: 'placeholder',
      alt,
      label: pick(label),
    }),
    form: (variant = 'general') => {
      const v = FORM_VARIANTS[variant];
      return {
        id: 'contact',
        name: v.name,
        fields: [
          { name: 'name', type: 'text', label: L('الاسم', 'Name'), required: true },
          {
            name: 'email',
            type: 'email',
            label: L('البريد الإلكتروني', 'Email'),
            required: !v.phoneRequired,
          },
          {
            name: 'phone',
            type: 'tel',
            label: L('رقم الجوال', 'Mobile number'),
            required: v.phoneRequired,
          },
          { name: 'message', type: 'textarea', label: v.message, required: true },
        ],
        submitLabel: v.submit,
        successMessage: L(
          'شكرًا لتواصلك، سنرد عليك في أقرب وقت ممكن.',
          'Thank you for getting in touch. We will reply as soon as we can.',
        ),
      };
    },
    page: (kind, [ta, te, da, de], sections, title) => ({
      kind,
      title: title ?? PAGE_LABELS[kind] ?? L(kind, kind),
      seoTitle: L(ta, te),
      seoDescription: L(da, de),
      sections,
    }),
  };
}

/* ───────────── build pipeline ───────────── */

export interface TemplateSpec {
  id: string;
  version: number;
  category: BusinessType;
  name: Localized;
  description: Localized;
  colors: { primary: string; accent: string; background: string; text: string };
  tokens: Tokens;
  orgType: NonNullable<Organization['type']>;
  content: (k: Kit) => TemplateContent;
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const BASE_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{2,5})?(\/[A-Za-z0-9._~/-]*)?$/;
const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max).trimEnd() : s);

export function normalizeLocales(locales: readonly Locale[] | undefined): Locale[] {
  const out: Locale[] = [];
  for (const l of locales ?? [])
    if ((LOCALES as readonly string[]).includes(l) && !out.includes(l)) out.push(l);
  return out.length > 0 ? out : [...LOCALES];
}

const isLocObj = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.keys(v).length > 0 &&
  Object.entries(v).every(([k, x]) => (k === 'ar' || k === 'en') && typeof x === 'string');

/** Remove every locale that is not declared from every localized text of a model (deep). */
export function restrictLocales<T>(value: T, locales: readonly Locale[]): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (isLocObj(v))
      return Object.fromEntries(Object.entries(v).filter(([k]) => locales.includes(k as Locale)));
    if (typeof v === 'object' && v !== null)
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export function defineTemplate(spec: TemplateSpec): SiteTemplate {
  const pageKinds = spec.content(makeKit('ar')).pages.map((p) => p.kind);
  return {
    id: spec.id,
    version: spec.version,
    category: spec.category,
    name: spec.name,
    description: spec.description,
    pageKinds,
    build(o) {
      const locales = normalizeLocales(o.locales);
      const lang = locales[0]!;
      const content = spec.content(makeKit(lang));
      const colors = { ...spec.colors };
      if (o.colors?.primary && HEX.test(o.colors.primary)) colors.primary = o.colors.primary;
      if (o.colors?.accent && HEX.test(o.colors.accent)) colors.accent = o.colors.accent;
      const given = { ar: o.name.ar?.trim() ?? '', en: o.name.en?.trim() ?? '' };
      const anyName = given.ar || given.en || spec.name[lang] || spec.name.en || 'Site';
      const name: Localized = {
        ar: clip(given.ar || anyName, 80),
        en: clip(given.en || anyName, 80),
      };
      const pages: Page[] = content.pages.map((p) => ({
        id: p.kind,
        slug: p.kind === 'home' ? 'home' : p.kind,
        title: p.title,
        seo: { title: p.seoTitle, description: p.seoDescription },
        sections: p.sections,
      }));
      const footerLinks = pages
        .filter((p) => p.slug !== 'home')
        .map((p) => ({ label: p.title, pageId: p.id }));
      const seoOrg: Organization = { name: clip(name[lang] ?? anyName, 120), type: spec.orgType };
      const model: SiteModel = {
        schemaVersion: 1,
        locales,
        defaultLocale: lang,
        brand: { name, colors },
        tokens: { ...spec.tokens },
        seo: {
          siteTitle: { ar: clip(name.ar!, 70), en: clip(name.en!, 70) },
          description: content.siteDescription,
          ...(o.baseUrl && o.baseUrl.length <= 200 && BASE_URL.test(o.baseUrl)
            ? { baseUrl: o.baseUrl }
            : {}),
          organization: seoOrg,
        },
        nav: { items: pages.slice(0, 12).map((p) => ({ pageId: p.id })) },
        footer: {
          text: L(`${name.ar} — جميع الحقوق محفوظة.`, `© ${name.en}. All rights reserved.`),
          ...(footerLinks.length > 0 ? { links: footerLinks.slice(0, 12) } : {}),
        },
        pages,
        assets: content.assets,
        forms: content.forms,
      };
      return restrictLocales(model, locales);
    },
  };
}
