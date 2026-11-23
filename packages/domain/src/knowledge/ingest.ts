import { createHash } from 'node:crypto';
import {
  classifyContent,
  isNoisePath,
  languageOf,
  type ArchiveSource,
  type ExtractLimits,
  extractArchive,
} from './archive/extract';
import { isLicenseFile, proposeLicense, type LicenseInput } from './scan/license';
import { scanManifest, isManifestPath, type DependencyOptions } from './scan/dependencies';
import { scanRisky, isHiddenPath } from './scan/risky';
import { scanTextForSecrets, sensitiveFileFinding } from './scan/secrets';
import type { DependencyRecord, LicenseProposal, ScanFinding } from './scan/types';

export type { LicenseInput } from './scan/license';
/** Where snapshot bytes go. Content-addressed: the same bytes are stored once. The worker supplies the object-store adapter; tests supply memory. */
export interface SnapshotSink {
  putSnapshot(sha256: string, data: Buffer): Promise<string>;
}
export interface IngestFile {
  path: string;
  sha256: string;
  bytes: number;
  language: string | null;
  isBinary: boolean;
  isExecutable: boolean;
  /** NULL = inventoried but not stored (binary, executable, credential file, secret found, too large). */
  objectKey: string | null;
  secretFindings: number;
  notStoredReason: string | null;
}
export interface IngestResult {
  format: 'zip' | 'tar.gz';
  files: IngestFile[];
  findings: ScanFinding[];
  license: LicenseProposal;
  dependencies: DependencyRecord[];
  stats: {
    entries: number;
    files: number;
    directories: number;
    bytes: number;
    stored: number;
    storedBytes: number;
    skipped: number;
    byLanguage: Record<string, number>;
  };
  /** At least one `block` finding: the package cannot proceed to review without an admin decision. */
  blocked: boolean;
  skipped: { path: string; reason: string }[];
}
export interface IngestOptions extends DependencyOptions {
  limits?: Partial<ExtractLimits>;
  canaries?: readonly string[];
  shouldCancel?: () => boolean;
  now?: () => number;
  /** Largest text file kept in the snapshot / scanned in full. */
  maxStoredTextBytes?: number;
  maxStoredAssetBytes?: number;
  /** Analyse everything but write nothing: the same result, with the keys the objects WOULD get. Used to prove a package valid before any byte is stored. */
  dryRun?: boolean;
}
const HEAD = 64 * 1024;
const MAX_FINDINGS_PER_FILE = 20;
const MAX_FINDINGS = 2000;
const MAX_LICENSE_INPUT = 60;

/**
 * Extracts and analyses one package. Pure with respect to the package: bytes are hashed, classified and pattern-scanned; nothing is executed, imported, installed or
 * resolved. Rejections surface as ArchiveRejected.
 */
