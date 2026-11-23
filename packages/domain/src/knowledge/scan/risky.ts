import type { FileClass } from '../archive/filetype';
import type { ScanFinding } from './types';

const LONG_LINE = 5000;
export interface RiskyInput {
  path: string;
  bytes: number;
  cls: FileClass;
  unixExecutable: boolean;
  /** Head of the content for text files (up to ~64 KiB). */
  text?: string;
}
/**
 * Pattern scan. These are reports for a reviewer, never a malware verdict (D-44): nothing here claims a package is safe, and nothing runs the file.
 */
export function scanRisky(f: RiskyInput): ScanFinding[] {
  const out: ScanFinding[] = [];
  const add = (code: string, severity: ScanFinding['severity'], detail: string) =>
    out.push({ scanner: 'risky_files', code, severity, path: f.path, line: null, detail });
  if (f.cls.kind === 'executable')
    add('executable_binary', 'warn', `${f.cls.label} file; excluded from the snapshot`);
  else if (f.cls.kind === 'archive')
    add('nested_archive', 'warn', 'a nested archive; it was not opened');
  else if (f.unixExecutable && f.cls.kind === 'text')
    add(
      'executable_script',
      'info',
      'a text file with the executable bit set; excluded from the snapshot',
    );
  if (f.cls.kind !== 'text' || !f.text) return out;
  const t = f.text;
  const lines = t.split('\n');
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  if (
    longest > LONG_LINE &&
    !/\.min\.(?:js|css)$/.test(f.path) &&
    !/\.(?:map|svg|json|lock)$/.test(f.path)
  )
    add(
      'minified_or_obfuscated',
      'info',
      `a very long line (${longest} characters) suggests minified or obfuscated code`,
    );
  if (/(?:[A-Za-z0-9+/]{2000,}={0,2})/.test(t))
    add('base64_blob', 'info', 'a large base64 blob is embedded');
  if (
    /\beval\s*\(|new Function\s*\(|child_process|\bexecSync\s*\(|\bspawnSync?\s*\(|os\.system\s*\(|subprocess\.(?:Popen|call|run)\s*\(|Runtime\.getRuntime\(\)\.exec|\bshell_exec\s*\(|\bpassthru\s*\(/.test(
      t,
    )
  )
    add(
      'dynamic_code',
      'info',
      'uses dynamic code evaluation or process execution (reported for review; it was not run)',
    );
  if (/\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){40,}|String\.fromCharCode\((?:\s*\d+\s*,){30,}/i.test(t))
    add(
      'obfuscated_payload',
      'warn',
      'encoded character sequences are typical of obfuscated payloads',
    );
  if (
    /^\.github\/workflows\/|^\.gitlab-ci|(?:^|\/)Jenkinsfile$/.test(f.path) &&
    /(?:curl|wget)\s/.test(t)
  )
    add('ci_network_call', 'info', 'a CI file calls out to the network');
  return out;
}
export const isHiddenPath = (path: string): boolean =>
  path
    .split('/')
    .some(
      (s) =>
        s.startsWith('.') &&
        !/^\.(?:github|vscode|storybook|husky|changeset|well-known|env\.example|gitignore|gitattributes|editorconfig|eslintrc.*|prettierrc.*|npmrc-?|nvmrc|dockerignore|babelrc.*|browserslistrc|metadata|fvm|idea)$/.test(
          s,
        ),
    );
