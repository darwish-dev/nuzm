import { describe, expect, it } from 'vitest';
import { loadBuilderConfig, previewUrl } from './internal/model';
import { rewritePreviewUrl } from './isolation';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz234567';

describe('preview address and the dev edge', () => {
  it('the framed address has no port in production and one in development', () => {
    expect(previewUrl(TOKEN, 'ar', loadBuilderConfig({}))).toBe(
      `https://${TOKEN}.preview.nuzm-preview.test/ar/`,
    );
    const dev = loadBuilderConfig({
      BUILDER_PREVIEW_DOMAIN: 'preview.localhost',
      BUILDER_PREVIEW_SCHEME: 'http',
      BUILDER_PREVIEW_PORT: '4000',
    });
    expect(previewUrl(TOKEN, 'en', dev)).toBe(`http://${TOKEN}.preview.localhost:4000/en/`);
    // anything that is not a plain port is ignored
    expect(loadBuilderConfig({ BUILDER_PREVIEW_PORT: '80/x' }).previewPort).toBe('');
  });
  it('the dev edge maps a preview host path to /_preview/<token>/..., and nothing else', () => {
    const d = 'preview.localhost';
    expect(rewritePreviewUrl(`${TOKEN}.${d}:4000`, '/ar/', d)).toBe(`/_preview/${TOKEN}/ar/`);
    expect(rewritePreviewUrl(`${TOKEN}.${d}`, '/ar/site.css?v=1', d)).toBe(
      `/_preview/${TOKEN}/ar/site.css?v=1`,
    );
    // already a preview path: unchanged
    expect(rewritePreviewUrl(`${TOKEN}.${d}`, `/_preview/${TOKEN}/ar/`, d)).toBe(
      `/_preview/${TOKEN}/ar/`,
    );
    // the API host, a malformed token, another domain and a missing host are never rewritten
    expect(rewritePreviewUrl('127.0.0.1:4000', '/v1/me', d)).toBe('/v1/me');
    expect(rewritePreviewUrl(`short.${d}`, '/v1/me', d)).toBe('/v1/me');
    expect(rewritePreviewUrl(`${TOKEN}.evil.example`, '/ar/', d)).toBe('/ar/');
    expect(rewritePreviewUrl(undefined, '/ar/', d)).toBe('/ar/');
  });
});
