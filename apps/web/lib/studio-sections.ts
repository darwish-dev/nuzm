/**
 * The sections of a site, in the order of the studio's tab row. Each one is a panel of the studio for THAT site (never a page of the console).
 * Plain module (no 'use client'): the server page reads `?panel=` with it and the client panel renders with it.
 */
export const STUDIO_SECTIONS = ['versions', 'seo', 'forms', 'cms', 'deployments'] as const;
export type StudioSection = (typeof STUDIO_SECTIONS)[number];
export const studioSection = (v: string | null | undefined): StudioSection | null =>
  (STUDIO_SECTIONS as readonly string[]).includes(v ?? '') ? (v as StudioSection) : null;
