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
