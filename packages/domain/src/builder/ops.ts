import { validateSchema, type Schema } from '../schema';
import {
  validateSiteModel,
  type Asset,
  type Locale,
  type Localized,
  type Page,
  type Section,
  type SiteModel,
  type Tokens,
} from './site-model';

/**
 * Editor operation model (M09 S40). A change is an ORDERED op set applied atomically to a site model: every op is validated, the resulting model must pass
 * `validateSiteModel`, and the call returns the NEW model, the INVERSE ops (undo; applying the inverse of the inverse redoes), a SAFE DIFF (structural + rendered
 * text) and RISK flags. Pure: no I/O. A rejected op set changes nothing.
 */
export type Op =
  | { op: 'insertComponent'; pageId: string; section: Section; index?: number }
  | {
      op: 'updateProps';
      pageId: string;
      sectionId: string;
      props: Record<string, unknown>;
      style?: Section['style'] | null;
    }
  | { op: 'moveComponent'; pageId: string; sectionId: string; toPageId?: string; index: number }
  | { op: 'deleteComponent'; pageId: string; sectionId: string }
  | { op: 'setTokens'; tokens?: Partial<Tokens>; colors?: Record<string, string | null> }
  | {
      op: 'setText';
      target:
        'brandName' | 'siteTitle' | 'siteDescription' | 'footerText' | 'pageTitle' | 'section';
      pageId?: string;
      sectionId?: string;
      prop?: string;
      locale: Locale;
      value: string | null;
    }
  | {
      op: 'addPage';
      page: Page;
      index?: number;
      nav?: boolean;
      restoreNav?: { index: number; item: SiteModel['nav']['items'][number] }[];
      restoreFooter?: { index: number; item: NonNullable<SiteModel['footer']['links']>[number] }[];
    }
  | { op: 'deletePage'; pageId: string }
  | {
      op: 'updatePage';
      pageId: string;
      slug?: string;
      seo?: {
        title?: Localized | null;
        description?: Localized | null;
        noindex?: boolean | null;
      } | null;
    }
  | {
      op: 'setSeo';
      seo: {
        siteTitle?: Localized;
        description?: Localized;
        baseUrl?: string | null;
        organization?: SiteModel['seo']['organization'] | null;
      };
    }
  | { op: 'setNav'; items: SiteModel['nav']['items'] }
  | { op: 'addAsset'; asset: Asset; index?: number }
  | { op: 'removeAsset'; assetId: string };

export class OpInvalid extends Error {
  constructor(
    readonly index: number,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(`op ${index}: ${message}`);
  }
}

