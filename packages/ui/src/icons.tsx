import type { ReactNode } from 'react';

/**
 * A small, consistent icon set (24x24, 1.6 stroke, currentColor). Own drawings so the console needs no icon dependency and no
 * network. Icons are decoration: the control that holds one always carries its own accessible label.
 */
const PATHS: Record<string, ReactNode> = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="8" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.8" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.8" />
      <rect x="3.5" y="14.5" width="7" height="6" rx="1.8" />
    </>
  ),
  projects: (
    <>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </>
  ),
  cloud: (
    <>
      <path d="M7 18.5a4.2 4.2 0 0 1-.6-8.35 5.6 5.6 0 0 1 10.8 1.2A3.6 3.6 0 0 1 17 18.5z" />
    </>
  ),
  hosting: (
    <>
      <rect x="3.5" y="4" width="17" height="6.5" rx="1.8" />
      <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.8" />
      <path d="M7.5 7.25h.01M7.5 16.75h.01" />
    </>
  ),
  domains: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5S14.4 18.1 12 20.5C9.6 18.1 8.4 15.3 8.4 12S9.6 5.9 12 3.5z" />
    </>
  ),
  data: (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
      <path d="M4.5 6v6c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V6M4.5 12v6c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8v-6" />
    </>
  ),
  email: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4.5 7.5 7.5 5.6 7.5-5.6" />
    </>
  ),
  finance: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.2" />
      <path d="M3.5 10h17M7.5 14.5h3" />
    </>
  ),
  organization: (
    <>
      <path d="M4.5 20.5v-15a1.5 1.5 0 0 1 1.5-1.5h7a1.5 1.5 0 0 1 1.5 1.5v15M14.5 9.5H18a1.5 1.5 0 0 1 1.5 1.5v9.5M2.5 20.5h19" />
      <path d="M8 8h3M8 11.5h3M8 15h3" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16.5v-5a6 6 0 0 1 12 0v5l1.5 1.5h-15z" />
      <path d="M10 20.5a2.1 2.1 0 0 0 4 0" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
      <path d="M16 12h4v3.2h-4a1.6 1.6 0 0 1 0-3.2z" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M4.5 20c.7-3.6 3.7-5.5 7.5-5.5s6.8 1.9 7.5 5.5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 5 6v5.6c0 4.4 3 7.6 7 8.9 4-1.3 7-4.5 7-8.9V6z" />
      <path d="m9 12 2.2 2.2L15.2 10" />
    </>
  ),
  key: (
    <>
      <circle cx="8.5" cy="14.5" r="3.5" />
      <path d="m11 12 8-8m-3 3 2.5 2.5M14 9l2 2" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </>
  ),
  moon: <path d="M19.5 14.2A8 8 0 0 1 9.8 4.5a8 8 0 1 0 9.7 9.7z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
    </>
  ),
  logout: (
    <>
      <path d="M14.5 4.5h3A2 2 0 0 1 19.5 6.5v11a2 2 0 0 1-2 2h-3" />
      <path d="M10 8 5.5 12 10 16M5.5 12h10" />
    </>
  ),
  panel: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
};

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="nzc-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
