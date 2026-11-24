import { ProblemException } from '../../../../common/errors';
import type { SftpAttrs, SftpSession } from './sftp';

/**
 * Path containment of the file manager. EVERY action goes through `guard`, which proves, on the live SFTP session, that the target is inside the site's web root:
 *  - the request's path is relative, has no `..`, no control characters and no backslash;
 *  - the web root itself resolves (realpath) to a place inside the account's home;
 *  - every component from the root down is looked at WITHOUT following links (lstat): a symbolic link anywhere on the path is refused, so a link planted inside the site
 *    cannot lead a read, write or delete outside it (the only link action allowed is removing the link itself);
 *  - the final real path must equal the path walked.
 * This is defence in depth over the account's own operating-system permissions (and the SFTP jail, when the node has one): a check made over the network cannot be atomic with
 * the operation that follows it, so the node's own isolation remains the boundary that matters. NOT VERIFIED on a real node.
 */
export const MAX_PATH = 1024;
const SEGMENT = /^[^\x00-\x1f\x7f/\\]{1,255}$/; // eslint-disable-line no-control-regex

const refuse = (detail: string) => new ProblemException('validation_failed', detail);

/** Splits a request path into safe segments; `""` and `"/"` are the root. */
export function cleanRelative(rel: string | undefined): string[] {
  const raw = rel ?? '';
  if (raw.length > MAX_PATH) throw refuse('the path is too long');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(raw)) throw refuse('the path has characters that are not allowed');
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..') throw refuse('the path must stay inside the website folder');
    if (!SEGMENT.test(p)) throw refuse('the path has a name that is not allowed');
  }
  return parts;
}

export interface Guarded {
  /** canonical root of the website folder on the node */
  root: string;
  /** absolute path of the target on the node */
  abs: string;
  /** the segments below the root */
  parts: string[];
  /** `null` = the target does not exist (its parent does and is a directory) */
  attrs: SftpAttrs | null;
}
export interface GuardOptions {
  /** the target may be a symbolic link (only to remove the link itself); never followed */
  allowFinalLink?: boolean;
  /** the target must not be the root */
  notRoot?: boolean;
}

/** The website folder of a domain in Hestia's layout: `<home>/web/<domain>/public_html`. */
export const webRoot = (home: string, domain: string) => `${home}/web/${domain}/public_html`;

export async function guard(
  s: SftpSession,
  home: string,
  rootAbs: string,
  rel: string | undefined,
  o: GuardOptions = {},
): Promise<Guarded> {
  const parts = cleanRelative(rel);
  if (o.notRoot && parts.length === 0)
    throw refuse('the website folder itself cannot be changed here');
  let root: string;
  try {
    root = await s.realpath(rootAbs);
  } catch {
    throw new ProblemException('not_found', 'the website folder does not exist yet');
  }
  const homeReal = await s.realpath(home);
  if (!root.startsWith(`${homeReal}/`)) throw refuse('the website folder is outside the account');
  let cur = root;
  let attrs: SftpAttrs | null = await s.lstat(root);
  if (!attrs || attrs.type !== 'dir')
    throw new ProblemException('not_found', 'the website folder does not exist yet');
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    cur = `${cur}/${parts[i]}`;
    attrs = await s.lstat(cur);
    if (!attrs) {
      if (!last) throw new ProblemException('not_found', 'the folder does not exist');
      return { root, abs: cur, parts, attrs: null };
    }
    if (attrs.type === 'symlink') {
      if (last && o.allowFinalLink) return { root, abs: cur, parts, attrs };
      throw refuse('links inside the website are not followed');
    }
    if (!last && attrs.type !== 'dir')
      throw new ProblemException('not_found', 'the folder does not exist');
    if (last && attrs.type === 'other') throw refuse('this kind of file cannot be managed here');
  }
  // the walked path must be the real one (nothing on it was redirected)
  if (parts.length > 0) {
    const real = await s.realpath(cur);
    if (real !== cur) throw refuse('the path leaves the website folder');
  }
  return { root, abs: cur, parts, attrs };
}