const ID = '^[a-z][a-z0-9_-]{0,39}$';
const LOC: Schema = {
  type: 'object',
  additionalProperties: false,
  properties: { ar: { type: 'string' }, en: { type: 'string' } },
};
const OP_SCHEMAS: Record<string, Schema> = {
  insertComponent: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'pageId', 'section'],
    properties: {
      op: { const: 'insertComponent' },
      pageId: { type: 'string', pattern: ID },
      section: { type: 'object' },
      index: { type: 'integer', minimum: 0, maximum: 40 },
    },
  },
  updateProps: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'pageId', 'sectionId', 'props'],
    properties: {
      op: { const: 'updateProps' },
      pageId: { type: 'string', pattern: ID },
      sectionId: { type: 'string', pattern: ID },
      props: { type: 'object' },
      style: { type: ['object', 'null'] },
    },
  },
  moveComponent: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'pageId', 'sectionId', 'index'],
    properties: {
      op: { const: 'moveComponent' },
      pageId: { type: 'string', pattern: ID },
      sectionId: { type: 'string', pattern: ID },
      toPageId: { type: 'string', pattern: ID },
      index: { type: 'integer', minimum: 0, maximum: 40 },
    },
  },
  deleteComponent: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'pageId', 'sectionId'],
    properties: {
      op: { const: 'deleteComponent' },
      pageId: { type: 'string', pattern: ID },
      sectionId: { type: 'string', pattern: ID },
    },
  },
  setTokens: {
    type: 'object',
    additionalProperties: false,
    required: ['op'],
    properties: {
      op: { const: 'setTokens' },
      tokens: { type: 'object' },
      colors: { type: 'object' },
    },
  },
  setText: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'locale', 'value'],
    properties: {
      op: { const: 'setText' },
      target: {
        enum: ['brandName', 'siteTitle', 'siteDescription', 'footerText', 'pageTitle', 'section'],
      },
      pageId: { type: 'string', pattern: ID },
      sectionId: { type: 'string', pattern: ID },
      prop: { type: 'string', maxLength: 40 },
      locale: { enum: ['ar', 'en'] },
      value: { type: ['string', 'null'], maxLength: 4000 },
    },
  },
  addPage: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'page'],
    properties: {
      op: { const: 'addPage' },
      page: { type: 'object' },
      index: { type: 'integer', minimum: 0, maximum: 30 },
      nav: { type: 'boolean' },
      restoreNav: { type: 'array', maxItems: 12 },
      restoreFooter: { type: 'array', maxItems: 12 },
    },
  },
  deletePage: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'pageId'],
    properties: { op: { const: 'deletePage' }, pageId: { type: 'string', pattern: ID } },
  },
  updatePage: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'pageId'],
    properties: {
      op: { const: 'updatePage' },
      pageId: { type: 'string', pattern: ID },
      slug: { type: 'string', maxLength: 60 },
      seo: { type: ['object', 'null'] },
    },
  },
  setSeo: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'seo'],
    properties: {
      op: { const: 'setSeo' },
      seo: {
        type: 'object',
        additionalProperties: false,
        properties: {
          siteTitle: LOC,
          description: LOC,
          baseUrl: { type: ['string', 'null'] },
          organization: { type: ['object', 'null'] },
        },
      },
    },
  },
  setNav: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'items'],
    properties: { op: { const: 'setNav' }, items: { type: 'array', maxItems: 12 } },
  },
  addAsset: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'asset'],
    properties: {
      op: { const: 'addAsset' },
      asset: { type: 'object' },
      index: { type: 'integer', minimum: 0, maximum: 200 },
    },
  },
  removeAsset: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'assetId'],
    properties: { op: { const: 'removeAsset' }, assetId: { type: 'string', pattern: ID } },
  },
};
export const OP_KINDS = Object.keys(OP_SCHEMAS);
export const MAX_OPS = 200;

export interface DiffEntry {
  kind: string;
  pageId?: string;
  sectionId?: string;
  summary: string;
}
export interface TextChange {
  path: string;
  locale: Locale;
  before: string | null;
  after: string | null;
}
export interface Risk {
  code:
    | 'deletes_page'
    | 'deletes_component'
    | 'changes_seo'
    | 'changes_slug'
    | 'removes_asset'
    | 'many_changes'
    | 'changes_base_url';
  count: number;
  detail?: string;
}
export interface ApplyResult {
  model: SiteModel;
  inverse: Op[];
  diff: { structural: DiffEntry[]; text: TextChange[] };
  risks: Risk[];
  /** every op is one of the low-risk kinds and no risk flag is raised: eligible for auto-apply when the organization enabled it (never for deletes, publish or paid actions) */
  lowRisk: boolean;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const LOW_RISK = new Set([
  'setText',
  'updateProps',
  'setTokens',
  'moveComponent',
  'insertComponent',
]);

export function validateOps(ops: unknown): asserts ops is Op[] {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS)
    throw new OpInvalid(-1, `ops must be a list of 1..${MAX_OPS} operations`);
  ops.forEach((o: { op?: string }, i) => {
    const s = typeof o?.op === 'string' ? OP_SCHEMAS[o.op] : undefined;
    if (!s) throw new OpInvalid(i, `unknown operation ${String(o?.op).slice(0, 30)}`);
    const errs = validateSchema(s, o);
    if (errs.length) throw new OpInvalid(i, 'is malformed', errs);
  });
}

