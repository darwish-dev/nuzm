import type { IconName } from './icons';

/**
 * The two-level navigation model shared by the customer and the admin console. The categories are data (each app defines its own);
 * which of them, and which items, a member sees depends only on permissions, feature flags and the organization type, so it is pure
 * and unit-tested without a browser. `L` is the app's message-key type, `C` its category ids.
 */
export interface NavItem<L extends string = string> {
  id: string;
  label: L;
  /** Path without the locale prefix. A group (children) has none. */
  href?: string;
  /** Any one of these permissions opens it. */
  perm?: string[];
  flag?: string;
  orgType?: string;
  /** The page itself only (the overview), not everything below the path. */
  exact?: boolean;
  /** Other paths that belong to this item (the old routes and detail pages of screens stacked on its page). */
  also?: string[];
  children?: NavItem<L>[];
}
export interface NavGroup<L extends string = string> {
  id: string;
  title?: L;
  items: NavItem<L>[];
}
export interface NavCategory<L extends string = string, C extends string = string> {
  id: C;
  icon: IconName;
  label: L;
  title: L;
  /** Paths (without locale) that belong to this category even when no item matches them (checkout, quotes, ...). */
  roots: string[];
  groups: NavGroup<L>[];
  /** Needs a current organization (customer console only). */
  org: boolean;
  /** Reached from the account menu instead of the rail; its pages show no section tabs. */
  menu?: boolean;
  /** Its pages link to each other themselves (buttons, back links), so they show no section tabs. */
  noTabs?: boolean;
  /** Not drawn on the rail (reached from elsewhere, e.g. a top-bar link); its pages still show their section tabs. */
  noRail?: boolean;
}

export interface NavContext {
  can: (permission: string) => boolean;
  /** True when the organization's feature flag is on. */
  flag: (key: string) => boolean;
  hasOrg: boolean;
  orgType?: string;
}

export interface ResolvedItem<L extends string = string> {
  id: string;
  label: L;
  /** Full path without the locale prefix; absent for a group. */
  href?: string;
  exact?: boolean;
  also?: string[];
  children?: ResolvedItem<L>[];
}
export interface ResolvedGroup<L extends string = string> {
  id: string;
  title?: L;
  items: ResolvedItem<L>[];
}
export interface ResolvedCategory<L extends string = string, C extends string = string> {
  id: C;
  icon: IconName;
  label: L;
  title: L;
  roots: string[];
  /** Where clicking the category's icon goes: its first visible page. */
  home: string;
  groups: ResolvedGroup<L>[];
  menu?: boolean;
  noTabs?: boolean;
  noRail?: boolean;
}

function visible<L extends string>(i: NavItem<L>, c: NavContext): boolean {
  if (i.orgType && c.orgType !== i.orgType) return false;
  if (i.flag && !c.flag(i.flag)) return false;
  if (i.perm && !i.perm.some(c.can)) return false;
  return true;
}

function resolveItem<L extends string>(i: NavItem<L>, c: NavContext): ResolvedItem<L> | null {
  if (i.children) {
    const kids = i.children.map((k) => resolveItem(k, c)).filter((k): k is ResolvedItem<L> => !!k);
    if (kids.length === 0) return null;
    return { id: i.id, label: i.label, children: kids };
  }
  if (!visible(i, c)) return null;
  return {
    id: i.id,
    label: i.label,
    href: i.href,
    exact: i.exact,
    ...(i.also ? { also: i.also } : {}),
  };
}

const firstHref = <L extends string>(items: ResolvedItem<L>[]): string | undefined => {
  for (const i of items) {
    const h = i.href ?? (i.children ? firstHref(i.children) : undefined);
    if (h) return h;
  }
  return undefined;
};

/** The categories this member may use, each with the items it shows. A category with nothing to show is left out. */
export function buildNavFrom<L extends string, C extends string>(
  categories: NavCategory<L, C>[],
  c: NavContext,
): ResolvedCategory<L, C>[] {
  const out: ResolvedCategory<L, C>[] = [];
  for (const cat of categories) {
    if (cat.org && !c.hasOrg) continue;
    const groups = cat.groups
      .map((g) => ({
        id: g.id,
        title: g.title,
        items: g.items.map((i) => resolveItem(i, c)).filter((i): i is ResolvedItem<L> => !!i),
      }))
      .filter((g) => g.items.length > 0);
    const home = firstHref(groups.flatMap((g) => g.items));
    if (!home) continue;
    out.push({
      id: cat.id,
      icon: cat.icon,
      label: cat.label,
      title: cat.title,
      roots: cat.roots,
      home,
      groups,
      ...(cat.menu ? { menu: true } : {}),
      ...(cat.noTabs ? { noTabs: true } : {}),
      ...(cat.noRail ? { noRail: true } : {}),
    });
  }
  return out;
}

const within = (path: string, base: string) =>
  base === '/' ? path === '/' : path === base || path.startsWith(`${base}/`);

/** `/en/billing/x` → `/billing/x`; `/en` → `/`. */
export function stripLocale(pathname: string, locale: string): string {
  const p = pathname.replace(/[?#].*$/, '').replace(/\/+$/, '');
  // the client console has no language in its address: `/console` is its home (the admin console still prefixes `/<locale>`)
  if (p === `/${locale}` || p === `/${locale}/console` || p === '/console' || p === '') return '/';
  return p.startsWith(`/${locale}/`) ? p.slice(locale.length + 1) : p;
}

function leaves<L extends string, C extends string>(
  cat: ResolvedCategory<L, C>,
): ResolvedItem<L>[] {
  const all: ResolvedItem<L>[] = [];
  const walk = (xs: ResolvedItem<L>[]) =>
    xs.forEach((x) => (x.children ? walk(x.children) : all.push(x)));
  walk(cat.groups.flatMap((g) => g.items));
  return all;
}

/** The page's item inside a category: the longest matching path (an `exact` item matches only itself). */
export function currentItemId<L extends string, C extends string>(
  cat: ResolvedCategory<L, C>,
  path: string,
): string | null {
  let best: { id: string; len: number } | null = null;
  for (const l of leaves(cat)) {
    if (!l.href) continue;
    const ok = l.exact ? path === l.href : within(path, l.href);
    if (ok && (!best || l.href.length > best.len)) best = { id: l.id, len: l.href.length };
    for (const a of l.also ?? [])
      if (within(path, a) && (!best || a.length > best.len)) best = { id: l.id, len: a.length };
  }
  return best?.id ?? null;
}

/** Which category the page belongs to: the item with the longest match wins, then the category roots, else `fallback`. */
export function currentCategoryOf<L extends string, C extends string>(
  cats: ResolvedCategory<L, C>[],
  path: string,
  fallback: C,
): C {
  let best: { id: C; len: number } | null = null;
  for (const cat of cats)
    for (const l of leaves(cat)) {
      if (!l.href || l.href === '/') continue;
      for (const h of [l.href, ...(l.also ?? [])])
        if (within(path, h) && (!best || h.length > best.len)) best = { id: cat.id, len: h.length };
    }
  if (best) return best.id;
  for (const cat of cats)
    for (const r of cat.roots)
      if (within(path, r) && (!best || r.length > best.len)) best = { id: cat.id, len: r.length };
  return best?.id ?? fallback;
}
