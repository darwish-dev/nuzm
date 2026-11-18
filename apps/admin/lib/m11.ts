/** Pure helpers of the admin M11 screens (UI-M11-20..22). No I/O: unit-tested in `m11.spec.ts`. */

export const DECISIONS = ['approve', 'reject', 'suspend'] as const;
export type Decision = (typeof DECISIONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v.trim());
/** The API wants a snake_case code (2..64 characters, starting with a letter). */
export const validReasonCode = (v: string) => /^[a-z][a-z0-9_]{1,63}$/.test(v.trim());
/** The reason code the API demands to approve a version that the automated scans flagged. */
export const SCAN_OVERRIDE = 'scan_override';

export interface ModerationInput {
  decision: Decision;
  reasonCode: string;
  notes: string;
  versionId: string;
}
/** Errors of the decision form (translation keys), empty when the body can be sent. */
export function moderationErrors(
  i: ModerationInput & { listingId: string },
): Partial<
  Record<
    'listingId' | 'reasonCode' | 'notes' | 'versionId',
    'listing' | 'reason' | 'notes' | 'version'
  >
> {
  const e: Partial<
    Record<
      'listingId' | 'reasonCode' | 'notes' | 'versionId',
      'listing' | 'reason' | 'notes' | 'version'
    >
  > = {};
  if (!isUuid(i.listingId)) e.listingId = 'listing';
  if (!validReasonCode(i.reasonCode)) e.reasonCode = 'reason';
  if (i.notes.length > 4000) e.notes = 'notes';
  if (i.versionId.trim() !== '' && !isUuid(i.versionId)) e.versionId = 'version';
  return e;
}
export function moderationBody(i: ModerationInput) {
  return {
    decision: i.decision,
    reasonCode: i.reasonCode.trim(),
    ...(i.notes.trim() ? { notes: i.notes.trim() } : {}),
    ...(i.versionId.trim() ? { versionId: i.versionId.trim().toLowerCase() } : {}),
  };
}

/** Agencies and resellers among the organizations returned by the admin organizations list (the only oversight source: there is no programs list endpoint). */
export const isProgramOrg = (o: { type: string }) => o.type === 'agency' || o.type === 'reseller';
