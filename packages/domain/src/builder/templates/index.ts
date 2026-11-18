import type { BusinessType } from '../artifacts';
import { clinic } from './clinic';
import { education } from './education';
import type { SiteTemplate } from './helpers';
import { landing } from './landing';
import { ngo } from './ngo';
import { portfolio } from './portfolio';
import { restaurant } from './restaurant';
import { retail } from './retail';
import { services } from './services';

export type { SiteTemplate } from './helpers';

/** The template library: one template per business category (M09 S39). Bump `version` when a template's content changes. */
export const TEMPLATES: readonly SiteTemplate[] = [
  restaurant,
  clinic,
  retail,
  portfolio,
  services,
  education,
  ngo,
  landing,
];

export function getTemplate(id: string): SiteTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** The template for a business type; `other` falls back to the general services template. */
export function templateForBusinessType(t: BusinessType): SiteTemplate {
  return TEMPLATES.find((x) => x.category === t) ?? services;
}
