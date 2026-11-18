import { ProblemException } from '../../../common/errors';

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loosely-typed JSON rows
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const iso = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);
export const pgCode = (e: unknown): string | undefined => (e as { code?: string }).code;
export const hint = (e: unknown): string | undefined => (e as { hint?: string }).hint;
export const MARKETPLACE_FLAG = 'marketplace.enabled';
export const LISTING_TYPES = ['website-template', 'app-template', 'workflow-template'] as const;
export type ListingType = (typeof LISTING_TYPES)[number];
export const badRequest = (detail: string, errors?: unknown[]) => new ProblemException('validation_failed', detail, errors);

export interface MarketplaceConfig {
  /**
   * The publisher's share of a purchase's net amount in basis points. A PLACEHOLDER: the commercial terms (publisher agreement, revenue share, payout route) are D-26 / HG-11-01 and are
   * OPEN. It only sizes the ACCRUAL (a ledger liability); nothing pays it out.
   */
  publisherShareBps: number;
  maxArtifactBytes: number;
  /**
   * The region where artifacts live. `sa-pending` (the unverified placeholder) until the artifact store is wired to verified in-Kingdom storage (M08 storage + M05 region evidence): the residency
   * hook then denies every purchase and install for an organization restricted to the Kingdom: FAIL CLOSED. Tests and local runs set a verified mock region.
   */
  artifactRegion: string;
}
export const MARKETPLACE_CONFIG = Symbol('MARKETPLACE_CONFIG');
export const loadMarketplaceConfig = (env: NodeJS.ProcessEnv = process.env): MarketplaceConfig => {
  const bps = Number(env.MARKETPLACE_PUBLISHER_SHARE_BPS ?? 7000);
  return {
    publisherShareBps: Number.isInteger(bps) && bps >= 0 && bps <= 10_000 ? bps : 7000,
    maxArtifactBytes: Number(env.MARKETPLACE_MAX_ARTIFACT_BYTES ?? 5 * 1024 * 1024) || 5 * 1024 * 1024,
    artifactRegion: env.MARKETPLACE_ARTIFACT_REGION ?? 'sa-pending',
  };
};
/** floor(net × bps / 10000): integer arithmetic only. */
export const shareOf = (netMinor: bigint, bps: number): bigint => (netMinor * BigInt(bps)) / 10_000n;
/** The artifact reference of an organization lives under its own namespace: a publisher can never point a version at someone else's artifact. */
export const artifactNamespace = (orgId: string) => `artifact://${orgId}/`;
