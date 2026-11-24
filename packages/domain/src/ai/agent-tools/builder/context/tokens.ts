/**
 * Token and cost estimation (S-05 priority 4). These are ESTIMATES used to plan and to stay inside budgets BEFORE a call; the provider's reported usage (`ai.model_usage`) stays the
 * authority for billing. Money is integer minor units: `cost = ceil(tokens x ratePer1k / 1000)`, never a float.
 */
// Arabic text costs more tokens per character than Latin text in common tokenizers; everything else (CJK, symbols) is treated as dense.
const AR = /[؀-ۿݐ-ݿ]/;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let latin = 0;
  let arabic = 0;
  let other = 0;
  let space = 0;
  for (const ch of text) {
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') space++;
    else if (AR.test(ch)) arabic++;
    else if (ch.charCodeAt(0) < 0x250) latin++;
    else other++;
  }
  return Math.max(1, Math.ceil(latin / 3.8 + arabic / 2.0 + other / 1.2 + space / 6));
}

export function costMinor(tokens: number, ratePer1kMinor: number): number {
  if (!Number.isInteger(ratePer1kMinor) || ratePer1kMinor < 0) throw new Error('the rate must be a non-negative integer of minor units per 1000 tokens');
  return Math.ceil((Math.max(0, tokens) * ratePer1kMinor) / 1000);
}
