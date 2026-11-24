/** The owner approvals a LIVE run of each track depends on, and the check of a recorded-approvals file. Split out of `tracks.ts` so the production graph does not import the simulated runs. */
export type Track = 'C' | 'E';

/** the owner decisions and gates a LIVE run of each track depends on (docs/parallel/OWNER-DECISIONS.md, PHASE-2-PLAN.md) */
export const REQUIRED_APPROVALS: Record<Track, { id: string; what: string }[]> = {
  C: [
    { id: 'D2', what: 'a provider account and key for the model, sealed in the vault' },
    { id: 'D4', what: 'the model and its verified rate card' },
    { id: 'D5', what: 'the spending cap for the run' },
    { id: 'D6', what: 'the data-residency and data-terms decision for customer content' },
    { id: 'D9', what: 'permission for the live provider smoke/probe' },
  ],
  E: [
    { id: 'D-21', what: 'the sandbox runtime decision' },
    { id: 'HG-10-02', what: 'the human gate for real execution of customer code' },
    { id: 'ADR-067', what: 'the Execution Gateway accepted' },
    {
      id: 'ISOLATION-ATTESTATION',
      what: 'the isolation attestation of the target runtime (S04), whose reference the real port requires to start',
    },
  ],
};

export type EvidenceCheck = { ok: true } | { ok: false; missing: string[]; reason?: string };

/** The evidence file: `{ "track": "C", "approvals": [{ "id": "D2", "ref": "<where the owner's decision is recorded>", "recordedAt": "<ISO date>" }, ...] }`. Every required id needs a non-empty `ref` and a valid date. */
export function checkApprovalEvidence(track: Track, raw: unknown): EvidenceCheck {
  if (typeof raw !== 'object' || raw === null || (raw as { track?: unknown }).track !== track)
    return {
      ok: false,
      missing: REQUIRED_APPROVALS[track].map((a) => a.id),
      reason: `the evidence is not a record for track ${track}`,
    };
  const list = (raw as { approvals?: unknown }).approvals;
  const have = new Set<string>();
  if (Array.isArray(list))
    for (const a of list as { id?: unknown; ref?: unknown; recordedAt?: unknown }[])
      if (
        typeof a?.id === 'string' &&
        typeof a.ref === 'string' &&
        a.ref.trim().length >= 3 &&
        typeof a.recordedAt === 'string' &&
        !Number.isNaN(Date.parse(a.recordedAt))
      )
        have.add(a.id);
  const missing = REQUIRED_APPROVALS[track].map((a) => a.id).filter((id) => !have.has(id));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
