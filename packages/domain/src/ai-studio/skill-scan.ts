import { scanForSecrets } from '../ai/secret-scan';
import { looksLikeInjection } from '../ai/untrusted';

/**
 * AI Studio S-A1 (ADR-064, proposed): static review of a Skill's files BEFORE any person approves it. Treats every file as untrusted
 * text; nothing is executed, fetched or unpacked here. It is a PATTERN scanner: `clean` means "no rule fired", not "safe" — a human
 * still approves, and executable skills need two approvers (D-40). Findings never quote the matched text (it could be a secret).
 */
export type SkillScanSeverity = 'reject' | 'review' | 'info';
export type SkillScanRule =
  | 'path'
  | 'secret'
  | 'injection'
  | 'policy_override'
  | 'metadata_endpoint'
  | 'exfiltration'
  | 'pipe_to_shell'
  | 'destructive'
  | 'credential_path'
  | 'network'
  | 'encoded_payload'
  | 'hidden_text'
  | 'executable'
  | 'binary'
  | 'size';
export interface SkillScanFinding {
  rule: SkillScanRule;
  severity: SkillScanSeverity;
  path: string;
  /** 1-based; 0 when the finding is about the whole file */
  line: number;
  detail: string;
}
export interface SkillFile {
  path: string;
  /** text content; `null` for a binary file (it is not inspected) */
  content: string | null;
  /** executable bit as recorded in the source tree */
  executable?: boolean;
  bytes?: number;
}
export interface SkillScanOptions {
  /** hosts a skill may mention without a `review` (documentation sites, the platform's own) */
  allowedHosts?: readonly string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
}
export interface SkillScanResult {
  verdict: 'clean' | 'review' | 'reject';
  /** ships scripts or binaries: publication needs two different approvers */
  executable: boolean;
  findings: SkillScanFinding[];
}

export const SKILL_SCAN_RULESET = '2026-11-20.1';
const DEFAULT_ALLOWED_HOSTS = [
  'docs.anthropic.com',
  'code.claude.com',
  'developer.mozilla.org',
  'nextjs.org',
  'react.dev',
  'docs.nestjs.com',
  'www.postgresql.org',
  'docs.flutter.dev',
  'dart.dev',
];

