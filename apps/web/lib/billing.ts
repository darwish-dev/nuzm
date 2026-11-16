/** Pure helpers for the billing screens (no I/O): money input, decimal display, CSV export safety. */

/**
 * Major-unit input ("1000", "1000.5", "١٠٠٠" is NOT accepted) → integer minor-unit string, or null when invalid.
 * String arithmetic only: no floating point ever touches money. Positive amounts, at most `digits` decimals, 18 digits.
 */
export function toMinor(input: string, digits = 2): string | null {
  const m = new RegExp(`^(\\d{1,16})(?:\\.(\\d{1,${digits}}))?$`).exec(input.trim());
  if (!m) return null;
  const minor = `${m[1]}${(m[2] ?? '').padEnd(digits, '0')}`.replace(/^0+(?=\d)/, '');
  return /^[1-9]\d*$/.test(minor) ? minor : null;
}

/** Minor-unit integer string → major-unit input text ("115" → "1.15"); the inverse of `toMinor`. */
export function fromMinor(minor: string, digits = 2): string {
  const s = minor.padStart(digits + 1, '0');
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`.replace(/\.?0+$/, '') || '0';
}

/** "2.00000000" → "2", "0.50000000" → "0.5" (display only; the value stays a string). */
export function trimDec(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
}

/**
 * One CSV cell. Spreadsheet formula injection: a cell that starts with = + - @ or a control character is prefixed with an
 * apostrophe so Excel/Sheets treat it as text; cells with separators or quotes are quoted.
 */
export function csvCell(v: string): string {
  let c = v;
  if (/^[=+\-@\t\r]/.test(c)) c = `'${c}`;
  return /[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
}
export const toCsv = (rows: string[][]): string =>
  rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
