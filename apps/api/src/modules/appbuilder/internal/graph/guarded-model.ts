import { validate, type Schema } from '../schema';
import {
  ModelNoCapacityError,
  ModelTimeoutError,
  type ModelGatewayPort,
  type OrgBudgetPort,
  type RunStorePort,
} from '../ports/m09';
import { BudgetExceeded, type BudgetLedger } from './budget';

export class RunCancelled extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'RunCancelled';
  }
}
export class ArtifactInvalid extends Error {
  constructor(
    readonly purpose: string,
    readonly errors: string[],
  ) {
    super(`model output for "${purpose}" is invalid: ${errors.slice(0, 5).join('; ')}`);
    this.name = 'ArtifactInvalid';
  }
}
export interface Spent {
  tokensIn: number;
  tokensOut: number;
  costMinor: number;
}
export const MAX_REPAIRS = 2;

/**
 * The budget enforcer in front of every gateway call (M10 §4 S42.4): cancellation check, pre-flight reservation, a hard timeout, settlement against the
 * provider-reported usage, persistence of the usage on the run, and schema validation of the structured output with at most two repair attempts (each a billed call).
 * After a TIMEOUT the outcome is uncertain, so the whole reservation is counted as spent (reconcile before any retry, CLAUDE.md §4).
 */
export class GuardedModel {
  /** Usage of the step in progress (the runner reads and resets it). */
  spent: Spent = { tokensIn: 0, tokensOut: 0, costMinor: 0 };
  constructor(
    private readonly gateway: ModelGatewayPort,
    private readonly runs: RunStorePort,
    private readonly ledger: BudgetLedger,
    private readonly orgBudget: OrgBudgetPort,
    private readonly base: { orgId: string; runId: string; dataRegion: string },
    private readonly isCancelled: () => Promise<boolean>,
    private readonly cfg: { timeoutMs: number },
  ) {}

  private async persist(d: Spent) {
    this.spent = {
      tokensIn: this.spent.tokensIn + d.tokensIn,
      tokensOut: this.spent.tokensOut + d.tokensOut,
      costMinor: this.spent.costMinor + d.costMinor,
    };
    await this.runs.addUsage(this.base.orgId, this.base.runId, d);
  }

  async ask<T>(a: {
    agent: string;
    purpose: string;
    input: unknown;
    schema: Schema;
    maxTokens: number;
    /** Semantic validation on top of the schema (e.g. the cross-references of an application spec); its messages drive the repair attempts too. */
    check?: (v: unknown) => string[];
  }): Promise<T> {
    let errors: string[] = [];
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      if (await this.isCancelled()) throw new RunCancelled();
      const rate = await this.gateway.rateMinorPer1kTokens(this.base.orgId);
      const remaining = await this.orgBudget.remainingMinor(this.base.orgId);
      const input = attempt === 0 ? a.input : { original: a.input, repair: { attempt, errors } };
      const est = Math.ceil(JSON.stringify(input).length / 4);
      const res = this.ledger.reserve(est, a.maxTokens, rate, remaining); // throws BudgetExceeded BEFORE anything is sent
      let resp;
      try {
        resp = await this.withTimeout(
          this.gateway.complete({
            orgId: this.base.orgId,
            runId: this.base.runId,
            agent: a.agent,
            purpose: a.purpose,
            input,
            maxTokens: a.maxTokens,
            schema: a.schema,
            timeoutMs: this.cfg.timeoutMs,
            dataClass: 'customer-content',
            dataRegion: this.base.dataRegion,
          }),
        );
      } catch (e) {
        if (e instanceof ModelNoCapacityError) {
          this.ledger.release(res); // nothing was consumed
          throw e;
        }
        const spent = this.ledger.settleUncertain(res); // timeout or unknown failure: conservative
        await this.persist({ tokensIn: 0, tokensOut: spent.tokens, costMinor: spent.costMinor });
        throw e instanceof ModelTimeoutError ? e : e;
      }
      this.ledger.settle(res, resp);
      await this.persist({
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        costMinor: resp.costMinor,
      });
      errors = validate(a.schema, resp.output);
      if (errors.length === 0 && a.check) errors = a.check(resp.output);
      if (errors.length === 0) return resp.output as T;
    }
    throw new ArtifactInvalid(a.purpose, errors);
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let t: NodeJS.Timeout;
    const timer = new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new ModelTimeoutError()), this.cfg.timeoutMs);
    });
    return Promise.race([p, timer]).finally(() => clearTimeout(t));
  }
}
export { BudgetExceeded };
