import { Sha256 } from './sha256';

/**
 * Resumable upload of one library package (SCR-K-01). Framework-free so it can be tested without a browser:
 *  1. check the file name and size like the server will;
 *  2. hash the whole file in 8 MiB steps (and, in the same pass, each part), because the session is opened with the checksum;
 *  3. open a session, or resume the one remembered for this exact file (name, size, modified time, checksum) if the server still has it open;
 *  4. send the missing parts, each with its own SHA-256, retrying a part a few times on a network error or a 5xx;
 *  5. complete with the part list and the metadata. The server verifies everything again.
 * Cancelling aborts the request in flight and asks the server to discard the session.
 */
export const PART_HINT = 8 * 1024 * 1024;
export const MAX_BYTES = 2 * 1024 ** 3;
export const ACCEPTED_SUFFIXES = [
  '.zip',
  '.tar.gz',
  '.tgz',
  '.md',
  '.markdown',
  '.txt',
  '.pdf',
  '.docx',
  '.json',
  '.yaml',
  '.yml',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
];

export type UploadErrorCode =
  'type' | 'size' | 'forbidden' | 'network' | 'mismatch' | 'aborted' | 'generic';
export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    readonly status?: number,
  ) {
    super(code);
  }
}

export type UploadProgress =
  | { phase: 'hashing'; percent: number }
  | { phase: 'sending'; done: number; total: number; resumed: number }
  | { phase: 'completing' };

export interface UploadMetadata {
  name: string;
  resourceType: string;
  platform?: string;
  description?: string;
  category?: string;
  license?: string;
  frameworks: string[];
  languages: string[];
  tags: string[];
}
export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}
export interface UploadDeps {
  fetch: typeof fetch;
  csrf: () => string | undefined;
  store?: KeyValueStore;
  /** wait between retries (a test passes an instant one) */
  sleep?: (ms: number) => Promise<void>;
}
interface Session {
  id: string;
  state: string;
  partSize: number;
  partsReceived: number[];
}

export function checkFile(file: { name: string; size: number }): void {
  const lower = file.name.toLowerCase();
  if (
    !ACCEPTED_SUFFIXES.some((s) => lower.endsWith(s)) ||
    /[\\/]/.test(file.name) ||
    file.name.startsWith('.')
  )
    throw new UploadError('type');
  if (file.size < 1 || file.size > MAX_BYTES) throw new UploadError('size');
}

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const fingerprint = (f: File, sha: string) => `${f.name}:${f.size}:${f.lastModified}:${sha}`;
const STORE_KEY = 'nuzm.knowledge.upload';

/** Whole-file checksum and the checksum of every part of size `hint` (default `PART_HINT`), in one pass over the file. */
export async function hashFile(
  file: Blob,
  onPercent: (p: number) => void,
  signal?: AbortSignal,
  hint: number = PART_HINT,
) {
  const whole = new Sha256();
  const parts: string[] = [];
  for (let off = 0; off < file.size; off += hint) {
    if (signal?.aborted) throw new UploadError('aborted');
    const chunk = await bytesOf(file.slice(off, off + hint));
    whole.update(chunk);
    parts.push(new Sha256().update(chunk).digestHex());
    onPercent(Math.min(100, Math.round(((off + chunk.length) / file.size) * 100)));
  }
  return { sha256: whole.digestHex(), parts };
}

