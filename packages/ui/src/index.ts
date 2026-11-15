// Placeholder design tokens (D-32): brand assets (colors, logo, typography) are still owed by the owner.
// Logical properties only (inline-start/end) so RTL is the default, not an afterthought.
export const tokens = {
  color: {
    bg: '#ffffff',
    fg: '#111827',
    muted: '#6b7280',
    border: '#e5e7eb',
    accent: '#2563eb',
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
