import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { desktopFile, desktopUrl, type DesktopPlatform } from '../../../lib/desktop-downloads';

/**
 * `/download/mac` and `/download/windows`: the Nuzm AI desktop installers. A configured public address wins (a 302 to it); otherwise the newest
 * installer in the server's downloads folder is streamed as an attachment; otherwise 404 (nothing is invented). See lib/desktop-downloads.ts.
 */
const TYPE: Record<DesktopPlatform, string> = {
  mac: 'application/x-apple-diskimage',
  windows: 'application/vnd.microsoft.portable-executable',
};
const isPlatform = (p: string): p is DesktopPlatform => p === 'mac' || p === 'windows';

/** `attachment` with an ASCII fallback name and the exact UTF-8 name (RFC 6266). */
const disposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

async function serve(platform: string, head: boolean): Promise<Response> {
  if (!isPlatform(platform)) return new Response('Not found', { status: 404 });
  const url = desktopUrl(platform);
  if (url) return Response.redirect(url, 302);
  const file = await desktopFile(platform);
  if (!file) return new Response('Not found', { status: 404 });
  const headers = {
    'content-type': TYPE[platform],
    'content-length': String(file.size),
    'content-disposition': disposition(file.name),
    'cache-control': 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  };
  if (head) return new Response(null, { status: 200, headers });
  const body = Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream;
  return new Response(body, { status: 200, headers });
}

export async function GET(_req: Request, { params }: { params: Promise<{ platform: string }> }) {
  return serve((await params).platform, false);
}
export async function HEAD(_req: Request, { params }: { params: Promise<{ platform: string }> }) {
  return serve((await params).platform, true);
}
