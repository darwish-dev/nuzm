/**
 * Classifies a file by CONTENT (magic bytes and a text probe), never by extension alone, and applies the storage policy of the library: text and a short list of
 * passive assets are stored in the snapshot; executables, shared libraries, installers, nested archives and unknown binaries are inventoried but never stored.
 */
export type FileKind = 'text' | 'asset' | 'executable' | 'archive' | 'binary';
export interface FileClass {
  kind: FileKind;
  /** A short machine-readable label (`png`, `elf`, `pe`, `zip`, `shebang`, ...). */
  label: string;
}
const starts = (b: Buffer, ...sig: number[]) =>
  b.length >= sig.length && sig.every((v, i) => b[i] === v);
const ascii = (b: Buffer, at: number, s: string) =>
  b.length >= at + s.length && b.toString('latin1', at, at + s.length) === s;

export function classifyContent(head: Buffer): FileClass {
  if (starts(head, 0x7f, 0x45, 0x4c, 0x46)) return { kind: 'executable', label: 'elf' };
  if (starts(head, 0x4d, 0x5a)) return { kind: 'executable', label: 'pe' };
  if (
    starts(head, 0xfe, 0xed, 0xfa, 0xce) ||
    starts(head, 0xfe, 0xed, 0xfa, 0xcf) ||
    starts(head, 0xce, 0xfa, 0xed, 0xfe) ||
    starts(head, 0xcf, 0xfa, 0xed, 0xfe)
  )
    return { kind: 'executable', label: 'macho' };
  if (starts(head, 0xca, 0xfe, 0xba, 0xbe))
    return { kind: 'executable', label: 'macho-or-java-class' };
  if (ascii(head, 0, 'dex\n')) return { kind: 'executable', label: 'dex' };
  if (starts(head, 0x00, 0x61, 0x73, 0x6d)) return { kind: 'executable', label: 'wasm' };
  if (starts(head, 0x50, 0x4b, 0x03, 0x04) || starts(head, 0x50, 0x4b, 0x05, 0x06))
    return { kind: 'archive', label: 'zip' };
  if (starts(head, 0x1f, 0x8b)) return { kind: 'archive', label: 'gzip' };
  if (ascii(head, 0, 'BZh')) return { kind: 'archive', label: 'bzip2' };
  if (starts(head, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return { kind: 'archive', label: 'xz' };
  if (starts(head, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return { kind: 'archive', label: '7z' };
  if (ascii(head, 0, 'Rar!')) return { kind: 'archive', label: 'rar' };
  if (ascii(head, 257, 'ustar')) return { kind: 'archive', label: 'tar' };
  if (starts(head, 0x89, 0x50, 0x4e, 0x47)) return { kind: 'asset', label: 'png' };
  if (starts(head, 0xff, 0xd8, 0xff)) return { kind: 'asset', label: 'jpeg' };
  if (ascii(head, 0, 'GIF8')) return { kind: 'asset', label: 'gif' };
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return { kind: 'asset', label: 'webp' };
  if (starts(head, 0x00, 0x00, 0x01, 0x00)) return { kind: 'asset', label: 'ico' };
  if (ascii(head, 0, '%PDF')) return { kind: 'asset', label: 'pdf' };
  if (ascii(head, 0, 'wOFF')) return { kind: 'asset', label: 'woff' };
  if (ascii(head, 0, 'wOF2')) return { kind: 'asset', label: 'woff2' };
  if (starts(head, 0x00, 0x01, 0x00, 0x00) || ascii(head, 0, 'true'))
    return { kind: 'asset', label: 'ttf' };
  if (ascii(head, 0, 'OTTO')) return { kind: 'asset', label: 'otf' };
  if (isText(head)) return { kind: 'text', label: ascii(head, 0, '#!') ? 'shebang' : 'text' };
  return { kind: 'binary', label: 'unknown' };
}

/** No NUL byte, and either valid UTF-8 or mostly printable (legacy encodings). Empty content is text. */
export function isText(head: Buffer): boolean {
  if (head.length === 0) return true;
  const probe = head.subarray(0, 8192);
  if (probe.includes(0)) return false;
  try {
    // a multi-byte character cut by the probe boundary must not make valid text look binary
    let end = probe.length;
    while (end > 0 && end > probe.length - 4 && (probe[end - 1]! & 0xc0) === 0x80) end--;
    if (end > 0 && probe[end - 1]! >= 0xc0) end--;
    new TextDecoder('utf-8', { fatal: true }).decode(
      probe.subarray(0, probe.length === head.length ? probe.length : end),
    );
    return true;
  } catch {
    let odd = 0;
    for (const v of probe) if (v < 9 || (v > 13 && v < 32)) odd++;
    return odd / probe.length < 0.05;
  }
}

const SENSITIVE_BASENAME =
  /^(?:\.env(?:\.(?!example$|sample$|template$|dist$)[^/]*)?|\.npmrc|\.pypirc|\.netrc|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx|jks|keystore|ppk|tfstate)|[^/]*service[-_]?account[^/]*\.json|secrets?\.(?:json|ya?ml))$/i;
const SENSITIVE_PATH = /(?:^|\/)(?:\.aws\/credentials|\.docker\/config\.json|\.ssh\/[^/]+)$/i;
/** Files whose NAME says they hold credentials: inventoried and flagged, never stored, never shown. */
export const isSensitivePath = (path: string): boolean =>
  SENSITIVE_PATH.test(path) || SENSITIVE_BASENAME.test(path.split('/').pop() ?? path);

/** Directories that are not part of a project's source: version-control metadata, dependency trees, OS litter. Skipped without being read. */
export const isNoisePath = (
  path: string,
): 'vcs_metadata' | 'dependency_tree' | 'os_metadata' | null =>
  /(?:^|\/)\.(?:git|hg|svn)(?:\/|$)/.test(path)
    ? 'vcs_metadata'
    : /(?:^|\/)node_modules(?:\/|$)/.test(path)
      ? 'dependency_tree'
      : /(?:^|\/)(?:__MACOSX|\.DS_Store|Thumbs\.db)(?:\/|$)/.test(path)
        ? 'os_metadata'
        : null;

const LANGS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  dart: 'dart',
  py: 'python',
  rb: 'ruby',
  php: 'php',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  rs: 'rust',
  cs: 'csharp',
  vue: 'vue',
  svelte: 'svelte',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  sql: 'sql',
  md: 'markdown',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  gradle: 'gradle',
  sh: 'shell',
  graphql: 'graphql',
  prisma: 'prisma',
};
export const languageOf = (path: string): string | null =>
  LANGS[(path.split('.').pop() ?? '').toLowerCase()] ?? null;
