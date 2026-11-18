import { validateSchema, type Schema } from '../schema';

/**
 * Site model v1 (M09 S39): the VERSIONED STRUCTURED OUTPUT of website generation and the single source of truth of a project version. A trusted renderer turns it
 * into static HTML/CSS; no model-authored script, style or markup is ever executed or embedded (all text is escaped, all URLs are checked, styles come from tokens).
 * Pure data + validation; no I/O. Changing the shape means a new `schemaVersion` and a migration function, never an in-place edit of v1.
 */
export const SITE_MODEL_VERSION = 1 as const;
export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
/** a string per locale; every locale the site declares must be present for a required text */
export type Localized = Partial<Record<Locale, string>>;

export const SECTION_TYPES = [
  'hero',
  'text',
  'image',
  'gallery',
  'features',
  'pricing',
  'testimonials',
  'faq',
  'contact_form',
  'map',
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export interface Brand {
  name: Localized;
  logoAssetId?: string;
  /** #rgb or #rrggbb; the renderer picks text colours that meet WCAG AA contrast */
  colors?: { primary?: string; accent?: string; background?: string; text?: string };
}
export interface Tokens {
  radius: 'none' | 'sm' | 'md' | 'lg';
  spacing: 'compact' | 'normal' | 'relaxed';
  fontFamily: 'sans' | 'serif';
  /** content width */
  width: 'narrow' | 'normal' | 'wide';
}
export interface Organization {
  name: string;
  phone?: string;
  email?: string;
  address?: Localized;
  geo?: { lat: number; lng: number };
  /** schema.org type: LocalBusiness subtype or Organization */
  type?:
    | 'Organization'
    | 'LocalBusiness'
    | 'Restaurant'
    | 'MedicalClinic'
    | 'Store'
    | 'EducationalOrganization'
    | 'NGO';
  openingHours?: string[];
}
export interface SeoSite {
  siteTitle: Localized;
  description: Localized;
  ogImageAssetId?: string;
  /** absolute https base URL of the live site; absent until a deployment target is known */
  baseUrl?: string;
  organization?: Organization;
}
export interface PageSeo {
  title?: Localized;
  description?: Localized;
  noindex?: boolean;
}
export interface Section {
  id: string;
  type: SectionType;
  props: Record<string, unknown>;
  style?: { background?: 'default' | 'muted' | 'primary'; align?: 'start' | 'center' };
}
export interface Page {
  id: string;
  /** url segment, `home` for the first page => `/{locale}/` */
  slug: string;
  title: Localized;
  seo?: PageSeo;
  sections: Section[];
}
export interface Asset {
  id: string;
  kind: 'image';
  source: 'placeholder' | 'upload';
  alt: Localized;
  /** upload only: content hash of the stored file (`builder.project_files` / bucket reference lives outside the model) */
  contentHash?: string;
  mime?: 'image/png' | 'image/jpeg' | 'image/webp';
  width?: number;
  height?: number;
  /** placeholder only: a neutral label shown in the generated SVG */
  label?: string;
}
export interface FormDef {
  id: string;
  name: string;
  fields: {
    name: string;
    type: 'text' | 'email' | 'tel' | 'textarea';
    label: Localized;
    required?: boolean;
  }[];
  submitLabel: Localized;
  successMessage: Localized;
}
export interface SiteModel {
  schemaVersion: typeof SITE_MODEL_VERSION;
  locales: Locale[];
  defaultLocale: Locale;
  brand: Brand;
  tokens: Tokens;
  seo: SeoSite;
  nav: { items: { pageId: string; label?: Localized }[] };
  footer: { text: Localized; links?: { label: Localized; pageId: string }[] };
  pages: Page[];
  assets: Asset[];
  forms: FormDef[];
}

const ID = '^[a-z][a-z0-9_-]{0,39}$';
const HEX = '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$';
const loc = (max = 400): Schema => ({
  type: 'object',
  additionalProperties: false,
  properties: { ar: { type: 'string', maxLength: max }, en: { type: 'string', maxLength: max } },
});

export const SITE_MODEL_SCHEMA: Schema = {
  $id: 'nuzm://schemas/site-model/1',
  title: 'Nuzm site model v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'locales',
    'defaultLocale',
    'brand',
    'tokens',
    'seo',
    'nav',
    'footer',
    'pages',
    'assets',
    'forms',
  ],
  properties: {
    schemaVersion: { const: 1 },
    locales: { type: 'array', minItems: 1, maxItems: 2, items: { enum: LOCALES } },
    defaultLocale: { enum: LOCALES },
    brand: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: loc(80),
        logoAssetId: { type: 'string', pattern: ID },
        colors: {
          type: 'object',
          additionalProperties: false,
          properties: {
            primary: { type: 'string', pattern: HEX },
            accent: { type: 'string', pattern: HEX },
            background: { type: 'string', pattern: HEX },
            text: { type: 'string', pattern: HEX },
          },
        },
      },
    },
    tokens: {
      type: 'object',
      additionalProperties: false,
      required: ['radius', 'spacing', 'fontFamily', 'width'],
      properties: {
        radius: { enum: ['none', 'sm', 'md', 'lg'] },
        spacing: { enum: ['compact', 'normal', 'relaxed'] },
        fontFamily: { enum: ['sans', 'serif'] },
        width: { enum: ['narrow', 'normal', 'wide'] },
      },
    },
    seo: {
      type: 'object',
      additionalProperties: false,
      required: ['siteTitle', 'description'],
      properties: {
        siteTitle: loc(70),
        description: loc(200),
        ogImageAssetId: { type: 'string', pattern: ID },
        baseUrl: {
          type: 'string',
          pattern: '^https://[A-Za-z0-9.-]+(:[0-9]{2,5})?(/[A-Za-z0-9._~/-]*)?$',
          maxLength: 200,
        },
        organization: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', maxLength: 120 },
            phone: { type: 'string', pattern: '^\\+?[0-9 ()-]{5,24}$' },
            email: { type: 'string', pattern: '^[^@\\s<>"]{1,64}@[^@\\s<>"]{1,200}$' },
            address: loc(200),
            geo: {
              type: 'object',
              additionalProperties: false,
              required: ['lat', 'lng'],
              properties: {
                lat: { type: 'number', minimum: -90, maximum: 90 },
                lng: { type: 'number', minimum: -180, maximum: 180 },
              },
            },
            type: {
              enum: [
                'Organization',
                'LocalBusiness',
                'Restaurant',
                'MedicalClinic',
                'Store',
                'EducationalOrganization',
                'NGO',
              ],
            },
            openingHours: { type: 'array', maxItems: 14, items: { type: 'string', maxLength: 60 } },
          },
        },
      },
    },
    nav: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['pageId'],
            properties: { pageId: { type: 'string', pattern: ID }, label: loc(40) },
          },
        },
      },
    },
    footer: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: loc(300),
        links: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'pageId'],
            properties: { label: loc(40), pageId: { type: 'string', pattern: ID } },
          },
        },
      },
    },
    pages: {
      type: 'array',
      minItems: 1,
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'slug', 'title', 'sections'],
        properties: {
          id: { type: 'string', pattern: ID },
          slug: { type: 'string', pattern: '^(home|[a-z0-9][a-z0-9-]{0,59})$' },
          title: loc(80),
          seo: {
            type: 'object',
            additionalProperties: false,
            properties: { title: loc(70), description: loc(200), noindex: { type: 'boolean' } },
          },
          sections: {
            type: 'array',
            maxItems: 40,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'type', 'props'],
              properties: {
                id: { type: 'string', pattern: ID },
                type: { enum: SECTION_TYPES },
                props: { type: 'object' },
                style: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    background: { enum: ['default', 'muted', 'primary'] },
                    align: { enum: ['start', 'center'] },
                  },
                },
              },
            },
          },
        },
      },
    },
    assets: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'source', 'alt'],
        properties: {
          id: { type: 'string', pattern: ID },
          kind: { const: 'image' },
          source: { enum: ['placeholder', 'upload'] },
          alt: loc(200),
          contentHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          mime: { enum: ['image/png', 'image/jpeg', 'image/webp'] },
          width: { type: 'integer', minimum: 1, maximum: 10000 },
          height: { type: 'integer', minimum: 1, maximum: 10000 },
          label: { type: 'string', maxLength: 60 },
        },
      },
    },
    forms: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'fields', 'submitLabel', 'successMessage'],
        properties: {
          id: { type: 'string', pattern: ID },
          name: { type: 'string', minLength: 1, maxLength: 80 },
          fields: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'type', 'label'],
              properties: {
                name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,29}$' },
                type: { enum: ['text', 'email', 'tel', 'textarea'] },
                label: loc(60),
                required: { type: 'boolean' },
              },
            },
          },
          submitLabel: loc(40),
          successMessage: loc(200),
        },
      },
    },
  },
};

