/**
 * Copy lint (M10 S50.3, AC-M10-14): no UI or doc text may promise store approval or a way around store review. The rules are deliberately broad (a false positive costs a reworded sentence;
 * a false negative ships a promise the platform cannot keep). The same function runs over the console strings, the release templates, the docs and every free-text member of a release record.
 */
export interface CopyViolation {
  rule: string;
  excerpt: string;
}
const RULES: { rule: string; re: RegExp }[] = [
  { rule: 'guaranteed_approval', re: /\bguarantee[sd]?\b[^.\n]{0,40}\b(approv\w*|accept\w*|pass\w*|publish\w*)/i },
  { rule: 'will_be_approved', re: /\b(will|going to|certain to|sure to|bound to)\s+be\s+(approved|accepted|published)\b/i },
  { rule: 'approved_by_store', re: /\bapproved\s+by\s+(apple|google|the\s+(app|play)\s*store|app\s*store|play\s*store)\b/i },
  { rule: 'bypass_review', re: /\b(skip|bypass|avoid|circumvent|get\s+around|jump)\s+(the\s+)?((app|play)\s*store\s+|apple\s+|google\s+)?(review|approval|moderation)\b/i },
  { rule: 'instant_approval', re: /\b(instant|immediate|automatic|100\s*%)\s+(store\s+)?(approval|acceptance)\b/i },
  { rule: 'no_review', re: /\b(without|no|zero)\s+(app\s*store\s+|play\s*store\s+|apple\s+|google\s+)?(review|approval)\s+(needed|required|wait)\b/i },
  { rule: 'ar_guaranteed_approval', re: /(ضمان|نضمن|مضمون\w*|مضمونة)\s+[^.\n]{0,30}(الموافقة|القبول|النشر)/ },
  { rule: 'ar_bypass_review', re: /(تجاوز|تخطي|تفادي|الالتفاف\s+على)\s+(\w+\s+){0,2}(مراجعة|فحص|موافقة)\s+(المتجر|آبل|جوجل|أبل)/ },
  { rule: 'ar_certain_approval', re: /(موافقة|قبول)\s+(مؤكدة|فورية|مضمونة|تلقائية)/ },
];
export function copyLint(text: string): CopyViolation[] {
  const out: CopyViolation[] = [];
  for (const { rule, re } of RULES) {
    const m = re.exec(text);
    if (m) out.push({ rule, excerpt: text.slice(Math.max(0, m.index - 10), m.index + m[0].length + 10).slice(0, 120) });
  }
  return out;
}
/** every string inside a JSON value, for linting free text members of a record */
export function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsOf(x, out));
  else if (v && typeof v === 'object') Object.values(v as object).forEach((x) => stringsOf(x, out));
  return out;
}
