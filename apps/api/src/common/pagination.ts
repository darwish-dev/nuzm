export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLimit(raw: unknown, def = 50): number {
  const n = raw === undefined ? def : Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), 200) : def;
}

/** Cursor = base64url of the last item's UUIDv7 (ids sort by creation time, newest first). */
export function decodeCursor(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const id = Buffer.from(raw, 'base64url').toString('utf8');
  return UUID.test(id) ? id : null;
}

export function pageOf<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor:
      rows.length > limit ? Buffer.from(items[items.length - 1]!.id).toString('base64url') : null,
  };
}

/** Keyset cursor for time-ordered lists: base64url of `<ISO time>|<uuid>`. */
export const encodeTimeCursor = (t: Date, id: string) =>
  Buffer.from(`${t.toISOString()}|${id}`).toString('base64url');
export function decodeTimeCursor(raw: unknown): { t: string; id: string } | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const [t, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  return t && id && !Number.isNaN(Date.parse(t)) && UUID.test(id) ? { t, id } : null;
}
