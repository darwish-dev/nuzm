import type { L } from './site-content';

export type PublicPlanService = 'hosting' | 'cloud' | 'vps' | 'email';
export interface PublicServicePlan {
  id: string;
  name: L;
  description: L;
  /** Owner-approved monthly price in minor units, never inferred from development seeds. */
  monthlyAmountMinor: number;
  currency: string;
  features: L[];
  href: string;
}

/** Populated only after the owner supplies the public prices and included limits. */
export const PUBLIC_SERVICE_PLANS: Record<PublicPlanService, PublicServicePlan[]> = {
  hosting: [],
  cloud: [],
  vps: [],
  email: [],
};
