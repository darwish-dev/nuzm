/** Compact local product renders, decorative and shared across service pages. */
export type ArtName =
  'cloud' | 'hosting' | 'domains' | 'builder' | 'agency' | 'database' | 'storage' | 'email';

export function Art({ name, className }: { name: ArtName; className?: string }) {
  return (
    <img
      className={`nzc-art nzc-art-render ${className ?? ''}`.trim()}
      src={`/images/services/${name}-compact.webp`}
      width={1536}
      height={1024}
      alt=""
      aria-hidden="true"
      decoding="async"
    />
  );
}

/**
 * A desktop monitor on a glass shelf, showing a miniature of a product page drawn from shapes (no text, so it needs no translation). Decorative. The
 * bezel stays dark in both themes, like a real screen; the glow and the screen's accent follow the theme.
 */
export function Monitor({ className }: { className?: string }) {
  return (
    <svg
      className={`nzc-monitor ${className ?? ''}`.trim()}
      viewBox="0 0 640 410"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="nzc-mon-screen" x1="0" y1="0" x2="1" y2="1">
          <stop
            offset="0"
            style={{ stopColor: 'color-mix(in srgb, var(--nzc-accent-strong) 78%, #0b1114)' }}
          />
          <stop offset="0.55" style={{ stopColor: '#0d1417' }} />
          <stop offset="1" style={{ stopColor: '#070a0c' }} />
        </linearGradient>
        <radialGradient id="nzc-mon-glow" cx="0.78" cy="0.2" r="0.6">
          <stop offset="0" style={{ stopColor: 'var(--nzc-accent)', stopOpacity: 0.75 }} />
          <stop offset="1" style={{ stopColor: 'var(--nzc-accent)', stopOpacity: 0 }} />
        </radialGradient>
        <linearGradient id="nzc-mon-stand" x1="0" y1="0" x2="1" y2="0">
          <stop
            offset="0"
            style={{ stopColor: 'color-mix(in srgb, var(--nzc-fg) 22%, transparent)' }}
          />
          <stop
            offset="0.5"
            style={{ stopColor: 'color-mix(in srgb, var(--nzc-fg) 42%, transparent)' }}
          />
          <stop
            offset="1"
            style={{ stopColor: 'color-mix(in srgb, var(--nzc-fg) 22%, transparent)' }}
          />
        </linearGradient>
      </defs>
      {/* the glass shelf and a soft reflection of the screen on it */}
      <rect className="nzc-art-s" x="30" y="384" width="580" height="16" rx="8" />
      <ellipse className="nzc-art-m" cx="320" cy="392" rx="120" ry="4" />
      {/* stand */}
      <path fill="url(#nzc-mon-stand)" d="M288 312h64l14 66a8 8 0 0 1-8 10H282a8 8 0 0 1-8-10z" />
      <ellipse className="nzc-art-m" cx="320" cy="384" rx="92" ry="7" />
      {/* bezel and screen */}
      <rect x="58" y="10" width="524" height="306" rx="20" fill="#0c0d0f" />
      <rect x="68" y="20" width="504" height="282" rx="12" fill="url(#nzc-mon-screen)" />
      <rect x="68" y="20" width="504" height="282" rx="12" fill="url(#nzc-mon-glow)" />
      {/* page: navigation */}
      <circle cx="94" cy="46" r="7" fill="#fff" fillOpacity=".92" />
      <rect x="124" y="42" width="38" height="8" rx="4" fill="#fff" fillOpacity=".3" />
      <rect x="172" y="42" width="38" height="8" rx="4" fill="#fff" fillOpacity=".3" />
      <rect x="220" y="42" width="38" height="8" rx="4" fill="#fff" fillOpacity=".3" />
      <rect x="268" y="42" width="38" height="8" rx="4" fill="#fff" fillOpacity=".3" />
      <rect x="500" y="36" width="56" height="20" rx="10" fill="#fff" fillOpacity=".95" />
      {/* page: headline, text and button */}
      <rect x="94" y="108" width="214" height="20" rx="10" fill="#fff" fillOpacity=".95" />
      <rect x="94" y="136" width="170" height="20" rx="10" fill="#fff" fillOpacity=".95" />
      <rect x="94" y="164" width="120" height="20" rx="10" fill="#fff" fillOpacity=".4" />
      <rect x="94" y="200" width="190" height="7" rx="3.5" fill="#fff" fillOpacity=".3" />
      <rect x="94" y="214" width="150" height="7" rx="3.5" fill="#fff" fillOpacity=".3" />
      <rect x="94" y="240" width="84" height="26" rx="13" fill="#fff" fillOpacity=".95" />
      {/* page: a glass card with plan rows */}
      <rect x="352" y="92" width="190" height="168" rx="18" fill="#fff" fillOpacity=".11" />
      <rect x="368" y="108" width="64" height="10" rx="5" fill="#fff" fillOpacity=".85" />
      <rect x="368" y="126" width="100" height="7" rx="3.5" fill="#fff" fillOpacity=".3" />
      <g>
        <circle cx="378" cy="156" r="6" style={{ fill: 'var(--nzc-accent)' }} />
        <rect x="392" y="152" width="90" height="8" rx="4" fill="#fff" fillOpacity=".55" />
        <circle cx="378" cy="180" r="6" style={{ fill: 'var(--nzc-accent)' }} />
        <rect x="392" y="176" width="70" height="8" rx="4" fill="#fff" fillOpacity=".55" />
        <circle cx="378" cy="204" r="6" style={{ fill: 'var(--nzc-accent)' }} />
        <rect x="392" y="200" width="100" height="8" rx="4" fill="#fff" fillOpacity=".55" />
      </g>
      <rect x="368" y="224" width="158" height="24" rx="12" style={{ fill: 'var(--nzc-accent)' }} />
      {/* page: small tiles along the bottom */}
      <rect x="94" y="276" width="34" height="14" rx="5" fill="#fff" fillOpacity=".16" />
      <rect x="136" y="276" width="34" height="14" rx="5" fill="#fff" fillOpacity=".16" />
      <rect
        x="178"
        y="276"
        width="34"
        height="14"
        rx="5"
        style={{ fill: 'var(--nzc-accent)' }}
        fillOpacity=".75"
      />
    </svg>
  );
}
