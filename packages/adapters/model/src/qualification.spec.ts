import { describe, expect, it } from 'vitest';
import {
  CONTENT_POLICY,
  QUALIFICATION_TRACKS,
  bracketsBalanced,
  checkGeneratedCode,
  evidenceFileName,
  extractCode,
  runQualification,
  trackWorstCase,
  validateEvidence,
  type QualificationEvidence,
  type QualificationTrack,
} from './qualification';
import { LiveSuiteRefused, type LiveSuiteApproval } from './live-verification';
import { TWIN_PRICING, twinTarget } from './live-twin';
import { tokenCostNano, formatNano } from './probe-cost';
import { LIVE_REQUIRED_DECISIONS } from './live-evidence';
import { ModelAdapterError, type CallContext, type CompleteRequest } from './types';
import { MockModelAdapter } from './mock';

// SYNTHETIC approval, evidence and prices: nothing here is a real decision or a real price.
const TRACKS: QualificationTrack[] = ['A', 'B', 'C'];
const approvalFor = (
  t: QualificationTrack,
  over: Partial<LiveSuiteApproval> = {},
): LiveSuiteApproval => {
  const w = trackWorstCase(t);
  return {
    ref: 'synthetic-D9-ref',
    approvedBy: 'synthetic-owner',
    environment: 'non-production',
    maxRequests: w.requests,
    maxTotalTokens: w.totalTokens,
    maxCostNano: tokenCostNano(w.inputTokens, w.outputTokens, TWIN_PRICING).toString(),
    ...over,
  };
};
const evidenceRows = () =>
  LIVE_REQUIRED_DECISIONS.map((decision) => ({
    decision,
    ref: `synthetic-ref-${decision}`,
    recordedBy: 'synthetic-owner',
    recordedAt: '2026-11-20T10:00:00Z',
    provider: 'mock-live-twin',
    environment: 'non-production',
    outcome: 'approved',
  }));
const CONTENT = [
  'Reply with exactly',
  'lowercases the input',
  'export function',
  'return input',
  'let total',
  'echo',
  'alpha',
];

describe('worst cases (shown to the approver)', () => {
  it('A: 2 requests; B: the whole probe (8); C: 2 requests; and what they cost at the synthetic 4/20 price', () => {
    expect(trackWorstCase('A')).toEqual({
      requests: 2,
      inputTokens: 600,
      outputTokens: 200,
      totalTokens: 800,
    });
    expect(trackWorstCase('B')).toMatchObject({ requests: 8, totalTokens: 11_716 });
    expect(trackWorstCase('C')).toEqual({
      requests: 2,
      inputTokens: 600,
      outputTokens: 1_400,
      totalTokens: 2_000,
    });
    const cost = (t: QualificationTrack) => {
      const w = trackWorstCase(t);
      return formatNano(tokenCostNano(w.inputTokens, w.outputTokens, TWIN_PRICING));
    };
    expect([cost('A'), cost('B'), cost('C')]).toEqual(['0.006400', '0.080720', '0.030400']);
    expect(Object.keys(QUALIFICATION_TRACKS)).toEqual(['A', 'B', 'C']);
  });
});

describe('every track runs against the mock twin and says SIMULATED', () => {
  it.each(TRACKS)(
    'track %s: verdict SIMULATED, a valid evidence record, within the caps, no content',
    async (t) => {
      const { target } = twinTarget();
      const ev = await runQualification(t, target, approvalFor(t));
      expect(
        ev.checks.filter((c) => !(c.ok && c.ran)),
        JSON.stringify(ev.checks),
      ).toEqual([]);
      expect(ev.verdict).toBe('SIMULATED');
      expect(ev.mode).toBe('mock');
      expect(validateEvidence(ev)).toEqual([]);
      expect(ev.totals.requests).toBeLessThanOrEqual(trackWorstCase(t).requests);
      expect(ev.totals.tokensIn + ev.totals.tokensOut).toBeLessThanOrEqual(
        trackWorstCase(t).totalTokens,
      );
      const text = JSON.stringify(ev);
      for (const c of CONTENT) expect(text, c).not.toContain(c);
      expect(ev.contentPolicy).toBe(CONTENT_POLICY);
      expect(evidenceFileName(ev)).toMatch(
        new RegExp(`^qualification-${t}-mock-live-twin-mock-\\d{8}T\\d{6}Z\\.json$`),
      );
    },
  );
  it('a live-labelled run with every gate is LIVE-VERIFIED only because the target says live (here the twin: this proves the labelling, not a provider)', async () => {
    const { target } = twinTarget();
    const ev = await runQualification('C', { ...target, mode: 'live' }, approvalFor('C'), {
      liveProviders: ['mock-live-twin'],
      evidence: evidenceRows(),
    });
    expect(ev.verdict).toBe('LIVE-VERIFIED');
    expect(validateEvidence(ev)).toEqual([]);
    // the same record relabelled as a mock run is rejected: a mock can never be LIVE-VERIFIED
    expect(validateEvidence({ ...ev, mode: 'mock' })).toContain(
      'a mock run can never be LIVE-VERIFIED',
    );
  });
});

