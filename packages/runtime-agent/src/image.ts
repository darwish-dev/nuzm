import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Image identity. An "image" of this node is an unpacked, read-only ROOTFS directory (what `infra/runtime/rootfs/build-rootfs.sh` produces) and its identity is the TREE DIGEST:
 * a sha256 over the sorted list of every entry's type, path, permission bits and (for a regular file) the sha256 of its content, (for a symlink) its target. Ownership, mtime and
 * hard-link structure do not enter, so the same recipe on any machine gives the same digest. The attestation lists these digests; the agent recomputes them at start and refuses
 * to run if any configured image does not match its digest (a tampered or substituted rootfs is a supply-chain incident, never a warning).
 */
const fileSha = (p: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });

export async function treeDigest(dir: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    const names = (await readdir(abs)).sort();
    for (const n of names) {
      const a = join(abs, n);
      const r = rel === '' ? n : `${rel}/${n}`;
      const st = await lstat(a);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) lines.push(`l ${r} ${mode} ${await readlink(a)}`);
      else if (st.isDirectory()) {
        lines.push(`d ${r} ${mode}`);
        await walk(a, r);
      } else if (st.isFile()) lines.push(`f ${r} ${mode} ${st.size} ${await fileSha(a)}`);
      else lines.push(`x ${r} ${mode}`); // a device, FIFO or socket in a rootfs is itself a finding: it changes the digest
    }
  };
  await walk(dir, '');
  return `sha256:${createHash('sha256').update(lines.join('\n')).digest('hex')}`;
}

export interface ImageCheck {
  verified: Record<string, string>;
  mismatched: string[];
}
/** recompute each configured image's digest; the agent starts only if `mismatched` is empty */
export async function verifyImages(images: Readonly<Record<string, string>>): Promise<ImageCheck> {
  const verified: Record<string, string> = {};
  const mismatched: string[] = [];
  for (const [digest, dir] of Object.entries(images)) {
    const actual = await treeDigest(dir).catch(() => null);
    if (actual === digest) verified[digest] = dir;
    else mismatched.push(digest);
  }
  return { verified, mismatched };
}