/** localized text locations of a model, for the rendered-text diff */
function texts(m: SiteModel): Map<string, string> {
  const out = new Map<string, string>();
  const put = (path: string, l: Localized | undefined) => {
    for (const k of ['ar', 'en'] as const)
      if (typeof l?.[k] === 'string') out.set(`${path}|${k}`, l![k]!);
  };
  put('brand.name', m.brand.name);
  put('seo.siteTitle', m.seo.siteTitle);
  put('seo.description', m.seo.description);
  put('footer.text', m.footer.text);
  for (const p of m.pages) {
    put(`page:${p.id}.title`, p.title);
    put(`page:${p.id}.seo.title`, p.seo?.title);
    put(`page:${p.id}.seo.description`, p.seo?.description);
    for (const s of p.sections) {
      for (const [k, v] of Object.entries(s.props)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && ('ar' in v || 'en' in v))
          put(`page:${p.id}.section:${s.id}.${k}`, v as Localized);
        else if (Array.isArray(v))
          v.forEach((it, i) => {
            if (it && typeof it === 'object')
              for (const [ik, iv] of Object.entries(it as Record<string, unknown>))
                if (iv && typeof iv === 'object' && ('ar' in iv || 'en' in iv))
                  put(`page:${p.id}.section:${s.id}.${k}[${i}].${ik}`, iv as Localized);
          });
      }
    }
  }
  return out;
}

export function diffModels(a: SiteModel, b: SiteModel): ApplyResult['diff'] {
  const structural: DiffEntry[] = [];
  const pa = new Map(a.pages.map((p) => [p.id, p]));
  const pb = new Map(b.pages.map((p) => [p.id, p]));
  for (const [id, p] of pb)
    if (!pa.has(id))
      structural.push({
        kind: 'page_added',
        pageId: id,
        summary: `page ${p.slug} added (${p.sections.length} sections)`,
      });
  for (const [id, p] of pa) {
    if (!pb.has(id)) {
      structural.push({
        kind: 'page_deleted',
        pageId: id,
        summary: `page ${p.slug} deleted (${p.sections.length} sections)`,
      });
      continue;
    }
    const q = pb.get(id)!;
    if (p.slug !== q.slug)
      structural.push({ kind: 'slug_changed', pageId: id, summary: `slug ${p.slug} → ${q.slug}` });
    const sa = new Map(p.sections.map((s) => [s.id, s]));
    const sb = new Map(q.sections.map((s) => [s.id, s]));
    for (const [sid, s] of sb)
      if (!sa.has(sid))
        structural.push({
          kind: 'component_added',
          pageId: id,
          sectionId: sid,
          summary: `${s.type} added`,
        });
    for (const [sid, s] of sa) {
      if (!sb.has(sid))
        structural.push({
          kind: 'component_deleted',
          pageId: id,
          sectionId: sid,
          summary: `${s.type} deleted`,
        });
      else if (!eq(s.props, sb.get(sid)!.props) || !eq(s.style, sb.get(sid)!.style))
        structural.push({
          kind: 'component_changed',
          pageId: id,
          sectionId: sid,
          summary: `${s.type} changed`,
        });
    }
    const ia = p.sections.filter((s) => sb.has(s.id)).map((s) => s.id);
    const ib = q.sections.filter((s) => sa.has(s.id)).map((s) => s.id);
    if (!eq(ia, ib))
      structural.push({
        kind: 'components_reordered',
        pageId: id,
        summary: 'components reordered',
      });
  }
  if (!eq(a.tokens, b.tokens) || !eq(a.brand.colors, b.brand.colors))
    structural.push({ kind: 'tokens_changed', summary: 'design tokens changed' });
  if (!eq(a.seo.organization, b.seo.organization) || a.seo.baseUrl !== b.seo.baseUrl)
    structural.push({ kind: 'seo_changed', summary: 'site SEO settings changed' });
  if (!eq(a.nav, b.nav)) structural.push({ kind: 'nav_changed', summary: 'navigation changed' });
  if (
    !eq(
      a.assets.map((x) => x.id),
      b.assets.map((x) => x.id),
    )
  )
    structural.push({ kind: 'assets_changed', summary: 'assets changed' });
  const ta = texts(a);
  const tb = texts(b);
  const text: TextChange[] = [];
  for (const k of new Set([...ta.keys(), ...tb.keys()])) {
    const x = ta.get(k) ?? null;
    const y = tb.get(k) ?? null;
    if (x !== y) {
      const [path, locale] = k.split('|') as [string, Locale];
      text.push({ path, locale, before: x, after: y });
    }
  }
  return { structural, text };
}

