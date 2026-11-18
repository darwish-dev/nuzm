import type { ProviderRegion } from '@nuzm/adapter-contracts';

/**
 * Verified-region report (M05 S18 task 14). `LIVE-VERIFIED` requires ALL of: an owner-recorded human-gate evidence id (HG-05-0x), at least
 * one region present in the account's own listing, and every piece of that region's evidence being `live`. Anything else — in particular
 * every fixture or mock run — is `NOT VERIFIED`, lists NO verified region, and says why. A fixture can never produce a verified Saudi row.
 */
export interface RegionReportInput {
  provider: string;
  adapterId: string;
  /** Non-secret label of the provider account (never a credential). `none` when no account exists. */
  accountLabel: string;
  date: string; // YYYY-MM-DD
  hgEvidence?: string; // e.g. "HG-05-01:evidence-id"; absent while the gate is PENDING
  regions: ProviderRegion[];
  gate: 'HG-05-01' | 'HG-05-02' | 'HG-05-03';
}
export interface RegionReport {
  status: 'LIVE-VERIFIED' | 'NOT VERIFIED';
  reason: string;
  json: Record<string, unknown>;
  markdown: string;
  fileStem: string;
}

export function buildRegionReport(i: RegionReportInput): RegionReport {
  const live = i.regions.filter(
    (r) => r.verifiedAt && r.evidence.length > 0 && r.evidence.every((e) => e.kind === 'live'),
  );
  const status: RegionReport['status'] =
    i.hgEvidence && live.length > 0 ? 'LIVE-VERIFIED' : 'NOT VERIFIED';
  const reason =
    status === 'LIVE-VERIFIED'
      ? `observed in the account's own region listing with live evidence (${i.hgEvidence})`
      : !i.hgEvidence
        ? `${i.gate} is PENDING: no account or credential exists, no live probe was run`
        : 'no region carried live evidence in the account listing';
  const verified = status === 'LIVE-VERIFIED' ? live : [];
  const json = {
    provider: i.provider,
    adapterId: i.adapterId,
    account: i.accountLabel,
    date: i.date,
    status,
    reason,
    gate: i.gate,
    gateEvidence: i.hgEvidence ?? null,
    verifiedRegions: verified.map((r) => ({
      providerRegionId: r.providerRegionId,
      countryCode: r.countryCode,
      verifiedAt: r.verifiedAt,
      evidenceKinds: [...new Set(r.evidence.map((e) => e.kind))],
    })),
    saudiArabia: verified.some((r) => r.countryCode === 'SA') ? 'verified' : 'NOT VERIFIED',
    listedButNotVerified: i.regions
      .filter((r) => !verified.includes(r))
      .map((r) => ({ providerRegionId: r.providerRegionId, countryCode: r.countryCode })),
  };
  const md = [
    `# Verified-region report — ${i.provider} (${i.adapterId})`,
    '',
    `- Account: ${i.accountLabel}`,
    `- Date: ${i.date}`,
    `- Status: **${status}**`,
    `- Reason: ${reason}`,
    `- Saudi Arabia: **${json.saudiArabia}**`,
    '',
    '| Region | Country | State |',
    '|---|---|---|',
    ...(i.regions.length
      ? i.regions.map(
          (r) =>
            `| ${r.providerRegionId} | ${r.countryCode} | ${verified.includes(r) ? 'verified (live evidence)' : 'listed, NOT verified'} |`,
        )
      : ['| (none: no probe run) | — | NOT VERIFIED |']),
    '',
    "Rule: a region is `verified` only when it is observed in the account's own listing through LIVE evidence. Fixture and mock runs never verify a region.",
    '',
  ].join('\n');
  return {
    status,
    reason,
    json,
    markdown: md,
    fileStem: `verified-region-report-${i.provider}-${i.accountLabel}-${i.date}`,
  };
}
