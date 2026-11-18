/**
 * Text safety primitives of the trusted renderer. Every piece of model-derived text goes through `esc` (text and attribute context) or
 * `jsonSafe` (JSON-LD) before it touches output; nothing model-derived is ever used as a tag name, attribute name, class name or CSS value.
 */
const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/**
 * C0/C1 control characters (except tab and newline) and the bidirectional override/embedding/isolate controls (U+202A-202E, U+2066-2069) used for
 * text-spoofing ("trojan source" style) are removed from all model text. Marks (U+200E/200F/061C) and joiners are kept: Arabic and Persian need them.
 */
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFFFE\uFFFF]/g;

export const clean = (s: string): string => s.replace(UNSAFE_CHARS, '');

/** Escape for HTML text and for double- or single-quoted attribute values (also backticks, which legacy parsers treat as quotes). */
export const esc = (s: string): string => clean(s).replace(/[&<>"'`]/g, (c) => ESC[c] as string);

/** Serialise data for an inline `application/ld+json` block: JSON.stringify, then `<`, `>`, `&`, U+2028/2029 as unicode escapes so no `</script>` can form. */
export function jsonSafe(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Recursively clean every string of a JSON-LD graph (control and bidi characters). */
export function cleanDeep<T>(v: T): T {
  if (typeof v === 'string') return clean(v) as T;
  if (Array.isArray(v)) return v.map((x) => cleanDeep(x)) as T;
  if (typeof v === 'object' && v !== null)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)])) as T;
  return v;
}

/** Deterministic digit formatting (no Intl, which varies across ICU builds). Arabic locale shows Arabic-Indic digits and separators. */
export function formatNumber(raw: string, locale: 'ar' | 'en'): string {
  const [int = '', frac] = raw.split('.');
  const sep = locale === 'ar' ? '\u066C' : ',';
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const out = frac === undefined ? grouped : `${grouped}${locale === 'ar' ? '\u066B' : '.'}${frac}`;
  return locale === 'ar'
    ? out.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)))
    : out;
}

/** Split a plain-text body into paragraphs (blank line) with single newlines as <br>; returns already-escaped HTML. */
export function paragraphs(text: string, cls = ''): string {
  const c = cls ? ` class="${cls}"` : '';
  return clean(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => `<p${c}>${p.split('\n').map(esc).join('<br>')}</p>`)
    .join('\n');
}