function risksOf(a: SiteModel, b: SiteModel, ops: Op[], diff: ApplyResult['diff']): Risk[] {
  const r: Risk[] = [];
  const dp = diff.structural.filter((d) => d.kind === 'page_deleted').length;
  if (dp) r.push({ code: 'deletes_page', count: dp });
  const dc = diff.structural.filter((d) => d.kind === 'component_deleted').length;
  if (dc) r.push({ code: 'deletes_component', count: dc });
  const sl = diff.structural.filter((d) => d.kind === 'slug_changed').length;
  if (sl)
    r.push({
      code: 'changes_slug',
      count: sl,
      detail: 'URLs change: links from outside the site will break',
    });
  const seoPages = new Set(
    diff.text.filter((t) => /\.seo\./.test(t.path)).map((t) => t.path.split('.')[0]),
  );
  for (const o of ops)
    if (o.op === 'updatePage' && o.seo !== undefined) seoPages.add(`page:${o.pageId}`);
  if (seoPages.size >= 3)
    r.push({
      code: 'changes_seo',
      count: seoPages.size,
      detail: `changes SEO of ${seoPages.size} pages`,
    });
  const ra = a.assets.filter((x) => !b.assets.some((y) => y.id === x.id)).length;
  if (ra) r.push({ code: 'removes_asset', count: ra });
  if (a.seo.baseUrl !== b.seo.baseUrl) r.push({ code: 'changes_base_url', count: 1 });
  if (ops.length > 50) r.push({ code: 'many_changes', count: ops.length });
  return r;
}

const findPage = (m: SiteModel, id: string, i: number) => {
  const p = m.pages.find((x) => x.id === id);
  if (!p) throw new OpInvalid(i, `unknown page ${id}`);
  return p;
};
const findSection = (p: Page, id: string, i: number) => {
  const idx = p.sections.findIndex((s) => s.id === id);
  if (idx < 0) throw new OpInvalid(i, `unknown component ${id} on page ${p.id}`);
  return idx;
};
const mergeNullable = (target: Record<string, unknown>, patch: Record<string, unknown>) => {
  const prev: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = k in target ? target[k] : null;
    if (v === null) delete target[k];
    else target[k] = v;
  }
  return prev;
};
const TEXT_PROP_SECTION = (s: Section, prop: string): Localized => {
  const cur = s.props[prop];
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Localized) : {};
};

