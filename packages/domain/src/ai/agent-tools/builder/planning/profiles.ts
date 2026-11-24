import { API, ECOMMERCE, LANDING, SAAS, WEBAPP, WEBSITE } from './profiles-a';
import { AUTH, CRM, DATABASE, DOCS, ERP, FLUTTER, FULLSTACK, MOBILE } from './profiles-b';
import type { ProductProfile, ProductType } from './types';

/** Every product type has exactly one profile (the compile-time `Record` keeps the table complete). */
export const PROFILES: Record<ProductType, ProductProfile> = {
  website: WEBSITE,
  landing: LANDING,
  ecommerce: ECOMMERCE,
  webapp: WEBAPP,
  mobile: MOBILE,
  flutter: FLUTTER,
  erp: ERP,
  crm: CRM,
  saas: SAAS,
  fullstack: FULLSTACK,
  api: API,
  database: DATABASE,
  auth: AUTH,
  docs: DOCS,
};
export const profileOf = (t: ProductType): ProductProfile => PROFILES[t];
