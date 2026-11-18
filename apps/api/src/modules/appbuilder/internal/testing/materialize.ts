import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Writes a generated file set under apps/api/.gen-tmp (git-ignored; inside the package so `pg`, its types and TypeScript resolve from apps/api/node_modules). Test support only. */
export function materialize(files: ReadonlyMap<string, string>): {
  dir: string;
  cleanup: () => void;
} {
  const root = join(__dirname, '../../../../../.gen-tmp');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'app-'));
  for (const [path, content] of files) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
