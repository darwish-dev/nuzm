/** Lowercase ASCII kebab slug; non-Latin names fall back to a random token so Arabic names still work. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s.length >= 2 ? s : `org-${Math.random().toString(36).slice(2, 10)}`;
}
