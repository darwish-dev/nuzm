import { ModelAdapterError, type CallContext, type ModelAdapter } from './types';

export interface ConformanceCase {
  name: string;
  ok: boolean;
  detail?: string;
}
const DEC = /^\d+(\.\d+)?$/;

/**
 * Conformance suite for any `ModelAdapter` (mock or real). Returns every case with its outcome; the caller asserts that all passed.
 * A real provider additionally needs a LIVE-VERIFIED probe: this suite proves the CONTRACT shape only (it never proves quality or live availability).
 */
export async function runModelConformance(make: () => ModelAdapter): Promise<ConformanceCase[]> {
  const out: ConformanceCase[] = [];
  const check = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      out.push({ name, ok: true });
    } catch (e) {
      out.push({ name, ok: false, detail: (e as Error).message });
    }
  };
  const need = (c: boolean, m: string) => {
    if (!c) throw new Error(m);
  };
  const a = make();
  const model = a.models()[0]?.modelId ?? '';
  const ctx = (id: string): CallContext => ({ callId: id });
  const req = { model, messages: [{ role: 'user' as const, content: 'hello' }], maxTokens: 64 };

  await check('declares id, kind, contract version, region', () => {
    need(
      a.kind === 'model' && !!a.id && !!a.contractVersion && !!a.region,
      'identity fields missing',
    );
  });
  await check('declares data terms with explicit flags (unknown allowed, absent not)', () => {
    const t = a.dataTerms;
    need(typeof t.attested === 'boolean', 'attested');
    need(
      t.retainsPrompts === true || t.retainsPrompts === false || t.retainsPrompts === 'unknown',
      'retainsPrompts',
    );
    need(
      t.trainsOnData === true || t.trainsOnData === false || t.trainsOnData === 'unknown',
      'trainsOnData',
    );
    need(!t.attested || !!t.attestationRef, 'attested terms need an attestation reference');
    need(!!t.processingRegion, 'processingRegion');
  });
  await check('pricing is decimal strings, never floats', () => {
    need(
      DEC.test(a.pricing.inputPerMillion) && DEC.test(a.pricing.outputPerMillion),
      'pricing must be decimal strings',
    );
  });
  await check('lists at least one model with positive limits', () => {
    const m = a.models();
    need(m.length > 0, 'no models');
    for (const x of m)
      need(
        x.contextTokens > 0 && x.maxOutputTokens > 0 && x.maxOutputTokens <= x.contextTokens,
        `limits of ${x.modelId}`,
      );
  });
  await check(
    'complete returns text, finish reason and usage-or-null within maxTokens',
    async () => {
      const r = await a.complete(ctx('c1'), req);
      need(typeof r.text === 'string' && r.model === model, 'shape');
      need(['stop', 'length', 'refusal'].includes(r.finishReason), 'finishReason');
      if (r.usage)
        need(
          r.usage.outputTokens <= req.maxTokens && r.usage.inputTokens >= 0,
          'usage within maxTokens',
        );
    },
  );
  await check('maxTokens is a hard ceiling', async () => {
    const r = await a.complete(ctx('c2'), { ...req, maxTokens: 1 });
    if (r.usage) need(r.usage.outputTokens <= 1, 'output exceeded maxTokens');
  });
  await check('stream ends with exactly one done chunk and equals complete text', async () => {
    let text = '';
    let dones = 0;
    for await (const ch of a.stream(ctx('c3'), req)) {
      if ('delta' in ch) text += ch.delta;
      else dones++;
    }
    need(dones === 1, 'exactly one done chunk');
    const r = await a.complete(ctx('c4'), req);
    need(text === r.text, 'stream text differs from complete text for the same request');
  });
  await check('tokenCount is non-negative and monotonic', () => {
    const s = a.tokenCount(model, [{ role: 'user', content: 'a' }]);
    const l = a.tokenCount(model, [{ role: 'user', content: 'a'.repeat(4000) }]);
    need(s >= 0 && l > s, 'monotonic');
  });
  await check('an unknown model is a non-retryable invalid_request', async () => {
    try {
      await a.complete(ctx('c5'), { ...req, model: 'does-not-exist' });
      throw new Error('accepted an unknown model');
    } catch (e) {
      need(
        e instanceof ModelAdapterError && e.code === 'invalid_request' && !e.retryable,
        'must be invalid_request, not retryable',
      );
    }
  });
  await check('an aborted signal stops the call', async () => {
    const ac = new AbortController();
    ac.abort();
    try {
      await a.complete({ callId: 'c6', signal: ac.signal }, req);
      throw new Error('ignored the abort signal');
    } catch (e) {
      need(e instanceof ModelAdapterError && e.code === 'aborted', 'must be aborted');
    }
  });
  return out;
}
