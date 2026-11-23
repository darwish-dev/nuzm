import type { ReactNode } from 'react';

/**
 * A small, consistent icon set (24x24, 1.6 stroke, currentColor). Own drawings so the console needs no icon dependency and no
 * network. Icons are decoration: the control that holds one always carries its own accessible label.
 */
const PATHS: Record<string, ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  transfer: (
    <>
      <path d="M4 8h14l-3.5-3.5" />
      <path d="M20 16H6l3.5 3.5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.2" />
      <path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8" />
    </>
  ),
  support: (
    <>
      <path d="M20 12a7.5 7.5 0 0 1-7.5 7.5H6.2L3.5 21.5l.8-3.6A7.5 7.5 0 1 1 20 12Z" />
      <path d="M8.6 12h.01M12 12h.01M15.4 12h.01" strokeWidth="2.4" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2.2" />
      <path d="M4 10h16" />
      <path d="M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  tag: (
    <>
      <path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.4 1.4 0 0 1 0 2l-6.7 6.7a1.4 1.4 0 0 1-2 0z" />
      <circle cx="8" cy="8" r="1.4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  pulse: <path d="M3.5 12h4l2.2-5.5 4.6 11 2.2-5.5h4" />,
  code: (
    <>
      <path d="m8.5 7-5 5 5 5" />
      <path d="m15.5 7 5 5-5 5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </>
  ),
  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 11 13" />
      <path d="M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.6" />
      <rect x="13" y="4" width="7" height="7" rx="1.6" />
      <rect x="4" y="13" width="7" height="7" rx="1.6" />
      <rect x="13" y="13" width="7" height="7" rx="1.6" />
    </>
  ),
  list: (
    <>
      <path d="M4 6.5h16" />
      <path d="M4 12h16" />
      <path d="M4 17.5h16" />
    </>
  ),
  arrow: (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
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
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5S14.4 18.1 12 20.5C9.6 18.1 8.4 15.3 8.4 12S9.6 5.9 12 3.5z" />
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
  workflow: (
    <>
      <rect x="3.5" y="4" width="6" height="5" rx="1.2" />
      <rect x="14.5" y="15" width="6" height="5" rx="1.2" />
      <path d="M9.5 6.5h3a2 2 0 0 1 2 2v6.5M6.5 9v3.5a2 2 0 0 0 2 2h6" />
    </>
  ),
  sparkle: (
    <>
      <path d="M11 3.5 13 9l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2 5.5-2z" />
      <path d="M18.5 3.5v3M17 5h3" />
    </>
  ),
  basket: (
    <>
      <path d="M3.5 9h17l-1.7 9.2a2 2 0 0 1-2 1.6H7.2a2 2 0 0 1-2-1.6z" />
      <path d="M8 9l3-5M16 9l-3-5" />
      <path d="M9.5 13v3M14.5 13v3" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.7A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.6 6.9A15.6 15.6 0 0 0 2.5 12s3.5 6.5 9.5 6.5c1.5 0 2.8-.4 4-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  store: (
    <>
      <path d="M4 9.5 5.5 4h13L20 9.5" />
      <path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0" />
      <path d="M5.5 12.5V20h13v-7.5M10 20v-4.5h4V20" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  redo: (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </>
  ),
  desktop: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  tablet: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M11 17.5h2" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2.2" />
      <path d="M11 18.5h2" />
    </>
  ),
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </>
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
  paperclip: (
    <path d="m20 11.5-7.9 7.9a5 5 0 0 1-7.1-7.1l8.3-8.3a3.4 3.4 0 0 1 4.8 4.8l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6" />
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>
  ),
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
