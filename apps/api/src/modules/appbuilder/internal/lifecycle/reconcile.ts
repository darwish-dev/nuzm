import type { Db } from '@nuzm/platform';

/**
 * Wallet reconciliation of one lifecycle run (P3-S03, acceptance L3): four independent records of what the run spent must say the same thing.
 *   1. the lifecycle's own accounting (tokens and credits it summed from the gateway's answers, kept in the run checkpoint);
 *   2. the gateway's usage rows (`ai.model_usage`, append-only, one per call id);
 *   3. the run's counters (`ai.runs.tokens_in/out`, `spent_credits`, updated in the settle transaction);
 *   4. the reservations (`ai.reservations`): every call reserves before it asks and settles or releases after; a `held` reservation at the end of a run is credit that is locked
 *      without a settled usage row (a crash between reserve and settle), and a settled one must carry exactly the credits of its usage row.
 * The wallet drawdown itself (a ledger posting per call id, ADR-061) is the gateway's own transaction; its equality with these numbers is asserted by the integration tests against
 * the ledger. A mismatch here is never auto-corrected: it is audited, shown in the evidence record and left for a person (corrections are reversing entries, CLAUDE.md §4).
 */
export interface RunUsageRows {
  calls: number;
  tokensIn: bigint;
  tokensOut: bigint;
  credits: bigint;
  /** provider cost in minor units; null when no usage row carries a price */
  costMinor: bigint | null;
  modelRefs: string[];
  /** at least one call went to a provider that is not a dev-reference `mock-*`/`local-*` one */
  realProvider: boolean;
  /** of the calls: how many ended in `ok` */
  okCalls: number;
}
export interface RunCounters {
  tokensIn: bigint;
  tokensOut: bigint;
  spentCredits: bigint;
}
export interface ReservationRows {
  held: number;
  settledCredits: bigint;
  settled: number;
}
export interface ReconcileCheck {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
}
export interface Reconciliation {
  ok: boolean;
  checks: ReconcileCheck[];
}

export function reconcile(
  state: { tokensIn: number; tokensOut: number; credits: string },
  usage: RunUsageRows,
  run: RunCounters | null,
  reservations: ReservationRows,
): Reconciliation {
  const checks: ReconcileCheck[] = [];
  const eq = (name: string, expected: bigint | number | string, actual: bigint | number | string) =>
    checks.push({
      name,
      expected: String(expected),
      actual: String(actual),
      ok: String(expected) === String(actual),
    });
  eq('state_tokens_in_equals_usage', state.tokensIn, usage.tokensIn);
  eq('state_tokens_out_equals_usage', state.tokensOut, usage.tokensOut);
  eq('state_credits_equals_usage', state.credits, usage.credits);
  if (run) {
    eq('run_credits_equals_usage', run.spentCredits, usage.credits);
    eq('run_tokens_equals_usage', run.tokensIn + run.tokensOut, usage.tokensIn + usage.tokensOut);
  } else
    checks.push({ name: 'run_row_present', expected: 'present', actual: 'missing', ok: false });
  eq('no_held_reservation_left', 0, reservations.held);
  eq('settled_reservations_equal_usage_credits', usage.credits, reservations.settledCredits);
  return { ok: checks.every((c) => c.ok), checks };
}

export async function readRunUsage(
  db: Db,
  orgId: string,
  runId: string,
): Promise<{ usage: RunUsageRows; run: RunCounters | null; reservations: ReservationRows }> {
  return db.withOrg(orgId, async (c) => {
    const u = (
      await c.query(
        `SELECT count(*)::int AS calls,
                count(*) FILTER (WHERE outcome = 'ok')::int AS ok_calls,
                coalesce(sum(tokens_in),0)::text AS ti, coalesce(sum(tokens_out),0)::text AS tout,
                coalesce(sum(credits),0)::text AS cr,
                CASE WHEN count(*) FILTER (WHERE cost_minor > 0) = 0 THEN NULL ELSE sum(cost_minor)::text END AS cost,
                coalesce(array_agg(DISTINCT model_ref), '{}') AS refs,
                coalesce(bool_or(provider_code !~ '^(mock|local)-'), false) AS real
           FROM ai.model_usage WHERE org_id = $1 AND run_id = $2`,
        [orgId, runId],
      )
    ).rows[0] as Record<string, unknown>;
    const r = (
      await c.query(
        `SELECT tokens_in::text AS ti, tokens_out::text AS tout, spent_credits::text AS sc FROM ai.runs WHERE org_id = $1 AND id = $2`,
        [orgId, runId],
      )
    ).rows[0] as Record<string, string> | undefined;
    const s = (
      await c.query(
        `SELECT count(*) FILTER (WHERE state = 'held')::int AS held,
                coalesce(sum(settled_credits) FILTER (WHERE state = 'settled'),0)::text AS sc,
                count(*) FILTER (WHERE state = 'settled')::int AS settled
           FROM ai.reservations WHERE org_id = $1 AND run_id = $2`,
        [orgId, runId],
      )
    ).rows[0] as Record<string, unknown>;
    return {
      usage: {
        calls: Number(u.calls),
        okCalls: Number(u.ok_calls),
        tokensIn: BigInt(String(u.ti)),
        tokensOut: BigInt(String(u.tout)),
        credits: BigInt(String(u.cr)),
        costMinor: u.cost === null ? null : BigInt(String(u.cost)),
        modelRefs: (u.refs as string[]) ?? [],
        realProvider: u.real === true,
      },
      run: r
        ? { tokensIn: BigInt(r.ti!), tokensOut: BigInt(r.tout!), spentCredits: BigInt(r.sc!) }
        : null,
      reservations: {
        held: Number(s.held),
        settledCredits: BigInt(String(s.sc)),
        settled: Number(s.settled),
      },
    };
  });
}
