import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import {
  ModelAdapterError,
  abortableSleep,
  applyFallbackPolicy,
  assembleStream,
  allowedToolCalls,
  candidateKey,
  createResilience,
  estimateTokens,
  resolveCapabilities,
  retryDelayMs,
  toolSpecProblems,
  type CompleteResponse,
  type HealthSnapshot,
  type ModelAdapter,
  type ModelCapability,
  type ModelMessage,
  type Resilience,
  type StreamChunk,
} from '@nuzm/adapter-model';
import {
  ResidencyDenied,
  assertResidency,
  creditsFor,
  dataTermsAllow,
  reservationFor,
  routeModels,
  scanForSecrets,
  validateToolCalls,
  type Candidate,
  type Capability,
  type DataClass,
  type ResidencyEvaluator,
} from '@nuzm/domain';
import { emitUsage, usageEventId, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { FieldCipher } from '../../../common/field-crypto';
import type { LedgerPostingService } from '../../billing';
import { recipes } from '../../billing';
import type { AiFlags } from './flags';
import {
  BudgetDenied,
  withDeadlockRetry,
  type BudgetService,
  type Reservation,
} from './budget.service';
import type { GatewayCall, GatewayResult, AiConfig } from './model';
import type { ModelProviderService, ProviderDto } from './provider.service';
import type { ModelAdapterRegistry } from './registry';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const PUBLIC_CAPABILITIES: readonly Capability[] = [
  'chat',
  'structured-output',
  'long-context',
  'embeddings',
  'vision',
];

/** Decimal string → integer scaled by 1e6 (the provider's own price; used only for the COST record, never for what the customer pays). */
const scaled = (d: string): bigint => {
  const [i = '0', f = ''] = d.split('.');
  return BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};
/** Provider cost in minor units of the pricing currency (2 decimals), rounded up. */
export const providerCostMinor = (
  p: { inputPerMillion: string; outputPerMillion: string },
  tin: number,
  tout: number,
): bigint => {
  const num =
    (BigInt(tin) * scaled(p.inputPerMillion) + BigInt(tout) * scaled(p.outputPerMillion)) * 100n;
  const den = 1_000_000n * 1_000_000n;
  return (num + den - 1n) / den;
};

interface Offer {
  provider: ProviderDto;
  adapter: ModelAdapter;
  candidate: Candidate;
}

/**
 * The model gateway (docs/09 §7, M09 S37). EVERY model call in the platform goes through `invoke`:
 *   kill switch → secret scan (blocks, audits) → candidates (enabled provider + registered adapter + RATE CARD entry; unknown price = not offered) →
 *   residency verdict per provider (ResidencyService; missing/failed = deny) → data-terms rule → ranking → budget reservation → call (timeout, bounded retry) →
 *   reconcile (provider counts, or a flagged estimate) → usage row + metering + ledger drawdown, idempotent by call id.
 * A fallback is only ever another ALLOWED candidate and needs its own reservation, so it can neither cross residency nor overspend.
 */
export class GatewayService {
  /** per-process retry policy, circuit breakers and health samples (S-AG4): in memory, so a restart starts every circuit closed and every health window empty */
  private readonly resilience: Resilience;
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly flags: AiFlags,
    private readonly registry: ModelAdapterRegistry,
    private readonly providers: ModelProviderService,
    private readonly budgets: BudgetService,
    private readonly residency: ResidencyEvaluator,
    private readonly ledger: LedgerPostingService,
    private readonly cipher: FieldCipher,
    private readonly cfg: AiConfig,
    resilience?: Resilience,
  ) {
    this.resilience =
      resilience ??
      createResilience({
        retry: {
          maxAttempts: cfg.attemptsPerCandidate,
          baseDelayMs: cfg.retryBaseDelayMs,
          maxDelayMs: Math.max(cfg.retryMaxDelayMs, cfg.retryBaseDelayMs),
        },
        breaker: { failureThreshold: cfg.breakerFailureThreshold, openMs: cfg.breakerOpenMs },
      });
  }

  /** Health of every provider (key = code) and provider/model (key = code/model) this process has called (rolling window), with the provider's breaker state. Read-only; the admin API that exposes it is a contract request. */
  providerHealth(): HealthSnapshot[] {
    return this.resilience.health.all();
  }

  private async offers(): Promise<Offer[]> {
    const out: Offer[] = [];
    const evidence = await this.providers.verifiedCapabilities();
    for (const { row } of await this.providers.enabledWithAdapters()) {
      const adapter = this.registry.get(row.code)!;
      const devReference = /^(mock|local)-/.test(row.code);
      for (const m of adapter.models()) {
        const rate = row.rateCard.models[m.modelId];
        if (!rate) continue; // no price = not offered (CLAUDE.md §4: never invent prices)
        out.push({
          provider: row,
          adapter,
          candidate: {
            providerCode: row.code,
            modelId: m.modelId,
            region: row.region,
            // version negotiation + D8 evidence rule (unknown = unsupported): one pure function shared with the admin capability registry
            capabilities: resolveCapabilities({
              contractVersion: adapter.contractVersion,
              declared: m.capabilities as ModelCapability[],
              devReference,
              verifiedContract: (c) => evidence.get(`${row.id}|${m.modelId}|${c}`),
            }) as Capability[],
            contextTokens: m.contextTokens,
            maxOutputTokens: m.maxOutputTokens,
            latencyClass: m.latencyClass,
            dataTerms: {
              attested: row.dataTerms.attested,
              retainsPrompts: row.dataTerms.retainsPrompts,
              trainsOnData: row.dataTerms.trainsOnData,
            },
            rate,
          },
        });
      }
    }
    return out;
  }

  /** residency verdict per provider for ONE class; a denial or any failure is `deny`. The hook m09-model-gateway is `assertResidency`. */
  private async verdicts(
    orgId: string,
    cls: DataClass,
    providers: ProviderDto[],
  ): Promise<{ map: Record<string, 'allow' | 'deny'>; evidence: Record<string, string> }> {
    const map: Record<string, 'allow' | 'deny'> = {};
    const evidence: Record<string, string> = {};
    for (const p of providers) {
      try {
        const r = await assertResidency(this.residency, {
          orgId,
          dataClass: cls,
          targetRegion: p.region,
          purpose: 'ai_model_call',
          operation: 'write',
          processorId: p.code,
        });
        map[p.code] = 'allow';
        evidence[p.code] = r.evidenceRef;
      } catch (e) {
        map[p.code] = 'deny';
        if (e instanceof ResidencyDenied) evidence[p.code] = e.result.evidenceRef;
      }
    }
    return { map, evidence };
  }

  /** Models the organization may use (residency of `customer-content`, the class of builder prompts). */
  async models(orgId: string) {
    const offers = await this.offers();
    const providers = [...new Map(offers.map((o) => [o.provider.code, o.provider])).values()];
    const { map } = await this.verdicts(orgId, 'customer-content', providers);
    return {
      items: offers
        .filter((o) => map[o.provider.code] === 'allow')
        .map((o) => ({
          providerCode: o.provider.code,
          modelId: o.candidate.modelId,
          region: o.provider.region,
          // the public contract lists the five capabilities of contract 1.0 until the owner approves the OpenAPI delta for the 1.1 ones (SCR-K-10 §7); the gateway itself already routes on all of them
          capabilities: o.candidate.capabilities.filter((c) => PUBLIC_CAPABILITIES.includes(c)),
          // D7 (variant B): one boolean instead of three new capability strings, so a client with closed enums is not affected
          supportsTools: o.candidate.capabilities.includes('tool-use'),
          contextTokens: o.candidate.contextTokens,
          maxOutputTokens: o.candidate.maxOutputTokens,
          latencyClass: o.candidate.latencyClass,
          dataTermsAttested: o.provider.dataTerms.attested,
          creditsPerMillionInput: o.candidate.rate.creditsPerMillionInput,
          creditsPerMillionOutput: o.candidate.rate.creditsPerMillionOutput,
        })),
    };
  }

  /**
   * Cheap pre-flight for creating a run (docs/04: 503 kill switch, 422 `unsupported_capability`, 403 `residency_denied`, 402 `insufficient_credits`): the run fails
   * early instead of queueing work that the first model call would refuse.
   */
  async assertAvailable(orgId: string): Promise<void> {
    if (await this.flags.killSwitch(orgId))
      throw new ProblemException('ai_unavailable', 'AI is switched off by the kill switch');
    const offers = await this.offers();
    if (offers.length === 0)
      throw new ProblemException(
        'unsupported_capability',
        'no model provider is enabled with a rate card (D-18, HG-09-01)',
      );
    const providers = [...new Map(offers.map((o) => [o.provider.code, o.provider])).values()];
    const { map, evidence } = await this.verdicts(orgId, 'customer-content', providers);
    const ok = offers.filter(
      (o) =>
        map[o.provider.code] === 'allow' &&
        dataTermsAllow(
          'customer-content',
          o.candidate.dataTerms,
          this.cfg.allowUnattestedForSensitive,
        ),
    );
    if (ok.length === 0)
      throw new ProblemException(
        'residency_denied',
        'no model provider is allowed for this organization under the residency policy',
        undefined,
        { evidenceRef: Object.values(evidence)[0] },
      );
    const bal = await this.budgets.credits(orgId);
    if (BigInt(bal.availableCredits) < 1n)
      throw new ProblemException('insufficient_credits', 'the credit balance is empty');
  }

  async invoke(call: GatewayCall): Promise<GatewayResult> {
    const orgId = call.orgId;
    if (await this.flags.killSwitch(orgId))
      throw new ProblemException('ai_unavailable', 'AI is switched off by the kill switch');
    if (!Number.isInteger(call.maxTokens) || call.maxTokens < 1 || call.maxTokens > 200_000)
      throw new ProblemException('validation_failed', 'maxTokens must be 1..200000');

    // 0. tool requests: well-formed specs are checked BEFORE anything is reserved or sent (a malformed one is the caller's bug, not a provider error)
    if (call.tools || call.toolChoice !== undefined || call.maxToolCalls !== undefined) {
      const problems = toolSpecProblems(call.tools);
      if (!call.tools) problems.push('toolChoice and maxToolCalls need tools');
      if (problems.length)
        throw new ProblemException('validation_failed', problems.slice(0, 4).join('; '));
    }

    // 1. secret scan on the OUTBOUND prompt (messages, tool calls and tool RESULTS, tool specs): block, never redact-and-send
    const prompt = promptText(call);
    const findings = scanForSecrets(prompt, this.cfg.canaries);
    if (findings.length) {
      const kinds = [...new Set(findings.map((f) => f.kind))];
      await this.audit.record({
        action: 'ai.secret_scan.blocked',
        orgId,
        actorType: 'system',
        ...(call.actorUserId ? { actorUserId: call.actorUserId } : {}),
        resource: { type: 'ai_call', id: call.callId },
        outcome: 'failure',
        detail: { kinds, task: call.task, runId: call.runId ?? null },
      });
      await this.recordUsage(call, {
        providerCode: 'none',
        modelRef: 'none',
        tokensIn: 0,
        tokensOut: 0,
        estimated: false,
        credits: 0n,
        outcome: 'blocked',
        errorCode: 'secret_detected',
        region: 'none',
        costMinor: 0n,
        costCurrency: null,
      });
      throw new ProblemException('secret_detected', `the prompt contains ${kinds.join(', ')}`);
    }

    // 2. candidates, residency, data terms, ranking
    const offers = await this.offers();
    if (offers.length === 0)
      throw new ProblemException(
        'unsupported_capability',
        'no model provider is enabled with a rate card (D-18, HG-09-01)',
      );
    const providers = [...new Map(offers.map((o) => [o.provider.code, o.provider])).values()];
    const { map: residency, evidence } = await this.verdicts(orgId, call.dataClass, providers);
    const promptTokens =
      estimateTokens(call.messages as ModelMessage[]) +
      (call.tools ? Math.ceil(JSON.stringify(call.tools).length / 4) : 0);
    const routed = routeModels(
      {
        capability: call.capability,
        ...(call.tools
          ? {
              alsoRequires: [
                'tool-use',
                ...(call.stream ? ['streaming-tool-calls'] : []),
                // more than one call per response is routed only to a model that declares (and, for a real provider, has verified) parallel calls
                ...((call.maxToolCalls ?? 1) > 1 ? ['parallel-tool-calls'] : []),
              ] as Capability[],
            }
          : {}),
        promptTokens,
        maxTokens: call.maxTokens,
        dataClass: call.dataClass,
        residency,
        allowUnattestedForSensitive: this.cfg.allowUnattestedForSensitive,
        reservableCredits: null,
      },
      offers.map((o) => o.candidate),
      (c, p, m) => reservationFor(c.rate, p, m),
    );
    if (routed.ranked.length === 0) {
      const reasons = new Set(routed.excluded.map((e) => e.reason));
      if (reasons.has('residency') && !reasons.has('capability') && !reasons.has('context'))
        throw new ProblemException(
          'residency_denied',
          'no model provider is allowed for this data under the residency policy',
          undefined,
          { evidenceRef: Object.values(evidence)[0] },
        );
      if (reasons.has('data_terms') || reasons.has('class_not_allowed'))
        throw new ProblemException(
          'residency_denied',
          'the data terms of the available model providers do not allow this class of content',
        );
      throw new ProblemException(
        'unsupported_capability',
        `no model matches (${[...reasons].join(', ') || 'none'})`,
      );
    }

    // 3. reserve + call, with budget-aware fallback over the ALREADY-ALLOWED ranked list; the approved-fallback policy can only narrow that list (never widen it)
    let firstDenied: BudgetDenied | null = null;
    let lastError: ModelAdapterError | null = null;
    let circuitSkipped = 0;
    // a provider whose own SPENDING limit answered (a rate_limited error that is not retryable) refuses every model of its account: its other models are not tried
    const spendLimited = new Set<string>();
    const { retry, breaker, health } = this.resilience;
    const candidates = applyFallbackPolicy(
      routed.ranked.map((ranked) => ({
        providerCode: ranked.candidate.providerCode,
        modelId: ranked.candidate.modelId,
        ranked,
      })),
      this.cfg.fallbackPolicy,
    ).map((x) => x.ranked);
    for (const r of candidates) {
      const offer = offers.find(
        (o) =>
          o.candidate.providerCode === r.candidate.providerCode &&
          o.candidate.modelId === r.candidate.modelId,
      )!;
      const key = candidateKey(r.candidate); // provider/model: health samples
      const pkey = r.candidate.providerCode; // provider: the circuit (an outage hits every model of a provider)
      if (spendLimited.has(pkey)) continue;
      // an open circuit refuses the candidate BEFORE a reservation is taken: nothing is held for a provider that is known to be failing
      if (!breaker.acquire(pkey)) {
        circuitSkipped++;
        continue;
      }
      // acquire is paired with a success or failure per ATTEMPT (so a half-open circuit's single trial is one request), or with a release when no attempt was made
      let released = false;
      const releaseBreaker = () => {
        if (released) return;
        released = true;
        breaker.release(pkey);
      };
      let reservation: Reservation;
      const subCallId = `${call.callId}@${r.candidate.providerCode}/${r.candidate.modelId}`; // one reservation per candidate (a released one is never reused)
      try {
        reservation = await this.budgets.reserve({
          orgId,
          callId: subCallId,
          ...(call.runId ? { runId: call.runId } : {}),
          ...(call.projectId ? { projectId: call.projectId } : {}),
          credits: r.reservationCredits,
          tokens: BigInt(promptTokens + call.maxTokens),
          ...(call.runBudget ? { runBudget: call.runBudget } : {}),
        });
      } catch (e) {
        releaseBreaker();
        if (e instanceof BudgetDenied) {
          firstDenied ??= e;
          continue; // a cheaper allowed candidate may still fit
        }
        throw e;
      }
      const started = Date.now();
      let delivered = 0; // chunks handed to the caller: a stream that fails after that point is not retried, so no delta is ever delivered twice
      for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.cfg.callTimeoutMs);
        const onAbort = () => ac.abort();
        call.signal?.addEventListener('abort', onAbort);
        // a signal that was ALREADY aborted never fires its event: without this the call would go out although the caller had cancelled
        if (call.signal?.aborted) ac.abort();
        const attemptStarted = Date.now();
        let backoffMs: number | undefined;
        try {
          const callCtx = { callId: `${call.callId}#${attempt}`, signal: ac.signal };
          const request = {
            model: r.candidate.modelId,
            messages: call.messages as ModelMessage[],
            maxTokens: call.maxTokens,
            responseFormat: call.responseFormat ?? 'text',
            task: call.task,
            ...(call.tools
              ? {
                  tools: call.tools,
                  ...(call.toolChoice !== undefined ? { toolChoice: call.toolChoice } : {}),
                  ...(call.maxToolCalls !== undefined ? { maxToolCalls: call.maxToolCalls } : {}),
                }
              : {}),
          };
          let resp: Pick<CompleteResponse, 'text' | 'finishReason' | 'usage' | 'toolCalls'>;
          if (call.stream) {
            const model = offer.adapter.models().find((m) => m.modelId === r.candidate.modelId)!;
            resp = await assembleStream(offer.adapter.stream(callCtx, request), {
              ...(call.tools ? { tools: call.tools } : {}),
              maxCalls: call.tools ? allowedToolCalls(model, request) : 1,
              onChunk: (ch: StreamChunk) => {
                delivered++;
                call.onChunk?.(ch);
              },
            });
          } else resp = await offer.adapter.complete(callCtx, request);
          // the provider answered: health and breaker learn it before the (database-bound) settlement can fail for reasons that are not the provider's
          health.recordSuccess(key, Date.now() - attemptStarted);
          health.recordSuccess(pkey, Date.now() - attemptStarted);
          breaker.success(pkey);
          return await this.settle(
            call,
            offer,
            reservation,
            resp,
            Date.now() - started,
            evidence[offer.provider.code] ?? null,
            prompt,
          );
        } catch (e) {
          if (e instanceof ModelAdapterError) {
            lastError = e;
            health.recordFailure(key, e.code, Date.now() - attemptStarted);
            health.recordFailure(pkey, e.code, Date.now() - attemptStarted);
            // only a failure that speaks for the provider's health counts toward the circuit; a cancel or a filtered request just frees a half-open trial slot
            breaker.failure(pkey, e.code);
            if (e.code === 'aborted') {
              await this.budgets.release(orgId, reservation.id);
              await this.recordUsage(call, {
                providerCode: offer.provider.code,
                modelRef: `${offer.provider.code}/${r.candidate.modelId}`,
                tokensIn: 0,
                tokensOut: 0,
                estimated: false,
                credits: 0n,
                outcome: 'error',
                errorCode: 'aborted',
                region: offer.provider.region,
                costMinor: 0n,
                costCurrency: null,
              }).catch(() => undefined);
              throw new ProblemException('conflict', 'the call was cancelled');
            }
            if (e.code === 'content_filtered') {
              await this.budgets.release(orgId, reservation.id);
              await this.recordUsage(call, {
                providerCode: offer.provider.code,
                modelRef: `${offer.provider.code}/${r.candidate.modelId}`,
                tokensIn: 0,
                tokensOut: 0,
                estimated: false,
                credits: 0n,
                outcome: 'error',
                errorCode: e.code,
                region: offer.provider.region,
                costMinor: 0n,
                costCurrency: null,
              });
              throw new ProblemException(
                'content_blocked',
                'the model provider refused the content',
              );
            }
            if (delivered > 0) {
              // the caller already has part of the answer: neither a retry nor another candidate may repeat it
              await this.budgets.release(orgId, reservation.id);
              throw new ProblemException(
                'service_unavailable',
                `the model stream failed after it had started (${e.code})`,
              );
            }
            // same reservation: a retry never costs a second hold. The wait honours the provider's Retry-After up to the policy cap; a longer hint means "fail over instead".
            // a circuit that this very failure opened ends the retries on this candidate too (a half-open trial is ONE request)
            const wait = breaker.state(pkey) === 'open' ? null : retryDelayMs(retry, attempt, e);
            if (wait === null) break;
            backoffMs = wait;
          } else {
            releaseBreaker();
            await this.budgets.release(orgId, reservation.id);
            throw e;
          }
        } finally {
          clearTimeout(timer);
          call.signal?.removeEventListener('abort', onAbort);
        }
        if (backoffMs !== undefined && backoffMs > 0) {
          try {
            await abortableSleep(backoffMs, call.signal);
          } catch {
            // the caller cancelled while the call was waiting to be retried: nothing was sent for this attempt
            releaseBreaker();
            await this.budgets.release(orgId, reservation.id);
            await this.recordUsage(call, {
              providerCode: offer.provider.code,
              modelRef: `${offer.provider.code}/${r.candidate.modelId}`,
              tokensIn: 0,
              tokensOut: 0,
              estimated: false,
              credits: 0n,
              outcome: 'error',
              errorCode: 'aborted',
              region: offer.provider.region,
              costMinor: 0n,
              costCurrency: null,
            }).catch(() => undefined);
            throw new ProblemException('conflict', 'the call was cancelled');
          }
        }
      }
      // this candidate failed: no billable result — release and fall back to the next ALLOWED candidate
      if (lastError?.code === 'rate_limited' && !lastError.retryable) spendLimited.add(pkey);
      await this.budgets.release(orgId, reservation.id);
      await this.recordUsage(
        call,
        {
          providerCode: offer.provider.code,
          modelRef: `${offer.provider.code}/${r.candidate.modelId}`,
          tokensIn: 0,
          tokensOut: 0,
          estimated: false,
          credits: 0n,
          outcome: 'error',
          errorCode: lastError?.code ?? 'unavailable',
          region: offer.provider.region,
          costMinor: 0n,
          costCurrency: null,
        },
        `${call.callId}!${offer.provider.code}`,
      ).catch(() => undefined);
    }
    if (firstDenied) {
      throw new ProblemException(
        firstDenied.level === 'balance' ? 'insufficient_credits' : 'budget_exceeded',
        firstDenied.level === 'balance'
          ? 'the credit balance cannot cover this call'
          : `the ${firstDenied.level} budget cannot cover this call`,
        undefined,
        { level: firstDenied.level, reason: firstDenied.reason },
      );
    }
    throw new ProblemException(
      'service_unavailable',
      lastError === null && circuitSkipped > 0
        ? 'the model providers are temporarily paused after repeated failures (circuit open): try again shortly'
        : `the model providers are unavailable (${lastError?.code ?? 'unknown'}${lastError ? `: ${lastError.message}` : ''})`,
    );
  }

  /** Reconcile with what the provider reports (or a FLAGGED estimate), charge the wallet once, write the usage row and the metering events. */
  private async settle(
    call: GatewayCall,
    offer: Offer,
    reservation: Reservation,
    resp: {
      text: string;
      finishReason: 'stop' | 'length' | 'refusal' | 'tool_calls';
      usage: { inputTokens: number; outputTokens: number } | null;
      toolCalls?: { id: string; name: string; args: unknown }[];
    },
    latencyMs: number,
    evidence: string | null,
    prompt: string,
  ): Promise<GatewayResult> {
    const { orgId } = call;
    const estimated = resp.usage === null;
    // tool calls the model asked for are output tokens too: a flagged estimate counts their names and arguments
    const callChars = (resp.toolCalls ?? []).reduce(
      (n, c) => n + c.name.length + JSON.stringify(c.args ?? {}).length,
      0,
    );
    const tin =
      resp.usage?.inputTokens ??
      offer.adapter.tokenCount(offer.candidate.modelId, call.messages as ModelMessage[]) +
        (call.tools ? Math.ceil(JSON.stringify(call.tools).length / 4) : 0);
    const tout = resp.usage?.outputTokens ?? Math.ceil((resp.text.length + callChars) / 4);
    const credits = creditsFor(offer.candidate.rate, tin, tout);
    const cost = providerCostMinor(offer.adapter.pricing, tin, tout);

    // wallet drawdown: ONE posting per call id (the ledger dedupes on the key). The reservation already proved the balance covers the worst case.
    if (credits > 0n) {
      await this.ledger.post(
        recipes.usageChargeWallet({
          orgId,
          netMinor: (credits * BigInt(this.cfg.creditUnitMinor)).toString(),
          currency: this.cfg.currency,
          meterId: 'ai.credits_consumed',
          sourceEventId: call.callId,
          description: `AI ${call.task} (${offer.provider.code}/${offer.candidate.modelId})`,
        }),
        `ai:call:${orgId}:${call.callId}`,
        call.actorUserId,
      );
    }
    const modelRef = `${offer.provider.code}/${offer.candidate.modelId}`;
    const budget = await this.budgets.org(orgId);
    const body = budget.logBodies
      ? await this.cipher.encryptJson(
          {
            prompt,
            response: resp.text,
            ...(resp.toolCalls?.length ? { toolCalls: resp.toolCalls } : {}),
          },
          { column: 'ai.model_usage.body_enc', row: `${orgId}:${call.callId}` },
        )
      : null;
    // the usage transaction takes the balance lock FIRST (the same order as reserve and release: DEFECT-7) and is rerun when PostgreSQL aborts it for a deadlock: the ledger debit above
    // is already committed (idempotent on its key), so a settle that gave up would leave a charge with no usage record. If every attempt fails the failure is audited and thrown.
    const dup = await withDeadlockRetry(() =>
      this.db.withOrg(orgId, async (c) => {
        await this.budgets.lockBalanceRow(c, orgId);
        const ins = await c.query(
          `INSERT INTO ai.model_usage (id, org_id, run_id, project_id, call_id, provider_code, model_ref, task, run_kind, tokens_in, tokens_out, estimated, cost_minor, cost_currency, credits, outcome, latency_ms, data_region, residency_evidence, body_enc, body_expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'ok',$16,$17,$18,$19, CASE WHEN $19::text IS NULL THEN NULL ELSE now() + make_interval(days => $20) END, $21)
         ON CONFLICT (org_id, call_id) DO NOTHING RETURNING id`,
          [
            uuidv7(),
            orgId,
            call.runId ?? null,
            call.projectId ?? null,
            call.callId,
            offer.provider.code,
            modelRef,
            call.task,
            call.runKind ?? null,
            tin,
            tout,
            estimated,
            cost.toString(),
            offer.adapter.pricing.currency,
            credits.toString(),
            latencyMs,
            offer.provider.region,
            evidence,
            body,
            budget.bodyRetentionDays ?? 1,
            reservation.createdAt,
          ],
        );
        const first = ins.rows.length === 1;
        if (first) {
          const at = reservation.createdAt.toISOString();
          const base = {
            orgId,
            unit: 'token',
            windowStart: at,
            windowEnd: at,
            occurredAt: at,
            dataRegion: offer.provider.region,
            source: 'ai@M09',
            resourceId: call.callId,
            ...(call.runId ? { tags: { run_id: call.runId } } : {}),
          };
          const dims = { model_id: modelRef, region: offer.provider.region };
          if (tin > 0)
            await emitUsage(c, {
              ...base,
              eventId: usageEventId({
                orgId,
                meterId: 'ai.tokens_input',
                resourceId: call.callId,
                windowStart: at,
              }),
              meterId: 'ai.tokens_input',
              quantity: String(tin),
              dimensions: { ...dims, ...(estimated ? { estimated: 'true' } : {}) },
            });
          if (tout > 0)
            await emitUsage(c, {
              ...base,
              eventId: usageEventId({
                orgId,
                meterId: 'ai.tokens_output',
                resourceId: call.callId,
                windowStart: at,
              }),
              meterId: 'ai.tokens_output',
              quantity: String(tout),
              dimensions: { ...dims, ...(estimated ? { estimated: 'true' } : {}) },
            });
          if (credits > 0n)
            await emitUsage(c, {
              ...base,
              unit: 'credit',
              eventId: usageEventId({
                orgId,
                meterId: 'ai.credits_consumed',
                resourceId: call.callId,
                windowStart: at,
              }),
              meterId: 'ai.credits_consumed',
              quantity: credits.toString(),
              dimensions: { run_kind: call.runKind ?? call.task },
              tags: { settlement: 'wallet', ...(call.runId ? { run_id: call.runId } : {}) },
            });
          if (call.runId)
            await c.query(
              `UPDATE ai.runs SET spent_credits = spent_credits + $3, tokens_in = tokens_in + $4, tokens_out = tokens_out + $5, model_ref = $6 WHERE org_id=$1 AND id=$2`,
              [orgId, call.runId, credits.toString(), tin, tout, modelRef],
            );
        }
        const rel = await c.query(
          `UPDATE ai.reservations SET state='settled', settled_credits=$2, closed_at=now() WHERE id=$1 AND state='held' RETURNING credits, run_id`,
          [reservation.id, credits.toString()],
        );
        if (rel.rows[0]) {
          await c.query(
            `UPDATE ai.credit_balances SET reserved_credits = greatest(0, reserved_credits - $3) WHERE org_id=$1 AND currency=$2`,
            [orgId, this.cfg.currency, String(rel.rows[0].credits)],
          );
          if (rel.rows[0].run_id)
            await c.query(
              `UPDATE ai.runs SET reserved_credits = greatest(0, reserved_credits - $3) WHERE org_id=$1 AND id=$2`,
              [orgId, rel.rows[0].run_id, String(rel.rows[0].credits)],
            );
        }
        return !first;
      }),
    ).catch(async (e: unknown) => {
      // the debit is committed but the usage record could not be written: never silent (an operator reconciles `ai:call:*` ledger entries without a usage row)
      await Promise.resolve(
        this.audit.record({
          action: 'ai.settle.incomplete',
          actorType: 'system',
          resource: { type: 'ai_call', id: call.callId },
          outcome: 'failure',
          detail: {
            orgId,
            callId: call.callId,
            code: (e as { code?: string } | null)?.code ?? 'error',
          },
        }),
      ).catch(() => undefined);
      throw e;
    });
    // tool calls are validated against the DECLARED tools and their schemas; nothing is run. Calls without declared tools cannot exist: they are dropped.
    const checked =
      call.tools && resp.toolCalls?.length ? validateToolCalls(call.tools, resp.toolCalls) : null;
    return {
      text: resp.text,
      finishReason: call.tools
        ? resp.finishReason
        : resp.finishReason === 'tool_calls'
          ? 'stop'
          : resp.finishReason,
      ...(checked?.valid.length ? { toolCalls: checked.valid } : {}),
      ...(checked?.rejected.length ? { rejectedToolCalls: checked.rejected } : {}),
      tokensIn: tin,
      tokensOut: tout,
      estimated,
      credits,
      providerCode: offer.provider.code,
      modelRef,
      region: offer.provider.region,
      callId: call.callId,
      duplicate: dup,
    };
  }

  private async recordUsage(
    call: GatewayCall,
    u: {
      providerCode: string;
      modelRef: string;
      tokensIn: number;
      tokensOut: number;
      estimated: boolean;
      credits: bigint;
      outcome: 'error' | 'blocked';
      errorCode: string;
      region: string;
      costMinor: bigint;
      costCurrency: string | null;
    },
    idOverride?: string,
  ): Promise<void> {
    await this.db.withOrg(call.orgId, (c) =>
      c.query(
        `INSERT INTO ai.model_usage (id, org_id, run_id, project_id, call_id, provider_code, model_ref, task, run_kind, tokens_in, tokens_out, estimated, cost_minor, cost_currency, credits, outcome, error_code, data_region)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (org_id, call_id) DO NOTHING`,
        [
          uuidv7(),
          call.orgId,
          call.runId ?? null,
          call.projectId ?? null,
          idOverride ?? `${call.callId}!${u.outcome}`,
          u.providerCode,
          u.modelRef,
          call.task,
          call.runKind ?? null,
          u.tokensIn,
          u.tokensOut,
          u.estimated,
          u.costMinor.toString(),
          u.costCurrency,
          u.credits.toString(),
          u.outcome,
          u.errorCode,
          u.region,
        ],
      ),
    );
  }
  /** for the redaction proof in tests: a stable fingerprint of a prompt without storing it */
  static fingerprint(s: string) {
    return sha(s);
  }
}

/** Everything that is sent to the provider as text, for the outbound secret scan: messages, the text of their blocks (tool calls and tool RESULTS), and the tool specs. */
function promptText(call: GatewayCall): string {
  const parts: string[] = [];
  for (const m of call.messages) {
    parts.push(m.content);
    for (const b of m.blocks ?? [])
      parts.push(
        b.type === 'text'
          ? b.text
          : b.type === 'tool_call'
            ? `${b.name} ${JSON.stringify(b.args ?? null)}`
            : b.content,
      );
  }
  if (call.tools) parts.push(JSON.stringify(call.tools));
  return parts.join('\n');
}
