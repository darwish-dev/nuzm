import { describe, expect, it } from 'vitest';
import { OrgBudgetPort } from '../ports/m09';
import { SandboxService } from './sandbox.service';
import { MockSandboxRuntime } from './mock-runtime';
import {
  budgetRefusalMessage,
  resolveBudget,
  SANDBOX_PURPOSES,
  type PurposeBudget,
} from './budget-gate';

/**
 * Budget gate selection by explicit purpose. The service is built with stubs; the database stub throws a sentinel, so "REACHED_DB" means the budget gate admitted the start
 * (everything before the database insert passed) and any other outcome is the refusal under test.
 */
class Wallet extends OrgBudgetPort {
  asked = 0;
  constructor(private readonly minor: number) {
    super();
  }
  async remainingMinor(): Promise<number> {
    this.asked++;
    return this.minor;
  }
}
class BuildAllowance extends Wallet {
  readonly gate = 'build_allowance' as const;
}
const project = { id: 'p1', type: 'webapp' } as never;
const mk = (
  wallet: OrgBudgetPort,
  byPurpose: Partial<Record<(typeof SANDBOX_PURPOSES)[number], PurposeBudget>> = {},
) =>
  new SandboxService(
    {
      withOrg: async () => {
        throw new Error('REACHED_DB');
      },
    } as never,
    { record: async () => undefined } as never,
    new MockSandboxRuntime(),
    { evaluate: async () => ({ decision: 'allow', reasons: [] }) } as never,
    wallet,
    {} as never,
    undefined,
    undefined,
    byPurpose,
  );
const outcome = async (
  p: Promise<unknown>,
): Promise<{ code?: string; detail?: string; reached?: true }> => {
  try {
    await p;
  } catch (e) {
    if ((e as Error).message === 'REACHED_DB') return { reached: true };
    const x = e as { code?: string; detail?: string };
    return { code: x.code, detail: x.detail };
  }
  return {};
};
const NO_CREDIT = 'the organization has no AI credit left for a sandbox';
const NO_ALLOWANCE = 'the build allowance of the plan is used up; new builds are blocked';

describe('sandbox budget gate chosen by purpose (CONTRACT-S05-P2-3)', () => {
  it('DEFAULT unchanged: with no per-purpose gate every purpose is judged by the AI wallet, and a refusal says so', async () => {
    for (const purpose of SANDBOX_PURPOSES) {
      const empty = new Wallet(0);
      expect(await outcome(mk(empty).create('o', 'u', project, {}, purpose))).toEqual({
        code: 'budget_required',
        detail: NO_CREDIT,
      });
      expect(empty.asked).toBe(1);
      expect(await outcome(mk(new Wallet(5)).create('o', 'u', project, {}, purpose))).toEqual({
        reached: true,
      });
    }
  });
  it('the purpose defaults to user_sandbox and the old 4-argument call behaves exactly as before', async () => {
    expect(await outcome(mk(new Wallet(0)).create('o', 'u', project, {}))).toEqual({
      code: 'budget_required',
      detail: NO_CREDIT,
    });
    expect(await outcome(mk(new Wallet(1)).create('o', 'u', project, {}))).toEqual({
      reached: true,
    });
  });
  it('a configured release_build gate (build allowance) replaces the wallet for that purpose only, and names itself in the refusal', async () => {
    const wallet = new Wallet(0);
    const allowance = new BuildAllowance(1);
    const byPurpose = { release_build: { port: allowance, gate: 'build_allowance' as const } };
    // wallet empty, allowance open: a release build is admitted without asking the wallet
    expect(
      await outcome(mk(wallet, byPurpose).create('o', 'u', project, {}, 'release_build')),
    ).toEqual({ reached: true });
    expect(wallet.asked).toBe(0);
    // the other purposes still use the wallet
    expect(
      await outcome(mk(wallet, byPurpose).create('o', 'u', project, {}, 'user_sandbox')),
    ).toEqual({ code: 'budget_required', detail: NO_CREDIT });
    expect(
      await outcome(mk(wallet, byPurpose).create('o', 'u', project, {}, 'ai_run_build')),
    ).toEqual({ code: 'budget_required', detail: NO_CREDIT });
    // allowance used up while the wallet has credit: refused, with the allowance message, wallet not consulted
    const rich = new Wallet(100);
    const spent = {
      release_build: { port: new BuildAllowance(0), gate: 'build_allowance' as const },
    };
    expect(await outcome(mk(rich, spent).create('o', 'u', project, {}, 'release_build'))).toEqual({
      code: 'budget_required',
      detail: NO_ALLOWANCE,
    });
    expect(rich.asked).toBe(0);
  });
  it('the existing wiring (a second instance whose only budget port names its gate) reports the allowance message too', async () => {
    expect(
      await outcome(mk(new BuildAllowance(0)).create('o', 'u', project, {}, 'release_build')),
    ).toEqual({ code: 'budget_required', detail: NO_ALLOWANCE });
    expect(
      await outcome(mk(new BuildAllowance(1)).create('o', 'u', project, {}, 'release_build')),
    ).toEqual({ reached: true });
  });
  it('the purpose is never taken from the request body, and an unknown purpose is refused', async () => {
    const byPurpose = {
      release_build: { port: new BuildAllowance(1), gate: 'build_allowance' as const },
    };
    const forged = { purpose: 'release_build' } as never;
    expect(await outcome(mk(new Wallet(0), byPurpose).create('o', 'u', project, forged))).toEqual({
      code: 'budget_required',
      detail: NO_CREDIT,
    });
    expect(
      await outcome(mk(new Wallet(9)).create('o', 'u', project, {}, 'constructor' as never)),
    ).toEqual({ code: 'validation_failed', detail: 'unknown sandbox purpose' });
    expect(
      await outcome(mk(new Wallet(9)).create('o', 'u', project, {}, undefined as never)),
    ).toEqual({ reached: true }); // undefined = the default parameter
  });
  it('resolveBudget ignores inherited members and the refusal text names the gate', () => {
    const w = new Wallet(1);
    expect(resolveBudget('release_build', {}, w)).toEqual({ port: w, gate: 'ai_wallet' });
    expect(
      resolveBudget(
        'release_build',
        Object.create({ release_build: { port: new Wallet(9), gate: 'build_allowance' } }),
        w,
      ),
    ).toEqual({ port: w, gate: 'ai_wallet' });
    expect(budgetRefusalMessage('ai_wallet')).toBe(NO_CREDIT);
    expect(budgetRefusalMessage('build_allowance')).toBe(NO_ALLOWANCE);
  });
});
