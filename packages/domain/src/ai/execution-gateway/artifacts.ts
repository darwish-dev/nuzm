import { createHash } from 'node:crypto';
import { isAgentSensitivePath, normalizeToolPath } from '../agent-tools/paths';
import type { ArtifactRef } from './port';

/**
 * S-AG6 (OFFLINE): artifact handling (ADR-069 item 4). Files a run produced are CANDIDATES: they are listed, size-checked, hashed and stored by reference; they are never applied
 * to the project automatically (`ARTIFACTS_AUTO_APPLY` is the constant `false`; applying anything still goes through the patch proposal and human approval path). Paths are
 * normalised or refused, only declared output roots are accepted, sensitive paths and links are refused, and counts and bytes are bounded.
 */
export const ARTIFACTS_AUTO_APPLY = false as const;
export interface ArtifactPolicy {
  roots: readonly string[];
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}
export const DEFAULT_ARTIFACT_POLICY: ArtifactPolicy = {
  roots: ['dist', 'build', 'out', 'coverage', 'reports'],
  maxFiles: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
};
export interface ProducedFile {
  path: string;
  bytes: number;
  /** the runtime reports links: a symlink or hard link is never accepted as an artifact */
  kind: 'file' | 'symlink' | 'hardlink' | 'dir' | 'device';
  /** content is supplied by the runtime adapter only when it is hashed here; otherwise the adapter supplies `sha256` */
  content?: Uint8Array | string;
  sha256?: string;
}
export interface ArtifactDecision {
  accepted: ArtifactRef[];
  refused: { path: string; reason: string }[];
}
const SHA = /^[0-9a-f]{64}$/;
const sha256 = (c: Uint8Array | string) => createHash('sha256').update(c).digest('hex');

export function collectArtifacts(
  files: readonly ProducedFile[],
  policy: ArtifactPolicy = DEFAULT_ARTIFACT_POLICY,
  now: () => Date = () => new Date(),
  newId: (i: number) => string = (i) => `art-${i + 1}`,
): ArtifactDecision {
  const accepted: ArtifactRef[] = [];
  const refused: { path: string; reason: string }[] = [];
  let total = 0;
  for (const f of files) {
    const refuse = (reason: string) =>
      refused.push({ path: typeof f.path === 'string' ? f.path.slice(0, 120) : '?', reason });
    const p = normalizeToolPath(f.path);
    if (!p.ok) {
      refuse('path_invalid');
      continue;
    }
    if (f.kind !== 'file') {
      refuse(`not_a_regular_file_${f.kind}`);
      continue;
    }
    if (!policy.roots.some((r) => p.path === r || p.path.startsWith(`${r}/`))) {
      refuse('outside_output_roots');
      continue;
    }
    if (isAgentSensitivePath(p.path)) {
      refuse('sensitive_path');
      continue;
    }
    if (!Number.isInteger(f.bytes) || f.bytes < 0) {
      refuse('size_invalid');
      continue;
    }
    if (f.bytes > policy.maxFileBytes) {
      refuse('file_too_large');
      continue;
    }
    if (accepted.length >= policy.maxFiles) {
      refuse('too_many_files');
      continue;
    }
    if (total + f.bytes > policy.maxTotalBytes) {
      refuse('total_too_large');
      continue;
    }
    let digest: string;
    if (f.content !== undefined) {
      const actual =
        typeof f.content === 'string' ? Buffer.byteLength(f.content) : f.content.byteLength;
      if (actual !== f.bytes) {
        refuse('size_mismatch');
        continue;
      }
      digest = sha256(f.content);
    } else if (typeof f.sha256 === 'string' && SHA.test(f.sha256)) digest = f.sha256;
    else {
      refuse('no_content_hash');
      continue;
    }
    total += f.bytes;
    accepted.push({
      id: newId(accepted.length),
      path: p.path,
      bytes: f.bytes,
      sha256: digest,
      createdAt: now().toISOString(),
    });
  }
  return { accepted, refused };
}
