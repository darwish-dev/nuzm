/**
 * The owner's decisions that must be RECORDED before any live call to a provider (S-AG4, Phase 2). A live run refuses to start unless every decision below has an evidence row for the
 * provider and the environment. Evidence rows are written by a HUMAN (the owner or the Master on the owner's word) after the decision exists; nothing in this repository creates one,
 * and a row never contains a credential: a row that looks like it carries one is refused.
 *
 * | id | decision | blocks |
 * | D2 | the vendor agreement and data terms (retention, training, processing region) are reviewed and attested | any real prompt |
 * | D3 | the provider is approved for live calls in THIS environment (`AI_LIVE_PROVIDERS`) | any live call |
 * | D4 | a dedicated key exists, is held by a named owner, and has a vendor-side monthly spend cap | any live call |
 * | D5 | the residency / processing-region position is decided (what may be sent, what must not) | any real prompt |
 * | D6 | the commercial rate card and margin are decided (credits per million tokens) | selling, and cost reconciliation |
 * | D9 | the bounded probe / verification run itself is approved, with a token and money ceiling | the run |
 */
export const LIVE_REQUIRED_DECISIONS = ['D2', 'D3', 'D4', 'D5', 'D6', 'D9'] as const;
export type LiveDecisionId = (typeof LIVE_REQUIRED_DECISIONS)[number];

export interface LiveEvidenceRow {
  decision: LiveDecisionId;
  /** where the decision is recorded (a decision-log entry, a ticket, a signed document id): never a secret */
  ref: string;
  recordedBy: string;
  /** ISO 8601 instant the decision was recorded */
  recordedAt: string;
  /** provider code the decision covers (`anthropic`) */
  provider: string;
  environment: 'non-production';
  /** `approved` stands; `withdrawn` revokes an earlier approval of the same decision */
  outcome: 'approved' | 'withdrawn';
}

export interface EvidenceVerdict {
  ok: boolean;
  /** one fixed sentence per problem, never the content of a row */
  problems: string[];
  /** the decisions that stand (approved and not withdrawn later) */
  standing: LiveDecisionId[];
}

const PLACEHOLDER = /^(tbd|todo|n\/a|na|none|null|pending|xxx+|\?+|-+)$/i;
const KEY_LIKE =
  /sk-ant-|sk-[A-Za-z0-9]{20,}|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]{16,}|-----BEGIN/i;

const isRow = (r: unknown): r is Record<string, unknown> =>
  typeof r === 'object' && r !== null && !Array.isArray(r);

/**
 * Judges a list of evidence rows for one provider and the current environment. Pure: reads nothing, sends nothing. A decision stands only if its LATEST row for this provider
 * says `approved`; every problem is reported (a fixed sentence per problem) so the operator can fix them all at once.
 */
export function assessLiveEvidence(
  rows: unknown,
  ctx: { provider: string; now?: Date; nodeEnv?: string },
): EvidenceVerdict {
  const problems: string[] = [];
  const now = ctx.now ?? new Date();
  if ((ctx.nodeEnv ?? process.env.NODE_ENV) === 'production')
    problems.push(
      'a live verification never runs in a production process (the production vault is not decided, D-12)',
    );
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      problems: [...problems, 'the evidence is missing or is not a list of rows'],
      standing: [],
    };
  }
  const latest = new Map<LiveDecisionId, { at: number; outcome: string }>();
  rows.forEach((raw, i) => {
    const n = i + 1;
    if (!isRow(raw)) return void problems.push(`row ${n}: not an object`);
    const { decision, ref, recordedBy, recordedAt, provider, environment, outcome } = raw;
    if (!LIVE_REQUIRED_DECISIONS.includes(decision as LiveDecisionId))
      return void problems.push(`row ${n}: unknown decision id`);
    let bad = false;
    const flag = (m: string) => {
      bad = true;
      problems.push(`row ${n} (${String(decision)}): ${m}`);
    };
    if (
      typeof ref !== 'string' ||
      ref.trim().length < 3 ||
      ref.length > 200 ||
      PLACEHOLDER.test(ref.trim())
    )
      flag('the reference is missing or a placeholder');
    if (
      typeof recordedBy !== 'string' ||
      recordedBy.trim().length < 2 ||
      PLACEHOLDER.test(recordedBy.trim())
    )
      flag('who recorded it is missing or a placeholder');
    const at = typeof recordedAt === 'string' ? Date.parse(recordedAt) : NaN;
    if (!Number.isFinite(at) || !/^\d{4}-\d{2}-\d{2}T/.test(String(recordedAt)))
      flag('recordedAt is not an ISO 8601 instant');
    else if (at > now.getTime() + 60_000) flag('recordedAt is in the future');
    if (provider !== ctx.provider) flag('the row is for another provider');
    if (environment !== 'non-production') flag('the row is not for the non-production environment');
    if (outcome !== 'approved' && outcome !== 'withdrawn')
      flag('outcome must be approved or withdrawn');
    if (Object.values(raw).some((v) => typeof v === 'string' && KEY_LIKE.test(v)))
      flag('the row looks as if it carries a credential: evidence holds references only');
    if (bad) return;
    const d = decision as LiveDecisionId;
    const prev = latest.get(d);
    if (!prev || at >= prev.at) latest.set(d, { at, outcome: outcome as string });
  });
  const standing: LiveDecisionId[] = [];
  for (const d of LIVE_REQUIRED_DECISIONS) {
    const l = latest.get(d);
    if (!l) problems.push(`${d}: no valid evidence row`);
    else if (l.outcome !== 'approved') problems.push(`${d}: the latest row withdraws the approval`);
    else standing.push(d);
  }
  return { ok: problems.length === 0, problems, standing };
}

/** Throws `LiveRunRefused` (listing every problem) unless the evidence is complete. */
export function assertLiveEvidence(
  rows: unknown,
  ctx: { provider: string; now?: Date; nodeEnv?: string },
): EvidenceVerdict {
  const v = assessLiveEvidence(rows, ctx);
  if (!v.ok) throw new LiveRunRefused(v.problems);
  return v;
}

export class LiveRunRefused extends Error {
  constructor(readonly problems: string[]) {
    super(`live run refused: ${problems.join('; ')}`);
    this.name = 'LiveRunRefused';
  }
}
