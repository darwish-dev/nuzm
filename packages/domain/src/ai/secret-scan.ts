/**
 * Outbound-prompt secret scanner (M09 S37 task 6, AC-M09-05). A prompt that matches is BLOCKED (not redacted-and-sent) and audited by the caller.
 * Findings carry the KIND and an offset, never the matched value. `canaries` are exact platform strings (env `AI_SECRET_CANARIES`, comma separated) that must
 * never appear in any prompt, output or log: tests plant them.
 */
export interface SecretFinding {
  kind: string;
  index: number;
}
const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'private_key_block', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'nuzm_api_key', re: /\bnzk_[A-Za-z0-9_-]{8,}_[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'vault_reference', re: /\bvault:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,200}/g },
  { kind: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    kind: 'api_key_assignment',
    re: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[A-Za-z0-9/+_=.-]{16,}/gi,
  },
  {
    kind: 'connection_string',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/gi,
  },
  { kind: 'enc_sealed_field', re: /\benc:v1:[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{38,}/g },
];

export function scanForSecrets(text: string, canaries: readonly string[] = []): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push({ kind, index: m.index ?? 0 });
  }
  for (const c of canaries) {
    if (c.length < 8) continue; // a short canary would match ordinary text
    let i = text.indexOf(c);
    while (i !== -1) {
      out.push({ kind: 'canary', index: i });
      i = text.indexOf(c, i + c.length);
    }
  }
  return out;
}
export const canariesFromEnv = (env: NodeJS.ProcessEnv = process.env): string[] =>
  (env.AI_SECRET_CANARIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