describe('refusals before anything is sent', () => {
  it.each(TRACKS)(
    'track %s: no approval, caps below the worst case, no live gate, missing evidence',
    async (t) => {
      const { target, primary } = twinTarget();
      const w = trackWorstCase(t);
      for (const a of [
        undefined,
        approvalFor(t, { maxRequests: w.requests - 1 }),
        approvalFor(t, { maxTotalTokens: w.totalTokens - 1 }),
        approvalFor(t, { maxCostNano: '1' }),
        approvalFor(t, { environment: 'production' as never }),
      ])
        await expect(runQualification(t, target, a as LiveSuiteApproval)).rejects.toThrow(
          LiveSuiteRefused,
        );
      const live = { ...target, mode: 'live' as const };
      await expect(
        runQualification(t, live, approvalFor(t), { evidence: evidenceRows() }),
      ).rejects.toThrow('AI_LIVE_PROVIDERS');
      for (const d of LIVE_REQUIRED_DECISIONS)
        await expect(
          runQualification(t, live, approvalFor(t), {
            liveProviders: ['mock-live-twin'],
            evidence: evidenceRows().filter((r) => r.decision !== d),
          }),
        ).rejects.toThrow(`${d}: no valid evidence row`);
      expect(primary.calls).toHaveLength(0);
    },
  );
});

describe('what a failing provider looks like', () => {
  it('track C: code that fails the static checks is FAIL, with a fixed sentence and no code in the record', async () => {
    const { target, primary } = twinTarget();
    primary.handler = (r: CompleteRequest) =>
      String(r.messages[0]?.content).includes('slugify')
        ? "```ts\nconst fs = require('fs');\nexport function slugify(input: string): string { return fs.readFileSync(input, 'utf8'); }\n```"
        : 'no code here';
    const ev = await runQualification('C', target, approvalFor('C'));
    expect(ev.verdict).toBe('FAIL');
    expect(ev.checks.map((c) => c.ok)).toEqual([false, false]);
    expect(ev.checks[0]!.detail).toContain('static checks failed');
    expect(JSON.stringify(ev)).not.toContain('readFileSync');
    expect(validateEvidence(ev)).toEqual([]);
  });
  it('track C: an answer cut at the ceiling is inconclusive, not a pass', async () => {
    const { target, primary } = twinTarget();
    primary.handler = () => 'x'.repeat(4 * 800);
    const ev = await runQualification('C', target, approvalFor('C'));
    expect(ev.verdict).toBe('FAIL');
    expect(ev.checks[0]!.detail).toContain('inconclusive');
  });
  it('track A: a credential failure stops the run, the rest is not run, and the verdict is not a pass', async () => {
    const { target, primary } = twinTarget();

    primary.failNext(new ModelAdapterError('invalid_request', 'rejected', false));
    const ev = await runQualification('A', target, approvalFor('A'));
    expect(ev.stoppedEarly).toBe('credential_or_availability');
    expect(ev.verdict).toBe('FAIL');
    expect(ev.checks.find((c) => c.id === 'stream')).toMatchObject({ ran: false });
    expect(ev.requests).toHaveLength(1);
    expect(ev.requests[0]).toMatchObject({
      outcome: 'error',
      errorCode: 'invalid_request',
      estimated: true,
    });
  });
  it('track B on an adapter without tool-use is NOT VERIFIED, never a pass', async () => {
    const { target } = twinTarget();
    const plain = new MockModelAdapter({ id: 'plain', pricing: TWIN_PRICING });
    const ev = await runQualification(
      'B',
      { ...target, adapter: plain, model: 'mock-chat-1' },
      approvalFor('B'),
    );
    expect(ev.verdict).toBe('NOT VERIFIED');
    expect(ev.checks[0]).toMatchObject({ ok: false, ran: false });
  });
  it('a provider reporting far more input than the allowance stops the run before the next request', async () => {
    const { target, primary } = twinTarget();
    const oc = primary.complete.bind(primary);
    primary.complete = async (c: CallContext, r: CompleteRequest) => {
      const x = await oc(c, r);
      return {
        ...x,
        usage: x.usage ? { ...x.usage, inputTokens: x.usage.inputTokens + 5_000 } : null,
      };
    };
    const ev = await runQualification('C', target, approvalFor('C'));
    expect(ev.stoppedEarly).toBe('token_cap');
    expect(ev.requests).toHaveLength(1);
    expect(ev.verdict).not.toBe('SIMULATED');
  });
});