/** What each component type needs. Localized fields are listed so completeness per locale can be enforced. */
export interface SectionSpec {
  /** props that are plain strings (escaped by the renderer) */
  strings?: Record<string, number>;
  /** props that are Localized required strings (value = max length) */
  loc?: Record<string, number>;
  /** optional Localized */
  locOpt?: Record<string, number>;
  /** props that reference asset ids */
  assets?: string[];
  /** props that are lists of items with their own localized fields */
  items?: {
    prop: string;
    max: number;
    loc: Record<string, number>;
    locOpt?: Record<string, number>;
    strings?: Record<string, number>;
    assets?: string[];
    min?: number;
  };
  /** prop that references a form id */
  form?: string;
  /** prop that is a link: {pageId} | {url} */
  link?: string[];
}
export const SECTION_SPECS: Record<SectionType, SectionSpec> = {
  hero: {
    loc: { heading: 120 },
    locOpt: { subheading: 300, ctaLabel: 40 },
    assets: ['imageAssetId'],
    link: ['cta'],
  },
  text: { locOpt: { heading: 120 }, loc: { body: 4000 } },
  image: { assets: ['assetId'], locOpt: { caption: 200 } },
  gallery: {
    items: {
      prop: 'images',
      max: 24,
      min: 1,
      loc: {},
      locOpt: { caption: 200 },
      assets: ['assetId'],
    },
    locOpt: { heading: 120 },
  },
  features: {
    locOpt: { heading: 120 },
    strings: { collection: 40 },
    items: { prop: 'items', max: 12, min: 1, loc: { title: 80, text: 400 }, strings: { icon: 24 } },
  },
  pricing: {
    locOpt: { heading: 120 },
    strings: { collection: 40 },
    items: {
      prop: 'plans',
      max: 8,
      min: 1,
      loc: { name: 60 },
      locOpt: { description: 200, period: 30 },
      strings: { price: 20, currency: 3 },
    },
  },
  testimonials: {
    locOpt: { heading: 120 },
    strings: { collection: 40 },
    items: {
      prop: 'items',
      max: 12,
      min: 1,
      loc: { quote: 400 },
      strings: { author: 80 },
      locOpt: { role: 80 },
    },
  },
  faq: {
    locOpt: { heading: 120 },
    strings: { collection: 40 },
    items: { prop: 'items', max: 20, min: 1, loc: { question: 200, answer: 1000 } },
  },
  contact_form: { locOpt: { heading: 120, intro: 400 }, form: 'formId' },
  map: { locOpt: { heading: 120, address: 200 }, strings: { query: 200 } },
};

