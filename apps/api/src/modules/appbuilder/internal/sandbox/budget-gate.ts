import type { OrgBudgetPort } from '../ports/m09';

/**
 * Which budget gate a sandbox start is judged by is chosen by the CALLER through an explicit `purpose`, not by which `SandboxService` instance happened to be injected.
 *  - `user_sandbox`  a person starts a sandbox from the console (HTTP `POST …/sandboxes`)
 *  - `release_build` the release/deployment pipeline builds an app
 *  - `ai_run_build`  an agent run builds or tests the project
 * DEFAULT BEHAVIOUR IS UNCHANGED: a purpose without a configured gate uses the service's own budget port (the AI wallet), exactly as before. A gate for a purpose is configured by the
 * composition root (for example the build allowance behind the `builder.billing_separation` switch, default off). The purpose is never taken from a request body.
 */
export const SANDBOX_PURPOSES = ['release_build', 'user_sandbox', 'ai_run_build'] as const;
export type SandboxPurpose = (typeof SANDBOX_PURPOSES)[number];
export type BudgetGateName = 'ai_wallet' | 'build_allowance';
export interface PurposeBudget {
  port: OrgBudgetPort;
  gate: BudgetGateName;
}
export const isSandboxPurpose = (v: unknown): v is SandboxPurpose =>
  typeof v === 'string' && (SANDBOX_PURPOSES as readonly string[]).includes(v);

/** a budget port may name its own gate (`gate = 'build_allowance'`) so that a service wired with such a port as its only budget still reports the right refusal */
const portGate = (p: OrgBudgetPort): BudgetGateName =>
  (p as { gate?: unknown }).gate === 'build_allowance' ? 'build_allowance' : 'ai_wallet';

export function resolveBudget(
  purpose: SandboxPurpose,
  byPurpose: Partial<Record<SandboxPurpose, PurposeBudget>>,
  fallback: OrgBudgetPort,
): PurposeBudget {
  const own = Object.prototype.hasOwnProperty.call(byPurpose, purpose)
    ? byPurpose[purpose]
    : undefined;
  return own ?? { port: fallback, gate: portGate(fallback) };
}

/** the refusal text names the gate that refused (the wallet and the build allowance are different things to the customer) */
export function budgetRefusalMessage(gate: BudgetGateName): string {
  return gate === 'build_allowance'
    ? 'the build allowance of the plan is used up; new builds are blocked'
    : 'the organization has no AI credit left for a sandbox';
}