describe('the vendor request id is recorded when it is well formed', () => {
  it('records req_… ids from the adapter, and rejects a malformed one in a record', async () => {
    const { target, primary } = twinTarget();
    const oc = primary.complete.bind(primary);
    let n = 0;
    primary.complete = async (c: CallContext, r: CompleteRequest) => ({
      ...(await oc(c, r)),
      requestId: `req_synthetic${++n}abc`,
    });
    const ev = await runQualification('C', target, approvalFor('C'));
    expect(ev.requests.map((r) => r.requestId)).toEqual(['req_synthetic1abc', 'req_synthetic2abc']);
    expect(validateEvidence(ev)).toEqual([]);
    const bad: QualificationEvidence = {
      ...ev,
      requests: [{ ...ev.requests[0]!, requestId: 'not an id' }, ...ev.requests.slice(1)],
    };
    expect(validateEvidence(bad)).toContain(
      'request code: malformed request id'.replace('code', 'codegen_slugify'),
    );
  });
  it('validateEvidence refuses long strings (content), wrong totals and a verdict that does not match', async () => {
    const { target } = twinTarget();
    const ev = await runQualification('A', target, approvalFor('A'));
    expect(
      validateEvidence({
        ...ev,
        checks: [{ ...ev.checks[0]!, detail: 'x'.repeat(301) }, ...ev.checks.slice(1)],
      }).join(),
    ).toContain('longer than 300');
    expect(
      validateEvidence({ ...ev, totals: { ...ev.totals, tokensIn: ev.totals.tokensIn + 1 } }),
    ).toContain('the totals do not add up');
    expect(validateEvidence({ ...ev, verdict: 'FAIL' }).join()).toContain(
      'does not match the checks',
    );
  });
});

describe('static checks of generated code (the code is never executed)', () => {
  const slug = { fn: 'slugify', signature: /slugify\s*\(\s*\w+\s*:\s*string\s*\)\s*:\s*string/ };
  const good =
    '```ts\nexport function slugify(input: string): string {\n  return input.trim();\n}\n```';
  it('accepts a well-formed answer, fenced or bare', () => {
    expect(checkGeneratedCode(good, slug)).toEqual({ ok: true, problems: [] });
    expect(checkGeneratedCode(extractCode(good)!, slug).ok).toBe(true);
    expect(
      checkGeneratedCode('export const slugify = (input: string): string => input;', {
        fn: 'slugify',
        signature: /slugify\s*=\s*\(\s*\w+\s*:\s*string\s*\)\s*:\s*string/,
      }).ok,
    ).toBe(true);
  });
  it.each([
    ['no code', 'Here is how you do it in words.', 'no code block'],
    ['wrong name', good.replace('slugify', 'slug'), 'does not export slugify'],
    ['wrong signature', good.replace('(input: string): string', '(input)'), 'typed signature'],
    ['unbalanced', good.replace('}\n```', '\n```'), 'not balanced'],
    ['an import', good.replace('export', "import x from 'y';\nexport"), 'import or require'],
    ['eval', good.replace('input.trim()', 'eval(input)'), 'eval'],
    ['process access', good.replace('input.trim()', 'process.env.X'), 'process'],
    ['network', good.replace('input.trim()', "fetch('http://x')"), 'network'],
    ['no return', good.replace('return input.trim();', 'input.trim();'), 'returns nothing'],
    ['too long', good.replace('return', `// ${'x'.repeat(4001)}\n  return`), 'longer than 4,000'],
  ])('refuses %s', (_n, answer, text) => {
    const r = checkGeneratedCode(answer, slug);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' | ')).toContain(text);
  });
  it('brackets inside strings and comments do not count', () => {
    expect(bracketsBalanced('const a = \'(\' + "}" + `[`; // )\n/* ] */ f(g[0]);')).toBe(true);
    expect(bracketsBalanced('f(')).toBe(false);
    expect(bracketsBalanced('f(]')).toBe(false);
    expect(bracketsBalanced("'unterminated")).toBe(false);
  });
});
