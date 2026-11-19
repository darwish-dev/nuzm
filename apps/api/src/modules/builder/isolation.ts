import type { FastifyInstance } from 'fastify';

/**
 * Preview isolation at the HTTP edge of the API process (ADR-021). On the PREVIEW host (`*.<previewDomain>`) nothing but `/_preview/…` exists: every other path, including
 * `/v1/…`, is a plain 404, and any cookie the browser may have sent is dropped before routing. On every OTHER host `/_preview/…` is a 404 too. So the preview origin can
 * never reach the API, and the API origin never serves site content.
 */
export function installPreviewIsolation(
  fastify: FastifyInstance,
  domain = process.env.BUILDER_PREVIEW_DOMAIN ?? 'preview.nuzm-preview.test',
) {
  const suffix = `.${domain.toLowerCase()}`;
  fastify.addHook('onRequest', async (req, reply) => {
    const host = String(req.headers.host ?? '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    const onPreview = host.endsWith(suffix);
    const path = req.url.split('?')[0] ?? '';
    if (onPreview) {
      delete req.headers.cookie;
      delete req.headers.authorization;
      if (!path.startsWith('/_preview/'))
        return reply.code(404).type('text/plain').send('not found');
    } else if (path.startsWith('/_preview/'))
      return reply.code(404).type('text/plain').send('not found');
    return undefined;
  });
}

/**
 * The edge stand-in of the DEV stack. In a real deployment an edge proxy maps the preview host's paths to `/_preview/<token>/...`; a local stack has none, so the dev
 * stack calls this from Fastify's `rewriteUrl`. Only a host that is exactly `<32-character token>.<domain>` is rewritten, and only to the preview path: nothing else
 * ever changes (the isolation hook above still decides what the preview host may reach).
 */
export function rewritePreviewUrl(host: string | undefined, url: string, domain: string): string {
  const suffix = `.${domain.toLowerCase()}`;
  const h = String(host ?? '')
    .toLowerCase()
    .replace(/:\d+$/, '');
  if (!h.endsWith(suffix)) return url;
  const token = h.slice(0, -suffix.length);
  if (!/^[a-z2-7]{32}$/.test(token) || url.startsWith('/_preview/')) return url;
  return `/_preview/${token}${url.startsWith('/') ? url : `/${url}`}`;
}