export async function ingestArchive(
  src: ArchiveSource,
  sink: SnapshotSink,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const maxText = opts.maxStoredTextBytes ?? 4 * 1024 * 1024;
  const maxAsset = opts.maxStoredAssetBytes ?? 8 * 1024 * 1024;
  const files: IngestFile[] = [];
  const findings: ScanFinding[] = [];
  const dependencies: DependencyRecord[] = [];
  const licenseInputs: LicenseInput[] = [];
  const stored = new Set<string>();
  const stats = {
    entries: 0,
    files: 0,
    directories: 0,
    bytes: 0,
    stored: 0,
    storedBytes: 0,
    skipped: 0,
    byLanguage: {} as Record<string, number>,
  };
  const noiseCounts = new Map<string, number>();
  const push = (f: ScanFinding) => {
    if (findings.length < MAX_FINDINGS || f.severity === 'block') findings.push(f);
  };

  const summary = await extractArchive(
    src,
    {
      shouldCancel: opts.shouldCancel,
      decide: (e) => {
        const noise = isNoisePath(e.path);
        if (noise) {
          noiseCounts.set(noise, (noiseCounts.get(noise) ?? 0) + 1);
          return { skip: noise };
        }
        return 'read';
      },
      onFile: async (e, data) => {
        const hash = createHash('sha256');
        const keep: Buffer[] = [];
        let kept = 0;
        let head: Buffer = Buffer.alloc(0);
        const cap = Math.max(maxText, maxAsset);
        for await (const c of data) {
          hash.update(c);
          if (head.length < HEAD) head = Buffer.concat([head, c.subarray(0, HEAD - head.length)]);
          if (kept <= cap) {
            keep.push(c);
            kept += c.length;
          }
        }
        const sha256 = hash.digest('hex');
        const cls = classifyContent(head);
        const executableBit = e.unixExecutable;
        const lang = cls.kind === 'text' ? languageOf(e.path) : null;
        const complete = kept === e.size;
        const body = complete ? Buffer.concat(keep) : null;
        let notStoredReason: string | null = null;
        let secretCount = 0;
        const own: ScanFinding[] = [];

        const sensitive = sensitiveFileFinding(e.path);
        if (sensitive) own.push(sensitive);
        if (isHiddenPath(e.path) && !sensitive)
          own.push({
            scanner: 'risky_files',
            code: 'hidden_path',
            severity: 'info',
            path: e.path,
            line: null,
            detail: 'a hidden file or directory',
          });

        if (cls.kind === 'text' && body) {
          const text = body.toString('utf8');
          const s = scanTextForSecrets(e.path, text, opts.canaries);
          secretCount = s.count;
          own.push(...s.findings.slice(0, MAX_FINDINGS_PER_FILE));
          if (isManifestPath(e.path)) {
            const m = scanManifest(e.path, text, opts);
            dependencies.push(...m.deps);
            own.push(...m.findings);
          }
          if (
            licenseInputs.length < MAX_LICENSE_INPUT &&
            (isLicenseFile(e.path) ||
              isManifestPath(e.path) ||
              /pyproject\.toml$|Cargo\.toml$/.test(e.path) ||
              /SPDX-License-Identifier/.test(text.slice(0, 2000)))
          )
            licenseInputs.push({
              path: e.path,
              text: isLicenseFile(e.path) ? text.slice(0, 30_000) : text.slice(0, 200_000),
            });
        } else if (cls.kind === 'text') {
          // too large to scan in full: scan the head and say so
          const s = scanTextForSecrets(e.path, head.toString('utf8'), opts.canaries);
          secretCount = s.count;
          own.push(...s.findings.slice(0, MAX_FINDINGS_PER_FILE));
        }
        own.push(
          ...scanRisky({
            path: e.path,
            bytes: e.size,
            cls,
            unixExecutable: executableBit,
            text: cls.kind === 'text' ? head.toString('utf8') : undefined,
          }),
        );

        const blockedHere = own.some((f) => f.severity === 'block' && f.scanner === 'secrets');
        let objectKey: string | null = null;
        if (sensitive) notStoredReason = 'sensitive_file';
        else if (blockedHere) notStoredReason = 'secret_found';
        else if (cls.kind === 'executable' || cls.kind === 'archive') notStoredReason = cls.kind;
        else if (cls.kind === 'binary') notStoredReason = 'binary';
        else if (cls.kind === 'text' && executableBit) notStoredReason = 'executable_script';
        else if (!body) notStoredReason = 'too_large_to_store';
        else if (cls.kind === 'text' && e.size > maxText) notStoredReason = 'too_large_to_store';
        else if (cls.kind === 'asset' && e.size > maxAsset) notStoredReason = 'too_large_to_store';
        if (notStoredReason === null && body) {
          objectKey = opts.dryRun ? `snapshots/${sha256}` : await sink.putSnapshot(sha256, body);
          if (!stored.has(sha256)) {
            stored.add(sha256);
            stats.storedBytes += e.size;
          }
          stats.stored++;
        }
        if (notStoredReason === 'too_large_to_store')
          own.push({
            scanner: 'risky_files',
            code: 'too_large_to_store',
            severity: 'info',
            path: e.path,
            line: null,
            detail: `${e.size} bytes; inventoried but not stored`,
          });

        for (const f of own) push(f);
        files.push({
          path: e.path,
          sha256,
          bytes: e.size,
          language: lang,
          isBinary: cls.kind !== 'text',
          isExecutable: cls.kind === 'executable' || executableBit,
          objectKey,
          secretFindings: secretCount,
          notStoredReason,
        });
        if (lang) stats.byLanguage[lang] = (stats.byLanguage[lang] ?? 0) + e.size;
      },
    },
    { limits: opts.limits, now: opts.now },
  );
  for (const [reason, n] of noiseCounts)
    push({
      scanner: 'archive',
      code: `skipped_${reason}`,
      severity: 'info',
      path: null,
      line: null,
      detail: `${n} ${reason.replace('_', ' ')} file(s) were not read`,
    });
  Object.assign(stats, {
    entries: summary.entries,
    files: files.length,
    directories: summary.directories,
    bytes: summary.bytes,
    skipped: summary.skipped.length,
  });
  const license = proposeLicense(licenseInputs);
  if (license.verdict !== 'ALLOWED')
    push({
      scanner: 'license',
      code: `license_${license.verdict.toLowerCase()}`,
      severity: license.verdict === 'BLOCKED' ? 'block' : 'warn',
      path: license.evidence[0]?.path ?? null,
      line: null,
      detail: license.reason,
    });
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    format: summary.format,
    files,
    findings,
    license,
    dependencies,
    stats,
    blocked: findings.some((f) => f.severity === 'block'),
    skipped: summary.skipped,
  };
}
