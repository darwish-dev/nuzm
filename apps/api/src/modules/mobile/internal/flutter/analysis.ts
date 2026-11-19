import { scanForSecrets } from '@nuzm/domain';
import { evaluatePubspec, type PolicyIssue } from '../policy/pub-policy';

/**
 * Static gate over a generated Flutter project (S48: "generated-project analysis"). It runs in the control plane on TEXT only, before anything is stored or built; it never executes
 * project code. `flutter analyze` and `flutter test` are the dynamic counterpart and run on the template in the (local, labelled non-isolated) build worker / in the S48 evidence run.
 */
export interface AnalysisIssue {
  rule:
    | PolicyIssue['rule']
    | 'secret'
    | 'forbidden_import'
    | 'forbidden_call'
    | 'cleartext_url'
    | 'signing_material'
    | 'missing_file'
    | 'unsafe_path'
    | 'too_large';
  path?: string;
  detail: string;
}
const REQUIRED = ['pubspec.yaml', 'analysis_options.yaml', 'lib/main.dart', 'test/widget_test.dart'];
/** libraries and calls a generated app has no use for and that widen the attack surface */
const FORBIDDEN_IMPORT = /import\s+['"]dart:(ffi|mirrors|isolate)['"]/;
const FORBIDDEN_CALL = /\b(Process\.(run|start|runSync)|Platform\.executable|dart:cli)\b/;
const CLEARTEXT = /['"]http:\/\/(?!localhost|127\.0\.0\.1|10\.0\.2\.2)[^'"\s]+/;
const SIGNING_FILE = /(^|\/)(key\.properties|local\.properties|[^/]+\.(jks|keystore|p12|pfx|mobileprovision|p8))$/i;
const SIGNING_TEXT = /(storePassword|keyPassword|keystorePassword|signingConfigs\s*\{|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY)/;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export function analyzeProject(files: Record<string, string>): AnalysisIssue[] {
  const out: AnalysisIssue[] = [];
  let total = 0;
  for (const p of REQUIRED)
    if (!(p in files)) out.push({ rule: 'missing_file', path: p, detail: `${p} is required` });
  for (const [path, text] of Object.entries(files)) {
    total += Buffer.byteLength(text, 'utf8');
    if (/(^\/|\.\.|\/\/|\\|\0)/.test(path)) {
      out.push({ rule: 'unsafe_path', path, detail: 'unsafe path' });
      continue;
    }
    if (SIGNING_FILE.test(path)) {
      out.push({ rule: 'signing_material', path, detail: 'signing material never belongs in a project' });
      continue;
    }
    for (const f of scanForSecrets(text)) out.push({ rule: 'secret', path, detail: `secret pattern: ${f.kind}` });
    if (SIGNING_TEXT.test(text) && !path.endsWith('.gitignore'))
      out.push({ rule: 'signing_material', path, detail: 'signing configuration or key material in a file' });
    if (path.endsWith('.dart')) {
      if (FORBIDDEN_IMPORT.test(text)) out.push({ rule: 'forbidden_import', path, detail: 'dart:ffi, dart:mirrors and dart:isolate are not allowed' });
      if (FORBIDDEN_CALL.test(text)) out.push({ rule: 'forbidden_call', path, detail: 'process execution is not allowed' });
      if (CLEARTEXT.test(text)) out.push({ rule: 'cleartext_url', path, detail: 'cleartext http:// URL (use https)' });
    }
  }
  if (total > MAX_TOTAL_BYTES) out.push({ rule: 'too_large', detail: `project is ${total} bytes` });
  if (files['pubspec.yaml']) out.push(...evaluatePubspec(files['pubspec.yaml']));
  return out;
}
