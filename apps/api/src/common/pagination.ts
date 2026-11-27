import { UUID } from '@nuzm/domain';
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

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

/**
 * SQL for a timestamptz column as UTC text with FULL microsecond precision (`2026-11-27T10:00:00.123456Z`), for keyset cursors. A JavaScript
 * `Date` keeps only milliseconds while Postgres stores microseconds: a cursor built from a `Date` rounds the page boundary down, so a row in the
 * same millisecond just after the boundary (`.598300` after `.598700`) fails `(t, id) < (cursor)` and is never listed. Select this alongside
 * the row (`${cursorTimeSql('s.created_at')} AS cursor_t`) and pass it to `encodeTimeCursor`.
 */
export const cursorTimeSql = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** `2026-11-27T10:00:00Z`, with up to 6 fractional digits (older cursors carry 3). */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** Keyset cursor for time-ordered lists: base64url of `<UTC time, microseconds>|<uuid>`. `t` must come from {@link cursorTimeSql}. */
export const encodeTimeCursor = (t: string, id: string) =>
  Buffer.from(`${t}|${id}`).toString('base64url');
export function decodeTimeCursor(raw: unknown): { t: string; id: string } | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const [t, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  return t && id && CURSOR_TIME.test(t) && !Number.isNaN(Date.parse(t)) && UUID.test(id)
    ? { t, id }
    : null;
}
