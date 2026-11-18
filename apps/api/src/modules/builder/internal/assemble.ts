import {
  emptySiteModel,
  type Architecture,
  type Asset,
  type FormDef,
  type Locale,
  type Localized,
  type Page,
  type Requirements,
  type Section,
  type SiteModel,
} from '@nuzm/domain';

const loc = (locales: Locale[], ar: string, en: string): Localized =>
  Object.fromEntries(locales.map((l) => [l, l === 'ar' ? ar : en])) as Localized;
const keepLocales = (v: unknown, locales: Locale[]): unknown => {
  if (Array.isArray(v)) return v.map((x) => keepLocales(x, locales));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (('ar' in o || 'en' in o) && Object.keys(o).every((k) => k === 'ar' || k === 'en'))
      return Object.fromEntries(
        Object.entries(o).filter(([k]) => (locales as string[]).includes(k)),
      );
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, keepLocales(x, locales)]));
  }
  return v;
};
export interface PageResult {
  pageId: string;
  title: Localized;
  seo?: Page['seo'];
  sections: Section[];
  assets?: Asset[];
  forms?: FormDef[];
}
const assetRefs = (s: Section): string[] => {
  const p = s.props;
  const out: string[] = [];
  for (const k of ['imageAssetId', 'assetId'])
    if (typeof p[k] === 'string') out.push(p[k] as string);
  if (Array.isArray(p.images))
    for (const i of p.images as { assetId?: string }[])
      if (typeof i?.assetId === 'string') out.push(i.assetId);
  return out;
};

/**
 * Assemble the site model from the approved architecture and the per-page results. Only placeholder images are ever created (a licensed imagery source is a pending
 * legal decision); a referenced-but-undefined asset becomes a placeholder, a referenced-but-undefined contact form becomes the standard bilingual contact form.
 * Locales not declared by the project are removed from every text so the model is complete for exactly the declared locales.
 */
export function assembleGenerated(
  project: { name: string; locales: Locale[] },
  req: Requirements,
  arch: Architecture,
  pages: PageResult[],
): SiteModel {
  const locales = project.locales;
  const m = emptySiteModel(loc(locales, project.name, project.name), locales);
  m.brand.colors = {
    primary: arch.designTokens.colors.primary,
    accent: arch.designTokens.colors.accent,
    background: arch.designTokens.colors.background,
    text: arch.designTokens.colors.text,
  };
  m.tokens = {
    radius: arch.designTokens.radius,
    spacing: arch.designTokens.spacing,
    fontFamily: arch.designTokens.fontFamily,
    width: arch.designTokens.width,
  };
  const home = arch.siteMap.find((p) => p.slug === 'home') ?? arch.siteMap[0]!;
  const homeSeo = arch.seoPlan.find((s) => s.pageId === home.pageId);
  m.seo = {
    siteTitle: keepLocales(homeSeo?.title ?? m.seo.siteTitle, locales) as Localized,
    description: keepLocales(homeSeo?.description ?? m.seo.description, locales) as Localized,
  };
  m.pages = [];
  const assets = new Map<string, Asset>();
  const forms = new Map<string, FormDef>();
  for (const ap of arch.siteMap) {
    const r = pages.find((x) => x.pageId === ap.pageId);
    if (!r) continue;
    const plan = arch.seoPlan.find((s) => s.pageId === ap.pageId);
    const page: Page = {
      id: ap.pageId,
      slug: ap.slug,
      title: keepLocales(r.title, locales) as Localized,
      sections: keepLocales(r.sections, locales) as Section[],
    };
    const seo = {
      ...(r.seo ?? {}),
      ...(plan ? { title: plan.title, description: plan.description } : {}),
    };
    if (Object.keys(seo).length) page.seo = keepLocales(seo, locales) as Page['seo'];
    m.pages.push(page);
    for (const a of r.assets ?? []) assets.set(a.id, keepLocales(a, locales) as Asset);
    for (const f of r.forms ?? []) forms.set(f.id, keepLocales(f, locales) as FormDef);
    for (const s of page.sections) {
      for (const id of assetRefs(s))
        if (!assets.has(id))
          assets.set(id, {
            id,
            kind: 'image',
            source: 'placeholder',
            alt: keepLocales(page.title, locales) as Localized,
            label: page.slug.slice(0, 40),
          });
      if (
        s.type === 'contact_form' &&
        typeof s.props.formId === 'string' &&
        !forms.has(s.props.formId)
      ) {
        forms.set(s.props.formId, {
          id: s.props.formId,
          name: 'Contact',
          fields: [
            { name: 'name', type: 'text', label: loc(locales, 'الاسم', 'Name'), required: true },
            {
              name: 'email',
              type: 'email',
              label: loc(locales, 'البريد الإلكتروني', 'Email'),
              required: true,
            },
            {
              name: 'message',
              type: 'textarea',
              label: loc(locales, 'الرسالة', 'Message'),
              required: true,
            },
          ],
          submitLabel: loc(locales, 'إرسال', 'Send'),
          successMessage: loc(
            locales,
            'شكرًا، وصلتنا رسالتك.',
            'Thank you, we received your message.',
          ),
        });
      }
    }
  }
  m.assets = [...assets.values()];
  m.forms = [...forms.values()];
  m.nav = {
    items: arch.siteMap
      .filter((p) => m.pages.some((x) => x.id === p.pageId))
      .slice(0, 12)
      .map((p) => ({ pageId: p.pageId })),
  };
  void req;
  return m;
}