export async function runUpload(opts: {
  file: File;
  metadata: UploadMetadata;
  resourceId?: string;
  deps: UploadDeps;
  onProgress: (p: UploadProgress) => void;
  signal?: AbortSignal;
  /** called as soon as a session exists, so a Cancel button can discard it */
  onSession?: (id: string) => void;
  /** The part size the file is pre-hashed in (default `PART_HINT`, what the server asks for). Only tests pass another, so they need not hash megabytes with the pure-JS SHA-256. */
  hintPartSize?: number;
}): Promise<{ resourceId: string }> {
  const { file, metadata, deps, onProgress, signal } = opts;
  const hint = opts.hintPartSize ?? PART_HINT;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  checkFile(file);
  const base = '/v1/admin/knowledge/uploads';
  const headers = (extra: Record<string, string> = {}) => ({
    'x-csrf-token': deps.csrf() ?? '',
    ...extra,
  });
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await deps.fetch(url, { credentials: 'same-origin', signal, ...init });
    } catch (e) {
      if (signal?.aborted || (e as Error).name === 'AbortError') throw new UploadError('aborted');
      throw new UploadError('network');
    }
  };
  const fail = (r: Response): never => {
    if (r.status === 403) throw new UploadError('forbidden', 403);
    if (r.status === 422) throw new UploadError('type', 422);
    throw new UploadError('generic', r.status);
  };

  onProgress({ phase: 'hashing', percent: 0 });
  const { sha256, parts: hintShas } = await hashFile(
    file,
    (percent) => onProgress({ phase: 'hashing', percent }),
    signal,
    hint,
  );

  // resume the session remembered for this exact file, if the server still has it open
  let session: Session | null = null;
  let resumed = 0;
  const fp = fingerprint(file, sha256);
  const saved = (() => {
    try {
      return JSON.parse(deps.store?.getItem(STORE_KEY) ?? 'null') as {
        fp: string;
        id: string;
      } | null;
    } catch {
      return null;
    }
  })();
  if (saved && saved.fp === fp) {
    const r = await send(`${base}/${saved.id}`, { method: 'GET', headers: headers() });
    if (r.ok) {
      const s = (await r.json()) as Session;
      if (s.state === 'OPEN') {
        session = s;
        resumed = s.partsReceived.length;
      }
    }
  }
  if (!session) {
    const r = await send(base, {
      method: 'POST',
      headers: headers({
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      }),
      body: JSON.stringify({
        name: metadata.name,
        resourceType: metadata.resourceType,
        declaredBytes: file.size,
        sha256,
        filename: file.name,
        ...(opts.resourceId ? { resourceId: opts.resourceId } : {}),
      }),
    });
    if (!r.ok) fail(r);
    session = (await r.json()) as Session;
  }
  deps.store?.setItem(STORE_KEY, JSON.stringify({ fp, id: session.id }));
  opts.onSession?.(session.id);

  const size = session.partSize;
  const total = Math.ceil(file.size / size);
  const partShas: string[] = [];
  for (let n = 1; n <= total; n++) {
    if (signal?.aborted) throw new UploadError('aborted');
    const chunk = file.slice((n - 1) * size, n * size);
    const have = session.partsReceived.includes(n);
    const partSha =
      size === hint ? hintShas[n - 1]! : new Sha256().update(await bytesOf(chunk)).digestHex();
    partShas.push(partSha);
    onProgress({ phase: 'sending', done: n - 1, total, resumed });
    if (have) continue;
    for (let attempt = 0; ; attempt++) {
      let r: Response | null = null;
      try {
        r = await send(`${base}/${session.id}/parts/${n}`, {
          method: 'PUT',
          headers: headers({
            'content-type': 'application/octet-stream',
            'x-part-sha256': partSha,
          }),
          body: chunk,
        });
      } catch (e) {
        if (!(e instanceof UploadError) || e.code !== 'network' || attempt >= 2) throw e;
      }
      if (r?.ok) break;
      if (r && r.status < 500) fail(r);
      if (attempt >= 2) throw new UploadError('network', r?.status);
      await sleep(500 * 2 ** attempt);
    }
  }
  onProgress({ phase: 'sending', done: total, total, resumed });
  onProgress({ phase: 'completing' });
  const r = await send(`${base}/${session.id}/completion`, {
    method: 'POST',
    headers: headers({
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    }),
    body: JSON.stringify({
      parts: partShas.map((s, i) => ({ partNumber: i + 1, sha256: s })),
      ...(opts.resourceId ? { resourceId: opts.resourceId } : {}),
      metadata: {
        ...metadata,
        frameworks: metadata.frameworks,
        languages: metadata.languages,
        tags: metadata.tags,
      },
    }),
  });
  if (r.status === 409) throw new UploadError('mismatch', 409);
  if (!r.ok) fail(r);
  deps.store?.removeItem(STORE_KEY);
  return { resourceId: ((await r.json()) as { id: string }).id };
}

/** Asks the server to discard a session (parts and all) and forgets it locally. Harmless if it is already gone. */
export async function cancelUpload(id: string, deps: UploadDeps): Promise<void> {
  try {
    await deps.fetch(`/v1/admin/knowledge/uploads/${id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': deps.csrf() ?? '' },
    });
  } finally {
    deps.store?.removeItem(STORE_KEY);
  }
}
