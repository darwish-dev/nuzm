import { lstatSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Confinement of control-plane file access to a sandbox directory (DEFECT-5, Session 07). Sandboxed code controls what is inside its directory, including symlinks and hard
 * links; the control plane (a confused deputy) must never follow one. A lexical `checkPath` is not enough. Rules, applied to every control-plane read or write of a sandbox path:
 *  - no component of the path below the root may be a symbolic link (checked with `lstat`, existing components only);
 *  - the deepest existing ancestor must resolve (`realpath`) to somewhere under the real root;
 *  - a file that is READ must be a regular file with a single link (a hard link to an outside file has nlink > 1).
 * A time-of-check/time-of-use race remains possible between the check and the open while sandboxed code is running concurrently: the control plane therefore only reads or writes
 * a sandbox directory while no process of that sandbox is running (the dev runner is dev-only and non-isolated; a real runtime reads through its own agent, not the host path).
 */
export class ConfinementError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ConfinementError';
  }
}
export function confinedPath(root: string, rel: string, mode: 'read' | 'write' | 'dir'): string {
  const realRoot = realpathSync(root);
  const parts = rel.split('/').filter((p) => p !== '');
  let cur = root;
  let deepestExisting = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]!);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      break; // the rest does not exist yet: it will be created by the control plane itself, inside the checked ancestor
    }
    if (st.isSymbolicLink()) throw new ConfinementError('symlink_in_path');
    deepestExisting = cur;
    const last = i === parts.length - 1;
    if (last && mode === 'read' && (!st.isFile() || st.nlink > 1))
      throw new ConfinementError('not_a_single_link_regular_file');
    if (last && mode === 'dir' && !st.isDirectory()) throw new ConfinementError('not_a_directory');
    if (last && mode === 'write' && st.isDirectory())
      throw new ConfinementError('target_is_a_directory');
    if (last && mode === 'write' && st.nlink > 1) throw new ConfinementError('hard_link_target');
  }
  const real = realpathSync(deepestExisting);
  if (real !== realRoot && !real.startsWith(realRoot + sep))
    throw new ConfinementError('escapes_the_sandbox');
  return join(root, ...parts);
}
