import { createHash } from 'node:crypto';

/**
 * APK evidence (T3): SHA-256, size and a STRUCTURAL check of the file, done in-process without unpacking or running anything. It reads the zip central directory only.
 * This is a structural check, not an installation test: install-and-launch evidence needs an emulator or device (`infra/mobile/android/verify-apk.sh`), and `apkanalyzer` gives the
 * authoritative manifest view. A structurally valid APK is NOT labelled "installable".
 */
export interface ApkEvidence {
  sha256: string;
  bytes: number;
  entries: number;
  hasManifest: boolean;
  hasDex: boolean;
  /** `lib/<abi>/` directories found */
  abis: string[];
  hasFlutterEngine: boolean;
  hasFlutterAssets: boolean;
  /** JAR signature files (v1) or the APK Signing Block magic (v2+) */
  signatureScheme: 'none' | 'v1' | 'v2+';
  structuralIssues: string[];
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const SIG_BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'latin1');

export function listZipEntries(buf: Buffer): { names: string[]; issues: string[] } {
  const issues: string[] = [];
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0x4b50)
    return { names: [], issues: ['not a zip (missing PK header)'] };
  // end-of-central-directory record: scan backwards (max comment 65535)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { names: [], issues: ['zip end-of-central-directory record not found'] };
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > eocd) return { names: [], issues: ['central directory is out of range'] };
  const names: string[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      issues.push(`central directory entry ${i} is malformed`);
      break;
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (names.length !== total && issues.length === 0) issues.push('entry count mismatch');
  return { names, issues };
}

export function inspectApk(buf: Buffer): ApkEvidence {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const { names, issues } = listZipEntries(buf);
  const has = (re: RegExp) => names.some((n) => re.test(n));
  const abis = [
    ...new Set(
      names.map((n) => /^lib\/([^/]+)\//.exec(n)?.[1]).filter((x): x is string => Boolean(x)),
    ),
  ].sort();
  const v1 = has(/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i) && has(/^META-INF\/[^/]+\.SF$/i);
  const v2 = buf.includes(SIG_BLOCK_MAGIC);
  const out: ApkEvidence = {
    sha256,
    bytes: buf.length,
    entries: names.length,
    hasManifest: names.includes('AndroidManifest.xml'),
    hasDex: has(/^classes\d*\.dex$/),
    abis,
    hasFlutterEngine: has(/^lib\/[^/]+\/libflutter\.so$/),
    hasFlutterAssets: has(/^assets\/flutter_assets\//),
    signatureScheme: v2 ? 'v2+' : v1 ? 'v1' : 'none',
    structuralIssues: [...issues],
  };
  if (!out.hasManifest) out.structuralIssues.push('AndroidManifest.xml is missing');
  if (!out.hasDex) out.structuralIssues.push('no classes.dex');
  return out;
}
