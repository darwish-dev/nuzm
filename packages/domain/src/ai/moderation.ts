/**
 * Content moderation hook (M09 S38 task 6). The policy provider is an OPEN decision (owner), so the default is a small deny-list + the caller's rate limits.
 * This is a PLACEHOLDER policy: it is not a legal or safety classification and must be replaced by the owner-approved policy.
 */
export interface ModerationResult {
  allowed: boolean;
  categories: string[];
}
const DENY: { category: string; re: RegExp }[] = [
  {
    category: 'weapons_manufacture',
    re: /\b(build|make|manufacture)\s+(a\s+)?(bomb|explosive|nerve agent)\b/i,
  },
  {
    category: 'malware',
    re: /\b(write|create|generate)\s+(a\s+)?(ransomware|keylogger|credential stealer)\b/i,
  },
  { category: 'phishing', re: /\b(phishing (page|site|kit)|fake (bank|login) (page|site))\b/i },
  { category: 'csam', re: /\bchild\s+(sexual|porn)/i },
  { category: 'weapons_manufacture', re: /تصنيع\s+(قنبلة|متفجرات)/ },
  { category: 'phishing', re: /صفحة\s+(تصيد|احتيال)/ },
];
export type ModerationHook = (text: string) => ModerationResult | Promise<ModerationResult>;
export const defaultModeration = (text: string): ModerationResult => {
  const categories = [...new Set(DENY.filter((d) => d.re.test(text)).map((d) => d.category))];
  return { allowed: categories.length === 0, categories };
};
