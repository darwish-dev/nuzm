/** Pure helpers of the admin app-builder oversight screens (UI-M10-18/19). No I/O: unit-tested in `builder-admin.spec.ts`. METADATA only: no prompt, output or file content exists in these shapes. */

export type Tone = 'success' | 'warn' | 'danger' | undefined;

export interface AdminRunRow {
  id: string;
  orgId: string;
  kind: string;
  state: string;
  reason: string | null;
  dataRegion: string;
  createdAt: string | null;
  finishedAt: string | null;
  budget: { maxTokens: number; maxCostMinor: number; maxMinutes: number } | null;
  usage: { tokens: number; costMinor: number; steps: number } | null;
  flags: { budgetBreach: boolean; deniedApproval: boolean; escalated: boolean };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** One item of `GET /v1/admin/ai/runs` without trusting its shape; an item without an id is dropped. Only whitelisted metadata fields are read. */
export function adminRunOf(x: unknown): AdminRunRow | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const b = (r.budget ?? null) as Record<string, unknown> | null;
  const u = (r.usage ?? null) as Record<string, unknown> | null;
  const f = (r.flags ?? {}) as Record<string, unknown>;
  const mt = b ? num(b.maxTokens) : null;
  const mc = b ? num(b.maxCostMinor) : null;
  const mm = b ? num(b.maxMinutes) : null;
  return {
    id,
    orgId: str(r.orgId) ?? '',
    kind: str(r.kind) ?? '',
    state: str(r.state) ?? '',
    reason: str(r.reason),
    dataRegion: str(r.dataRegion) ?? '',
    createdAt: str(r.createdAt),
    finishedAt: str(r.finishedAt),
    budget:
      mt !== null && mc !== null && mm !== null
        ? { maxTokens: mt, maxCostMinor: mc, maxMinutes: mm }
        : null,
    usage: u
      ? {
          tokens: (num(u.tokensIn) ?? 0) + (num(u.tokensOut) ?? 0),
          costMinor: num(u.costMinor) ?? 0,
          steps: num(u.steps) ?? 0,
        }
      : null,
    flags: {
      budgetBreach: f.budgetBreach === true,
      deniedApproval: f.deniedApproval === true,
      escalated: f.escalated === true,
    },
  };
}

export const RUN_STATES = [
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'budget_exceeded',
] as const;
export const runStateOf = (v: string | undefined) => RUN_STATES.find((s) => s === v);

export const stateTone = (s: string): Tone =>
  s === 'succeeded'
    ? 'success'
    : s === 'failed' || s === 'budget_exceeded'
      ? 'danger'
      : s === 'waiting_approval' || s === 'cancelled'
        ? 'warn'
        : undefined;

export const anyFlag = (r: Pick<AdminRunRow, 'flags'>) =>
  r.flags.budgetBreach || r.flags.deniedApproval || r.flags.escalated;

/** Sandbox nodes of the resource inventory: the inventory has no kind filter, so rows whose `kind` names a sandbox are picked here. */
export const isSandboxKind = (kind: string) => /sandbox/i.test(kind);

export const shortId = (id: string) => id.slice(0, 8);
