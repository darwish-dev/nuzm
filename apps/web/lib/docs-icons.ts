import type { IconName } from '@nuzm/ui';

/** An icon per documentation guide (the console copy and the support panel use the same picture for the same guide). */
export const guideIcon = (slug: string): IconName =>
  slug.includes('auth')
    ? 'key'
    : slug.includes('quick')
      ? 'sparkle'
      : slug.includes('error')
        ? 'shield'
        : slug.includes('webhook')
          ? 'bell'
          : slug.includes('paginat')
            ? 'list'
            : slug.includes('idempot')
              ? 'refresh'
              : slug.includes('operation')
                ? 'pulse'
                : 'code';
