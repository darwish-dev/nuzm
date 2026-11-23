import { scanForSecrets } from '../../ai/secret-scan';
import { isSensitivePath } from '../archive/filetype';
import type { ScanFinding } from './types';

// obvious placeholders: documentation and templates are full of them and quarantining a theme for `YOUR_API_KEY_HERE` would make the library unusable
const PLACEHOLDER =
  /(?:your[_-]?|example|sample|changeme|change[_-]me|placeholder|dummy|xxxx|<[^>]+>|\$\{|{{|process\.env|import\.meta\.env)/i;
const HIGH_CONFIDENCE = new Set([
  'private_key_block',
  'aws_access_key',
  'github_token',
  'slack_token',
  'nuzm_api_key',
  'enc_sealed_field',
  'canary',
]);

export interface SecretScanResult {
  findings: ScanFinding[];
  /** Count including noise-level matches; stored on the file row. */
  count: number;
}
function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
}
/**
 * Scans one text file. Evidence is the kind and `path:line` ONLY: the matched text is never copied into a finding, a log or a database row.
 * High-confidence formats block the package; assignment-style and connection-string matches are warnings unless they look like real values.
 */
export function scanTextForSecrets(
  path: string,
  text: string,
  canaries: readonly string[] = [],
): SecretScanResult {
  const raw = scanForSecrets(text, canaries);
  const findings: ScanFinding[] = [];
  let count = 0;
  const seen = new Set<string>();
  for (const f of raw) {
    const around = text.slice(Math.max(0, f.index - 5), f.index + 120);
    const line = lineOf(text, f.index);
    const placeholder = PLACEHOLDER.test(around.split('\n')[0] ?? '');
    if (f.kind === 'vault_reference') continue; // a vault:// reference is the approved way to name a secret
    if (placeholder && !HIGH_CONFIDENCE.has(f.kind)) continue;
    count++;
    const key = `${f.kind}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const high =
      HIGH_CONFIDENCE.has(f.kind) ||
      (f.kind === 'connection_string' &&
        !/@(?:localhost|127\.0\.0\.1|db|postgres|redis|example)/i.test(around));
    findings.push({
      scanner: 'secrets',
      code: high ? 'secret_found' : 'secret_suspected',
      severity: high ? 'block' : 'warn',
      path,
      line,
      detail: `${f.kind} at ${path}:${line}`,
    });
  }
  return { findings, count };
}

/** Files that exist to hold credentials: inventoried and flagged but never stored or shown. */
export function sensitiveFileFinding(path: string): ScanFinding | null {
  if (!isSensitivePath(path)) return null;
  const example =
    /\.(?:example|sample|template|dist)$/i.test(path) ||
    /(?:^|\/)\.env\.(?:example|sample|template)$/i.test(path);
  return {
    scanner: 'sensitive_files',
    code: example ? 'sensitive_template' : 'sensitive_file',
    severity: example ? 'info' : 'warn',
    path,
    line: null,
    detail: `${path} is a credential or configuration file and was not stored`,
  };
}
