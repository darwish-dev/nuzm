/**
 * Load a built static application from a directory as a deployable `Artifact` (Phase 2, Session 06). Read-only, bounded and symlink-free: a link, a device, a path outside the
 * directory or an oversize tree is REFUSED, never followed or truncated. The hash is the same `artifactHash` the deploy pipeline binds approvals and releases to.
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { artifactHash, type Artifact } from './ports';

export const MAX_FILES = 2000;
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain',
  xml: 'application/xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  map: 'application/json',
};

export class ArtifactDirRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactDirRefused';
  }
}

export function loadArtifactFromDir(dir: string): Artifact {
  const root = resolve(dir);
  const top = lstatSync(root, { throwIfNoEntry: false });
  if (!top || !top.isDirectory())
    throw new ArtifactDirRefused('the application directory does not exist or is not a directory');
  const files: Artifact['files'] = [];
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink())
        throw new ArtifactDirRefused(`a symbolic link is not allowed: ${relative(root, p)}`);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!st.isFile()) throw new ArtifactDirRefused(`not a regular file: ${relative(root, p)}`);
      const rel = relative(root, p).split(sep).join('/');
      if (rel.startsWith('..') || rel.includes('\0'))
        throw new ArtifactDirRefused('path outside the application directory');
      if (rel.split('/').some((s) => s === '.env' || s.startsWith('.env.') || s === '.git'))
        throw new ArtifactDirRefused(`refused (secrets or VCS data must not be deployed): ${rel}`);
      total += st.size;
      if (files.length + 1 > MAX_FILES)
        throw new ArtifactDirRefused(`more than ${MAX_FILES} files`);
      if (total > MAX_TOTAL_BYTES)
        throw new ArtifactDirRefused('the application exceeds the size limit');
      const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.') + 1).toLowerCase() : '';
      files.push({
        path: rel,
        mime: MIME[ext] ?? 'application/octet-stream',
        content: new Uint8Array(readFileSync(p)),
      });
    }
  };
  walk(root);
  if (!files.length) throw new ArtifactDirRefused('the application directory is empty');
  return { hash: artifactHash(files), files };
}
