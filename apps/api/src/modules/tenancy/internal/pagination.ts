export { decodeCursor, pageOf, parseLimit, type Page } from '../../../common/pagination';

export const etag = (version: number) => `"${version}"`;

/** Parse `If-Match: "3"`; returns null when absent or malformed. */
export function parseIfMatch(h: string | string[] | undefined): number | null {
  const v = Array.isArray(h) ? h[0] : h;
  const m = v ? /^"?(\d+)"?$/.exec(v.trim()) : null;
  return m ? Number(m[1]) : null;
}
