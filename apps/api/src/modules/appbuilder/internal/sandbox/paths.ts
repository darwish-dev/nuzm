/** Path and content safety for everything that crosses the control-plane/sandbox boundary (changes API, runtime writes, exports). Pure. */
const BIDI = /[‪-‮⁦-⁩‎‏؜]/u;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
const CONTROL = /[\u0000-\u001f\u007f]/;

export const MAX_PATH_LENGTH = 240;
export const MAX_FILE_BYTES = 1_000_000;
const FORBIDDEN_TOP = new Set([
  '.git',
  '.nuzm',
  '.ssh',
  '.aws',
  '.gnupg',
  '.config',
  'node_modules',
]);

/** Returns the reason a project-relative path is refused, or null when it is a plain, safe, relative file path. */
export function checkPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0) return 'the path is empty';
  if (p.length > MAX_PATH_LENGTH) return 'the path is too long';
  if (CONTROL.test(p)) return 'the path contains a control character';
  if (BIDI.test(p)) return 'the path contains a bidirectional control character';
  if (p !== p.normalize('NFC')) return 'the path is not NFC-normalised';
  if (p.includes('\\')) return 'backslashes are not allowed';
  if (/%[0-9a-f]{2}/i.test(p)) return 'percent-encoded characters are not allowed';
  if (p.startsWith('/') || /^[a-z]:/i.test(p) || p.startsWith('~'))
    return 'the path must be relative to the project';
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '') return 'the path has an empty segment';
    if (s === '.' || s === '..') return 'the path has a . or .. segment';
    if (/^\.+$/.test(s)) return 'the path has a dot-only segment';
    if (/[:*?"<>|]/.test(s)) return 'the path contains a reserved character';
    if (/[ .]$/.test(s)) return 'a segment may not end with a space or a dot';
  }
  if (FORBIDDEN_TOP.has(segs[0]!.toLowerCase())) return `${segs[0]} is not a project path`;
  if (segs.some((s) => s.toLowerCase() === '.git')) return 'a .git directory is not allowed';
  return null;
}

export interface SecretFinding {
  rule: string;
  /** 1-based line; the matched text is NEVER returned. */
  line: number;
}
const RULES: [string, RegExp][] = [
  ['aws_access_key_id', /\b(AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/],
  [
    'private_key_block',
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  ],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['stripe_live_key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['anthropic_or_openai_key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['canary_token', /\bNZCANARY-[0-9a-f]{16,}\b/],
  [
    'database_url_with_password',
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]{3,}@/i,
  ],
  [
    'generic_secret_assignment',
    /\b(?:api[_-]?key|secret|passw(?:or)?d|token|private[_-]?key)\b["']?\s*[:=]\s*["'][A-Za-z0-9+/_=-]{20,}["']/i,
  ],
];
/** Secret-pattern scan of a file body. Placeholders (`change-me`, `example`, `<...>`, `process.env`) are not findings. */
export function scanSecrets(content: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    if (line.length > 4000) line = line.slice(0, 4000);
    for (const [rule, re] of RULES) {
      const m = re.exec(line);
      if (!m) continue;
      if (
        /change-me|example\.test|<[^>]+>|process\.env|YOUR_|xxxx/i.test(line) &&
        rule !== 'private_key_block' &&
        rule !== 'canary_token'
      )
        continue;
      out.push({ rule, line: i + 1 });
    }
  });
  return out;
}
/** Redacts every secret-pattern match in free text (logs): the text is replaced, the rule name kept. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [rule, re] of RULES)
    out = out.replace(
      new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'),
      `[redacted:${rule}]`,
    );
  return out;
}
