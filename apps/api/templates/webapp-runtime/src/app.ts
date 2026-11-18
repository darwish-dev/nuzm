import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRouter } from './engine.ts';
import { listen } from './http.ts';
import type { AppResponse, Router } from './http.ts';
import { MemoryStore } from './memory-store.ts';
import { META } from './meta.ts';
import { HttpNotifier, LogNotifier } from './notify.ts';
import { createPool, PgStore } from './pg-store.ts';
import type { Config } from './config.ts';
import type { Notifier, Store } from './types.ts';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function createApp(cfg: Config, overrides: { store?: Store; notifier?: Notifier } = {}): { router: Router; store: Store } {
  const store = overrides.store ?? (cfg.store === 'memory' ? new MemoryStore(META) : new PgStore(createPool(cfg.databaseUrl as string), META));
  const notifier = overrides.notifier ?? (cfg.notifyUrl && cfg.notifyToken ? new HttpNotifier(cfg.notifyUrl, cfg.notifyToken) : new LogNotifier());
  return { router: buildRouter({ meta: META, store, notifier, sessionSecret: cfg.sessionSecret }), store };
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
async function staticFile(path: string): Promise<AppResponse | null> {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^[/\\]+/, '');
  if (rel.split(sep).includes('..')) return null;
  try {
    const bytes = await readFile(join(publicDir, rel));
    return { status: 200, bytes: new Uint8Array(bytes), contentType: TYPES[extname(rel)] ?? 'application/octet-stream' };
  } catch {
    const index = await readFile(join(publicDir, 'index.html')).catch(() => null); // single-page app fallback
    return index ? { status: 200, bytes: new Uint8Array(index), contentType: TYPES['.html'] as string } : null;
  }
}

export function start(cfg: Config) {
  const { router } = createApp(cfg);
  return listen(router, cfg.port, staticFile, META.basePath);
}
