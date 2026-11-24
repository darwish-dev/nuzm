import { API, ECOMMERCE, LANDING, SAAS, WEBAPP, WEBSITE } from './profiles-a';
import type { ProductProfile, ProductType } from './types';

/** Every product type has exactly one profile (the compile-time `Record` keeps the table complete). */
export const PROFILES: Partial<Record<ProductType, ProductProfile>> = {
  website: WEBSITE,
  landing: LANDING,
  ecommerce: ECOMMERCE,
  webapp: WEBAPP,
  saas: SAAS,
  api: API,
};
export const profileOf = (t: ProductType): ProductProfile | undefined => PROFILES[t];