const SAFE_URL =
  /^(https?:\/\/[^\s<>"'`\\]+|mailto:[^\s<>"'`\\]+|tel:\+?[0-9 ()-]{5,24}|\/[^\s<>"'`\\]*|#[A-Za-z0-9_-]+)$/;
export const isSafeUrl = (u: unknown): u is string =>
  typeof u === 'string' &&
  u.length <= 2000 &&
  SAFE_URL.test(u) &&
  !/^\s*(javascript|data|vbscript):/i.test(u);

export interface ModelIssue {
  path: string;
  message: string;
}

const isLoc = (v: unknown): v is Localized =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Structural (JSON schema) + semantic validation: unique ids, slugs and nav/footer/asset/form references, per-locale completeness of required text, safe URLs,
 * per-component props. Returns every issue; an empty list means the model is safe to render and to save as a version.
 */
export function validateSiteModel(model: unknown): ModelIssue[] {
  const issues: ModelIssue[] = validateSchema(SITE_MODEL_SCHEMA, model).map((e) => ({
    path: e.path,
    message: e.message,
  }));
  if (issues.length > 0) return issues; // semantic checks assume the shape
  const m = model as SiteModel;
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!m.locales.includes(m.defaultLocale)) add('$.defaultLocale', 'must be one of locales');
  if (new Set(m.locales).size !== m.locales.length) add('$.locales', 'duplicate locale');
  const need = (path: string, v: unknown, max: number) => {
    if (!isLoc(v)) return add(path, 'is required');
    for (const l of m.locales) {
      const s = (v as Localized)[l];
      if (typeof s !== 'string' || s.trim() === '') add(`${path}.${l}`, `missing ${l} text`);
      else if (s.length > max) add(`${path}.${l}`, `longer than ${max}`);
    }
  };
  const optional = (path: string, v: unknown, max: number) => {
    if (v === undefined) return;
    if (!isLoc(v)) return add(path, 'must be a localized text');
    // an optional text is all-or-nothing across the declared locales: half a translation is a defect
    const present = m.locales.filter(
      (l) => typeof (v as Localized)[l] === 'string' && (v as Localized)[l]!.trim() !== '',
    );
    if (present.length !== 0 && present.length !== m.locales.length)
      add(path, 'translate every declared locale or none');
    for (const l of present)
      if ((v as Localized)[l]!.length > max) add(`${path}.${l}`, `longer than ${max}`);
  };
  need('$.brand.name', m.brand.name, 80);
  need('$.seo.siteTitle', m.seo.siteTitle, 70);
  need('$.seo.description', m.seo.description, 200);
  need('$.footer.text', m.footer.text, 300);
  const pageIds = new Set<string>();
  const slugs = new Set<string>();
  m.pages.forEach((p, i) => {
    if (pageIds.has(p.id)) add(`$.pages[${i}].id`, 'duplicate page id');
    pageIds.add(p.id);
    if (slugs.has(p.slug)) add(`$.pages[${i}].slug`, 'duplicate slug');
    slugs.add(p.slug);
    need(`$.pages[${i}].title`, p.title, 80);
    if (p.seo) {
      optional(`$.pages[${i}].seo.title`, p.seo.title, 70);
      optional(`$.pages[${i}].seo.description`, p.seo.description, 200);
    }
  });
  if (!m.pages.some((p) => p.slug === 'home')) add('$.pages', 'one page must have the slug "home"');
  const assetIds = new Set(m.assets.map((a) => a.id));
  if (assetIds.size !== m.assets.length) add('$.assets', 'duplicate asset id');
  m.assets.forEach((a, i) => {
    need(`$.assets[${i}].alt`, a.alt, 200);
    if (a.source === 'upload' && (!a.contentHash || !a.mime))
      add(`$.assets[${i}]`, 'an uploaded asset needs contentHash and mime');
  });
  for (const ref of [m.brand.logoAssetId, m.seo.ogImageAssetId])
    if (ref !== undefined && !assetIds.has(ref)) add('$.brand/seo', `unknown asset ${ref}`);
  const formIds = new Set(m.forms.map((f) => f.id));
  if (formIds.size !== m.forms.length) add('$.forms', 'duplicate form id');
  m.forms.forEach((f, i) => {
    need(`$.forms[${i}].submitLabel`, f.submitLabel, 40);
    need(`$.forms[${i}].successMessage`, f.successMessage, 200);
    const names = new Set<string>();
    f.fields.forEach((fl, j) => {
      need(`$.forms[${i}].fields[${j}].label`, fl.label, 60);
      if (names.has(fl.name)) add(`$.forms[${i}].fields[${j}].name`, 'duplicate field name');
      names.add(fl.name);
    });
  });
  m.nav.items.forEach((n, i) => {
    if (!pageIds.has(n.pageId)) add(`$.nav.items[${i}].pageId`, 'unknown page');
    optional(`$.nav.items[${i}].label`, n.label, 40);
  });
  (m.footer.links ?? []).forEach((n, i) => {
    if (!pageIds.has(n.pageId)) add(`$.footer.links[${i}].pageId`, 'unknown page');
    need(`$.footer.links[${i}].label`, n.label, 40);
  });
  const sectionIds = new Set<string>();
  m.pages.forEach((p, pi) =>
    p.sections.forEach((s, si) => {
      const base = `$.pages[${pi}].sections[${si}]`;
      if (sectionIds.has(s.id)) add(`${base}.id`, 'duplicate section id');
      sectionIds.add(s.id);
      const spec = SECTION_SPECS[s.type];
      const props = s.props;
      const allowed = new Set<string>([
        ...Object.keys(spec.loc ?? {}),
        ...Object.keys(spec.locOpt ?? {}),
        ...Object.keys(spec.strings ?? {}),
        ...(spec.assets ?? []),
        ...(spec.items ? [spec.items.prop] : []),
        ...(spec.form ? [spec.form] : []),
        ...(spec.link ?? []),
      ]);
      for (const k of Object.keys(props))
        if (!allowed.has(k)) add(`${base}.props.${k}`, `is not a property of ${s.type}`);
      for (const [k, max] of Object.entries(spec.loc ?? {}))
        need(`${base}.props.${k}`, props[k], max);
      for (const [k, max] of Object.entries(spec.locOpt ?? {}))
        optional(`${base}.props.${k}`, props[k], max);
      for (const [k, max] of Object.entries(spec.strings ?? {}))
        if (
          props[k] !== undefined &&
          (typeof props[k] !== 'string' || (props[k] as string).length > max)
        )
          add(`${base}.props.${k}`, `must be a string up to ${max}`);
      for (const k of spec.assets ?? []) {
        const v = props[k];
        if (v === undefined) {
          if (s.type === 'image' && k === 'assetId') add(`${base}.props.${k}`, 'is required');
          continue;
        }
        if (typeof v !== 'string' || !assetIds.has(v)) add(`${base}.props.${k}`, 'unknown asset');
      }
      for (const k of spec.link ?? []) {
        const v = props[k] as { pageId?: unknown; url?: unknown } | undefined;
        if (v === undefined) continue;
        if (typeof v !== 'object' || v === null)
          add(`${base}.props.${k}`, 'must be {pageId} or {url}');
        else if (v.pageId !== undefined) {
          if (typeof v.pageId !== 'string' || !pageIds.has(v.pageId))
            add(`${base}.props.${k}.pageId`, 'unknown page');
        } else if (!isSafeUrl(v.url))
          add(`${base}.props.${k}.url`, 'is not a safe URL (https, mailto, tel, /path or #anchor)');
      }
      if (spec.form) {
        const v = props[spec.form];
        if (typeof v !== 'string' || !formIds.has(v))
          add(`${base}.props.${spec.form}`, 'unknown form');
      }
      if (spec.items) {
        const it = spec.items;
        const list = props[it.prop];
        if (!Array.isArray(list) || list.length < (it.min ?? 0) || list.length > it.max)
          add(`${base}.props.${it.prop}`, `needs ${it.min ?? 0}..${it.max} items`);
        else
          list.forEach((x: Record<string, unknown>, xi) => {
            const ip = `${base}.props.${it.prop}[${xi}]`;
            if (typeof x !== 'object' || x === null) return add(ip, 'must be an object');
            const ok = new Set([
              ...Object.keys(it.loc),
              ...Object.keys(it.locOpt ?? {}),
              ...Object.keys(it.strings ?? {}),
              ...(it.assets ?? []),
            ]);
            for (const k of Object.keys(x)) if (!ok.has(k)) add(`${ip}.${k}`, 'is not allowed');
            for (const [k, max] of Object.entries(it.loc)) need(`${ip}.${k}`, x[k], max);
            for (const [k, max] of Object.entries(it.locOpt ?? {}))
              optional(`${ip}.${k}`, x[k], max);
            for (const [k, max] of Object.entries(it.strings ?? {})) {
              const required =
                it.prop === 'plans'
                  ? k === 'price'
                  : it.prop === 'testimonials'
                    ? k === 'author'
                    : false;
              if (
                (x[k] === undefined && required) ||
                (x[k] !== undefined && (typeof x[k] !== 'string' || (x[k] as string).length > max))
              )
                add(`${ip}.${k}`, `must be a string up to ${max}`);
            }
            for (const k of it.assets ?? [])
              if (typeof x[k] !== 'string' || !assetIds.has(x[k] as string))
                add(`${ip}.${k}`, 'unknown asset');
          });
      }
      if (s.type === 'pricing' && Array.isArray(props.plans))
        (props.plans as Record<string, unknown>[]).forEach((pl, i) => {
          if (typeof pl.price === 'string' && !/^\d{1,9}(\.\d{1,2})?$/.test(pl.price))
            add(`${base}.props.plans[${i}].price`, 'must be a decimal number string');
          if (pl.currency !== undefined && !/^[A-Z]{3}$/.test(String(pl.currency)))
            add(`${base}.props.plans[${i}].currency`, 'must be an ISO 4217 code');
        });
    }),
  );
  return issues;
}

export const isSiteModel = (m: unknown): m is SiteModel => validateSiteModel(m).length === 0;

/** A minimal valid bilingual model (home page with a hero): the starting point of an empty project. */
export function emptySiteModel(name: Localized, locales: Locale[] = ['ar', 'en']): SiteModel {
  const L = (ar: string, en: string): Localized =>
    Object.fromEntries(locales.map((l) => [l, l === 'ar' ? ar : en])) as Localized;
  return {
    schemaVersion: 1,
    locales,
    defaultLocale: locales[0]!,
    brand: { name },
    tokens: { radius: 'md', spacing: 'normal', fontFamily: 'sans', width: 'normal' },
    seo: { siteTitle: name, description: L('موقع جديد', 'A new website') },
    nav: { items: [{ pageId: 'home' }] },
    footer: { text: L('جميع الحقوق محفوظة', 'All rights reserved') },
    pages: [
      {
        id: 'home',
        slug: 'home',
        title: L('الرئيسية', 'Home'),
        sections: [{ id: 'hero1', type: 'hero', props: { heading: name } }],
      },
    ],
    assets: [],
    forms: [],
  };
}