type LineRule = { rule: SkillScanRule; severity: SkillScanSeverity; re: RegExp; detail: string };
const LINE_RULES: LineRule[] = [
  {
    rule: 'policy_override',
    severity: 'reject',
    re: /\b(ignore|bypass|disable|override|turn off)\b[^.\n]{0,40}\b(safety|security|sandbox|permission|guardrail|policy|policies|approval)s?\b/i,
    detail: 'asks the agent to switch off safety, permission or approval controls',
  },
  {
    rule: 'policy_override',
    severity: 'reject',
    re: /--dangerously-skip-permissions|\bbypassPermissions\b/,
    detail: 'turns off the agent permission prompts',
  },
  {
    rule: 'policy_override',
    severity: 'reject',
    re: /\b(do not|don't|never) (tell|inform|show|mention)\b[^.\n]{0,30}\b(user|owner|human)\b/i,
    detail: 'asks the agent to hide actions from the user',
  },
  {
    rule: 'metadata_endpoint',
    severity: 'reject',
    re: /169\.254\.169\.254|fd00:ec2::254|metadata\.google\.internal|100\.100\.100\.200/i,
    detail: 'reaches a cloud instance-metadata endpoint',
  },
  {
    rule: 'pipe_to_shell',
    severity: 'reject',
    re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\biex\s*\(|\bInvoke-Expression\b/i,
    detail: 'downloads and executes code in one step',
  },
  {
    rule: 'encoded_payload',
    severity: 'reject',
    re: /base64\s+(-d|--decode)[^|\n]*\|\s*(ba|z)?sh\b|\beval\s*\(\s*(atob|Buffer\.from)\(/i,
    detail: 'decodes and executes a hidden payload',
  },
  {
    rule: 'destructive',
    severity: 'reject',
    re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(\/(\s|$)|~|\$HOME|\/\*|\.\s*$)|\bmkfs(\.\w+)?\b|\bdd\s+if=.*\bof=\/dev\/|:\(\)\s*\{\s*:\|:&\s*\};:|\bchmod\s+-R\s+777\s+\//,
    detail: 'destroys files, disks or the system',
  },
  {
    rule: 'destructive',
    severity: 'reject',
    re: /\bgit\s+push\b[^\n]*(--force\b|\s-f\b)|\bgit\s+reset\s+--hard\s+origin\b|\bDROP\s+(DATABASE|SCHEMA)\b/i,
    detail: 'rewrites shared history or drops a database',
  },
  {
    rule: 'exfiltration',
    severity: 'reject',
    re: /\b(curl|wget|fetch|axios|requests\.(post|put)|Invoke-WebRequest)\b[^\n]*(--data|-d\s|-F\s|--upload-file|-T\s|method:\s*['"](POST|PUT)|body:)[^\n]*(\$\{?\w*(KEY|TOKEN|SECRET|PASS)\w*|process\.env|os\.environ|~\/\.|\.env\b|id_rsa|\.ssh)/i,
    detail: 'sends secrets or private files to a remote host',
  },
  {
    rule: 'credential_path',
    severity: 'review',
    re: /~\/\.(ssh|aws|config\/gcloud|kube|docker|npmrc|netrc|git-credentials)|\bid_(rsa|ed25519)\b|\/etc\/(passwd|shadow)\b|credentials\.json\b|(^|[\s'"`/])\.env(\.\w+)?\b/i,
    detail: 'reads a credential or private configuration file',
  },
];
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u00AD]|\uFEFF(?!^)/;
const URL_RE = /\bhttps?:\/\/([a-z0-9.-]+)(?::\d+)?/gi;
const LONG_BASE64 = /[A-Za-z0-9+/]{240,}={0,2}/;
const SCRIPT_EXT =
  /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|exe|dll|so|dylib|jar|bin)$/i;

function pathProblem(p: string): string | null {
  if (!p || p.length > 240) return 'empty or over-long path';
  if (p.includes('\0') || p.includes('\\')) return 'NUL or backslash in path';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute path';
  if (p.split('/').some((s) => s === '..' || s === '')) return 'path escapes the skill folder';
  if (p.split('/').some((s) => s === '.git')) return 'path inside .git';
  return null;
}

/** Scans every file of one skill and returns the findings and a verdict (`reject` > `review` > `clean`). */
export function scanSkill(
  files: readonly SkillFile[],
  opts: SkillScanOptions = {},
): SkillScanResult {
  const allowed = new Set((opts.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((h) => h.toLowerCase()));
  const maxFile = opts.maxFileBytes ?? 256_000;
  const maxTotal = opts.maxTotalBytes ?? 2_000_000;
  const findings: SkillScanFinding[] = [];
  let executable = false;
  let total = 0;

  for (const f of files) {
    const bad = pathProblem(f.path);
    if (bad) {
      findings.push({
        rule: 'path',
        severity: 'reject',
        path: f.path.slice(0, 120),
        line: 0,
        detail: bad,
      });
      continue;
    }
    const size = f.bytes ?? (f.content === null ? 0 : Buffer.byteLength(f.content));
    total += size;
    if (size > maxFile)
      findings.push({
        rule: 'size',
        severity: 'review',
        path: f.path,
        line: 0,
        detail: 'file is unusually large',
      });
    if (f.content === null) {
      executable = true;
      findings.push({
        rule: 'binary',
        severity: 'review',
        path: f.path,
        line: 0,
        detail: 'binary file: cannot be reviewed as text',
      });
      continue;
    }
    const firstLine = f.content.slice(0, 200).split('\n')[0] ?? '';
    if (f.executable || SCRIPT_EXT.test(f.path) || firstLine.startsWith('#!')) {
      executable = true;
      findings.push({
        rule: 'executable',
        severity: 'info',
        path: f.path,
        line: 0,
        detail: 'ships an executable script: needs two approvers',
      });
    }
    for (const s of scanForSecrets(f.content)) {
      // a secret's location only: the value is never repeated
      const line = f.content.slice(0, s.index).split('\n').length;
      findings.push({
        rule: 'secret',
        severity: 'reject',
        path: f.path,
        line,
        detail: `contains a credential (${s.kind})`,
      });
    }
    const lines = f.content.split('\n');
    lines.forEach((text, i) => {
      const line = i + 1;
      if (HIDDEN.test(text))
        findings.push({
          rule: 'hidden_text',
          severity: 'reject',
          path: f.path,
          line,
          detail: 'invisible or direction-changing characters can hide instructions',
        });
      for (const r of LINE_RULES)
        if (r.re.test(text))
          findings.push({
            rule: r.rule,
            severity: r.severity,
            path: f.path,
            line,
            detail: r.detail,
          });
      if (looksLikeInjection(text))
        findings.push({
          rule: 'injection',
          severity: 'review',
          path: f.path,
          line,
          detail: 'reads like an attempt to override the agent instructions',
        });
      if (LONG_BASE64.test(text))
        findings.push({
          rule: 'encoded_payload',
          severity: 'review',
          path: f.path,
          line,
          detail: 'long encoded blob',
        });
      for (const m of text.matchAll(URL_RE)) {
        const host = m[1]!.toLowerCase().replace(/\.$/, '');
        if (!allowed.has(host))
          findings.push({
            rule: 'network',
            severity: 'review',
            path: f.path,
            line,
            detail: `refers to an external host (${host.slice(0, 60)})`,
          });
      }
    });
  }
  if (total > maxTotal)
    findings.push({
      rule: 'size',
      severity: 'review',
      path: '.',
      line: 0,
      detail: 'skill is unusually large',
    });

  const verdict = findings.some((x) => x.severity === 'reject')
    ? 'reject'
    : findings.some((x) => x.severity === 'review')
      ? 'review'
      : 'clean';
  return { verdict, executable, findings };
}
