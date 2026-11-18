import type { EvidenceKind, RawEvidence, Redactor } from '@nuzm/adapter-contracts';

/** Builds redacted evidence. `request`/`response` are summaries (never raw headers, never credentials); the redactor runs over them. */
export function makeEvidence(
  redactor: Redactor,
  kind: EvidenceKind,
  capturedAt: string,
  operation: string,
  summary: string,
  request?: unknown,
  response?: unknown,
): RawEvidence {
  return redactor.deep({
    kind,
    capturedAt,
    operation,
    summary: redactor.string(summary).slice(0, 500),
    ...(request !== undefined ? { redactedRequest: request } : {}),
    ...(response !== undefined ? { redactedResponse: response } : {}),
  });
}

/** Weakest kind wins: one fixture item makes the whole set `fixture`. */
export const weakest = (items: readonly RawEvidence[]): EvidenceKind =>
  items.some((e) => e.kind === 'mock')
    ? 'mock'
    : items.some((e) => e.kind === 'fixture') || items.length === 0
      ? 'fixture'
      : 'live';