/** Apply ONE op to `m` in place, returning its inverse. Throws OpInvalid; the caller works on a clone, so a throw leaves nothing half-applied. */
function applyOne(m: SiteModel, o: Op, i: number): Op {
  switch (o.op) {
    case 'insertComponent': {
      const p = findPage(m, o.pageId, i);
      const idx = Math.min(o.index ?? p.sections.length, p.sections.length);
      p.sections.splice(idx, 0, clone(o.section));
      return { op: 'deleteComponent', pageId: o.pageId, sectionId: o.section.id };
    }
    case 'updateProps': {
      const p = findPage(m, o.pageId, i);
      const s = p.sections[findSection(p, o.sectionId, i)]!;
      const prev = mergeNullable(s.props, o.props);
      let prevStyle: Section['style'] | null | undefined;
      if (o.style !== undefined) {
        prevStyle = s.style ?? null;
        if (o.style === null) delete s.style;
        else s.style = o.style;
      }
      return {
        op: 'updateProps',
        pageId: o.pageId,
        sectionId: o.sectionId,
        props: prev,
        ...(o.style !== undefined ? { style: prevStyle ?? null } : {}),
      };
    }
    case 'moveComponent': {
      const from = findPage(m, o.pageId, i);
      const fi = findSection(from, o.sectionId, i);
      const to = o.toPageId ? findPage(m, o.toPageId, i) : from;
      const [s] = from.sections.splice(fi, 1);
      const idx = Math.min(o.index, to.sections.length);
      to.sections.splice(idx, 0, s!);
      return {
        op: 'moveComponent',
        pageId: to.id,
        sectionId: o.sectionId,
        toPageId: from.id,
        index: fi,
      };
    }
    case 'deleteComponent': {
      const p = findPage(m, o.pageId, i);
      const idx = findSection(p, o.sectionId, i);
      const [s] = p.sections.splice(idx, 1);
      return { op: 'insertComponent', pageId: o.pageId, section: s!, index: idx };
    }
    case 'setTokens': {
      const prevTokens: Partial<Tokens> = {};
      for (const [k, v] of Object.entries(o.tokens ?? {})) {
        (prevTokens as Record<string, unknown>)[k] = (
          m.tokens as unknown as Record<string, unknown>
        )[k];
        (m.tokens as unknown as Record<string, unknown>)[k] = v;
      }
      let prevColors: Record<string, string | null> | undefined;
      if (o.colors) {
        m.brand.colors ??= {};
        prevColors = mergeNullable(m.brand.colors as Record<string, unknown>, o.colors) as Record<
          string,
          string | null
        >;
        if (Object.keys(m.brand.colors).length === 0) delete m.brand.colors;
      }
      return {
        op: 'setTokens',
        ...(o.tokens ? { tokens: prevTokens } : {}),
        ...(prevColors ? { colors: prevColors } : {}),
      };
    }
    case 'setText': {
      let holder: Localized;
      let target = o.target;
      if (target === 'section' || (target === undefined && o.sectionId)) {
        if (!o.pageId || !o.sectionId || !o.prop)
          throw new OpInvalid(i, 'a section text needs pageId, sectionId and prop');
        const p = findPage(m, o.pageId, i);
        const s = p.sections[findSection(p, o.sectionId, i)]!;
        holder = TEXT_PROP_SECTION(s, o.prop);
        const prev = holder[o.locale] ?? null;
        if (o.value === null) delete holder[o.locale];
        else holder[o.locale] = o.value;
        if (Object.keys(holder).length === 0) delete s.props[o.prop];
        else s.props[o.prop] = holder;
        return {
          op: 'setText',
          target: 'section',
          pageId: o.pageId,
          sectionId: o.sectionId,
          prop: o.prop,
          locale: o.locale,
          value: prev,
        };
      }
      target ??= 'pageTitle';
      if (target === 'brandName') holder = m.brand.name;
      else if (target === 'siteTitle') holder = m.seo.siteTitle;
      else if (target === 'siteDescription') holder = m.seo.description;
      else if (target === 'footerText') holder = m.footer.text;
      else {
        if (!o.pageId) throw new OpInvalid(i, 'pageTitle needs pageId');
        holder = findPage(m, o.pageId, i).title;
      }
      const prev = holder[o.locale] ?? null;
      if (o.value === null) delete holder[o.locale];
      else holder[o.locale] = o.value;
      return {
        op: 'setText',
        target,
        ...(o.pageId ? { pageId: o.pageId } : {}),
        locale: o.locale,
        value: prev,
      };
    }
    case 'addPage': {
      if (m.pages.some((p) => p.id === o.page.id))
        throw new OpInvalid(i, `page ${o.page.id} already exists`);
      const idx = Math.min(o.index ?? m.pages.length, m.pages.length);
      m.pages.splice(idx, 0, clone(o.page));
      if (o.nav) m.nav.items.push({ pageId: o.page.id });
      for (const r of o.restoreNav ?? [])
        m.nav.items.splice(Math.min(r.index, m.nav.items.length), 0, clone(r.item));
      for (const r of o.restoreFooter ?? []) {
        m.footer.links ??= [];
        m.footer.links.splice(Math.min(r.index, m.footer.links.length), 0, clone(r.item));
      }
      return { op: 'deletePage', pageId: o.page.id };
    }
    case 'deletePage': {
      const idx = m.pages.findIndex((p) => p.id === o.pageId);
      if (idx < 0) throw new OpInvalid(i, `unknown page ${o.pageId}`);
      if (m.pages[idx]!.slug === 'home') throw new OpInvalid(i, 'the home page cannot be deleted');
      const [page] = m.pages.splice(idx, 1);
      const restoreNav: { index: number; item: SiteModel['nav']['items'][number] }[] = [];
      m.nav.items.forEach((it, k) => {
        if (it.pageId === o.pageId) restoreNav.push({ index: k, item: it });
      });
      m.nav.items = m.nav.items.filter((it) => it.pageId !== o.pageId);
      const restoreFooter: {
        index: number;
        item: NonNullable<SiteModel['footer']['links']>[number];
      }[] = [];
      (m.footer.links ?? []).forEach((it, k) => {
        if (it.pageId === o.pageId) restoreFooter.push({ index: k, item: it });
      });
      if (m.footer.links) m.footer.links = m.footer.links.filter((it) => it.pageId !== o.pageId);
      // links from other pages to the deleted page are not silently repaired: the validation below refuses the op set and names them
      return { op: 'addPage', page: page!, index: idx, restoreNav, restoreFooter };
    }
    case 'updatePage': {
      const p = findPage(m, o.pageId, i);
      const prev: Extract<Op, { op: 'updatePage' }> = { op: 'updatePage', pageId: o.pageId };
      if (o.slug !== undefined) {
        if (p.slug === 'home' && o.slug !== 'home')
          throw new OpInvalid(i, 'the home page keeps the slug "home"');
        prev.slug = p.slug;
        p.slug = o.slug;
      }
      if (o.seo !== undefined) {
        prev.seo = p.seo ? clone(p.seo) : null;
        // a REPLACE (null = no page-level SEO): exact inverse is the previous object
        const next =
          o.seo === null
            ? {}
            : Object.fromEntries(
                Object.entries(o.seo).filter(([, v]) => v !== null && v !== undefined),
              );
        if (Object.keys(next).length === 0) delete p.seo;
        else p.seo = next as Page['seo'];
      }
      return prev;
    }
    case 'setSeo': {
      const prev: Extract<Op, { op: 'setSeo' }>['seo'] = {};
      const s = m.seo as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(o.seo)) {
        (prev as Record<string, unknown>)[k] = k in s ? clone(s[k]) : null;
        if (v === null) delete s[k];
        else s[k] = clone(v);
      }
      return { op: 'setSeo', seo: prev };
    }
    case 'setNav': {
      const prev = clone(m.nav.items);
      m.nav.items = clone(o.items);
      return { op: 'setNav', items: prev };
    }
    case 'addAsset': {
      if (m.assets.some((a) => a.id === o.asset.id))
        throw new OpInvalid(i, `asset ${o.asset.id} already exists`);
      m.assets.splice(Math.min(o.index ?? m.assets.length, m.assets.length), 0, clone(o.asset));
      return { op: 'removeAsset', assetId: o.asset.id };
    }
    case 'removeAsset': {
      const idx = m.assets.findIndex((a) => a.id === o.assetId);
      if (idx < 0) throw new OpInvalid(i, `unknown asset ${o.assetId}`);
      const [a] = m.assets.splice(idx, 1);
      return { op: 'addAsset', asset: a!, index: idx };
    }
  }
}

/**
 * Apply an op set to a model. The returned `inverse` undoes it exactly (`applyOps(result.model, result.inverse).model` deep-equals the input; the inverse of the inverse
 * redoes). Throws `OpInvalid` for a malformed or illegal op and for an op set whose RESULT is not a valid site model (the issues are attached).
 */
export function applyOps(base: SiteModel, ops: unknown): ApplyResult {
  validateOps(ops);
  const m = clone(base);
  const inverse: Op[] = [];
  ops.forEach((o, i) => inverse.unshift(applyOne(m, o, i)));
  const issues = validateSiteModel(m);
  if (issues.length > 0)
    throw new OpInvalid(
      -1,
      `the result is not a valid site model (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      issues.slice(0, 20),
    );
  const diff = diffModels(base, m);
  const risks = risksOf(base, m, ops, diff);
  return {
    model: m,
    inverse,
    diff,
    risks,
    lowRisk: risks.length === 0 && ops.every((o) => LOW_RISK.has(o.op)),
  };
}
