/** Open-redirect defence: only same-site relative paths or explicitly allow-listed origins. */
export function safeReturnTo(
  raw: string | undefined,
  allowedOrigins: string[],
  fallback: string,
): string | null {
  if (raw === undefined || raw === '') return fallback;
  // Control characters and backslashes are rejected on purpose (header injection / browser path quirks).
  // eslint-disable-next-line no-control-regex
  if (raw.length > 2048 || /[\u0000-\u001f\\]/.test(raw)) return null;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    const u = new URL(raw);
    return allowedOrigins.includes(u.origin) ? u.toString() : null;
  } catch {
    return null;
  }
}
