// Placeholder design tokens (D-32): brand assets (colors, logo, typography) are still owed by the owner.
// Logical properties only (inline-start/end) so RTL is the default, not an afterthought.
export const tokens = {
  color: {
    bg: '#ffffff',
    surface: '#f9fafb',
    hover: '#f3f4f6',
    fg: '#111827',
    muted: '#4b5563',
    border: '#e5e7eb',
    'border-strong': '#6b7280',
    accent: '#2563eb',
    'accent-strong': '#1d4ed8',
    'accent-soft': '#eff6ff',
    focus: '#1d4ed8',
    danger: '#b91c1c',
  },
  space: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 6: '24px', 8: '32px' },
  radius: { sm: '4px', md: '8px' },
  font: {
    sans: "system-ui, -apple-system, 'Segoe UI', Tahoma, 'Noto Sans Arabic', sans-serif",
  },
} as const;

export function cssVariables(): string {
  const lines: string[] = [];
  for (const [group, values] of Object.entries(tokens)) {
    for (const [k, v] of Object.entries(values)) lines.push(`  --nuzm-${group}-${k}: ${v};`);
  }
  return `:root {\n${lines.join('\n')}\n}\n`;
}

export { baseCss } from './styles';
export * from './components';
export { consoleCss } from './console-css';
export { Icon, ICON_NAMES, type IconName } from './icons';
export {
  PrimaryRail,
  ContextSidebar,
  StatTile,
  type RailItem,
  type SideItem,
  type SideGroup,
} from './console-nav';
export {
  LocaleSwitch,
  ConsoleFrame,
  ProfileMenu,
  MfaChallenge,
  MfaEnrol,
  useStepUp,
  type StepUpLabels,
  type MfaChallengeProps,
  type MfaEnrolProps,
} from './client';
export {
  buildNavFrom,
  currentCategoryOf,
  currentItemId,
  stripLocale,
  type NavCategory,
  type NavGroup,
  type NavItem,
  type NavContext,
  type ResolvedCategory,
  type ResolvedGroup,
  type ResolvedItem,
} from './nav-model';
