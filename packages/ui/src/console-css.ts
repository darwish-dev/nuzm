/**
 * Customer-console design system ("premium minimal cloud console"). It is scoped under `.nzc` (set on <body> by the web app) so the
 * admin console keeps `baseCss` untouched. Redefining the `--nuzm-*` colour tokens here restyles every shared component
 * (buttons, cards, inputs, tables, badges, banners, states) without touching their markup.
 *
 * Logical properties ONLY (a test forbids left/right). Dark is the default theme; `data-theme="light"` switches the same
 * architecture to the light palette. Fonts are the system stacks (no network, no licensing): Arabic falls through to the
 * platform's Arabic UI faces.
 */
export const consoleCss = `
.nzc {
  --nzc-chrome: linear-gradient(180deg, #202429 0%, #262c33 22%, #34434d 48%, #587079 72%, #93b6b3 90%, #bcdccb 100%);
  --nzc-chrome-glow: radial-gradient(44rem 14rem at 88% -2rem, rgba(188, 220, 203, 0.16), transparent 70%);
  --nzc-bg: #0b0b0c;
  --nzc-rail: #0e0e10;
  --nzc-side: #0e0e10;
  --nzc-card: #161618;
  --nzc-card-hi: #1b1b1e;
  --nzc-elev: #1f1f23;
  --nzc-border: #27272c;
  --nzc-field: #0f0f11;
  --nzc-field-border: #323238;
  --nzc-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%239b9bb0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  --nzc-check: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23161a1f' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m5 12.5 4.5 4.5L19 7.5'/%3E%3C/svg%3E");
  --nzc-fg: #f4f0e8;
  --nzc-muted: #a0a6a5;
  --nzc-accent: #bcdccb;
  --nzc-accent-strong: #93b6b3;
  --nzc-grad: linear-gradient(165deg, #cfe8da 0%, #93b6b3 100%);
  --nzc-grad-card: linear-gradient(160deg, #587079 0%, #34434d 100%);
  --nzc-glow-accent: 0 0 40px rgba(147, 182, 179, 0.3);
  --nzc-on-accent: #14181b;
  --nzc-accent-soft: rgba(188, 220, 203, 0.13);
  --nzc-success: #76d6ac;
  --nzc-success-soft: rgba(118, 214, 172, 0.14);
  --nzc-warn: #f0b34a;
  --nzc-warn-soft: rgba(240, 179, 74, 0.14);
  --nzc-danger: #f2766f;
  --nzc-danger-soft: rgba(242, 118, 111, 0.14);
  --nzc-glow: radial-gradient(54rem 26rem at 88% -10%, rgba(147, 182, 179, 0.05), transparent 70%);
  --nzc-card-bg: var(--nzc-card);
  --nzc-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
  color-scheme: dark;
}
.nzc[data-theme="light"] {
  --nzc-chrome: linear-gradient(180deg, #dbe6ee 0%, #cfe2e4 45%, #c5e3d6 100%);
  --nzc-chrome-glow: radial-gradient(44rem 14rem at 88% -2rem, rgba(147, 182, 179, 0.22), transparent 70%);
  --nzc-bg: #f4f4f5;
  --nzc-rail: #ffffff;
  --nzc-side: #fafafa;
  --nzc-card: #ffffff;
  --nzc-card-hi: #f1f1f3;
  --nzc-elev: #ececef;
  --nzc-border: #dcdce1;
  --nzc-field: #fbfbfc;
  --nzc-field-border: #cfcfd6;
  --nzc-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235a5a70' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  --nzc-check: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23ffffff' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m5 12.5 4.5 4.5L19 7.5'/%3E%3C/svg%3E");
  --nzc-fg: #17181a;
  --nzc-muted: #5b5f63;
  --nzc-accent: #2c6a5f;
  --nzc-accent-strong: #2c6a5f;
  --nzc-grad: linear-gradient(165deg, #cfe8da 0%, #93b6b3 100%);
  --nzc-grad-card: linear-gradient(160deg, #587079 0%, #34434d 100%);
  --nzc-glow-accent: 0 0 36px rgba(88, 112, 121, 0.28);
  --nzc-on-accent: #14181b;
  --nzc-accent-soft: rgba(44, 106, 95, 0.1);
  --nzc-success: #0c7a52;
  --nzc-success-soft: rgba(12, 122, 82, 0.1);
  --nzc-warn: #946000;
  --nzc-warn-soft: rgba(148, 96, 0, 0.1);
  --nzc-danger: #b42d26;
  --nzc-danger-soft: rgba(180, 45, 38, 0.09);
  --nzc-glow: radial-gradient(54rem 26rem at 88% -10%, rgba(44, 106, 95, 0.06), transparent 70%);
  --nzc-card-bg: linear-gradient(180deg, color-mix(in srgb, var(--nzc-accent) 4%, var(--nzc-card)), var(--nzc-card) 70%);
  --nzc-shadow: 0 14px 40px rgba(20, 20, 40, 0.12);
  color-scheme: light;
}
.nzc {
  /* the shared components read these */
  --nuzm-color-bg: var(--nzc-card);
  --nuzm-color-surface: var(--nzc-elev);
  --nuzm-color-hover: var(--nzc-elev);
  --nuzm-color-fg: var(--nzc-fg);
  --nuzm-color-muted: var(--nzc-muted);
  --nuzm-color-border: var(--nzc-border);
  --nuzm-color-border-strong: #3a3a41;
  --nuzm-color-accent: var(--nzc-accent);
  --nuzm-color-accent-strong: var(--nzc-accent-strong);
  --nuzm-color-accent-soft: var(--nzc-accent-soft);
  --nuzm-color-focus: var(--nzc-accent);
  --nuzm-color-danger: var(--nzc-danger);
  --nuzm-radius-sm: 6px;
  --nuzm-radius-md: 10px;
  --nuzm-font-sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Inter', 'Geist', 'Segoe UI', 'SF Arabic', 'Geeza Pro', 'Noto Sans Arabic', Tahoma, sans-serif;
  background: var(--nzc-chrome-glow) fixed no-repeat, var(--nzc-chrome) fixed;
  min-block-size: 100vh;
  color: var(--nzc-fg);
  font-family: var(--nuzm-font-sans);
  font-size: 14.5px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.nzc[data-theme="light"] { --nuzm-color-border-strong: #c2c2ca; }
.nzc a { color: var(--nzc-accent); text-decoration: none; }
.nzc a:hover { text-decoration: underline; text-underline-offset: 3px; }
.nzc :focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 2px; border-radius: 6px; }
.nzc .nzc-num, .nzc td, .nzc .nzc-stat-value { font-variant-numeric: tabular-nums; }

/* ---- application frame ---- */
.nzc-app { --rail-w: 68px; --side-w: 244px; --top-h: 64px; display: flex; flex-direction: column; block-size: 100vh; overflow: hidden; background: var(--nzc-chrome-glow) no-repeat, var(--nzc-chrome); }
.nzc-frame { flex: 1; min-block-size: 0; display: grid; grid-template-columns: var(--rail-w) var(--side-w) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); margin-inline: 6px; margin-block-end: 0; border: 1px solid var(--nzc-border); border-block-end: 0; border-start-start-radius: 22px; border-start-end-radius: 22px; border-end-start-radius: 0; border-end-end-radius: 0; overflow: hidden; background: var(--nzc-bg) var(--nzc-glow) no-repeat; transition: grid-template-columns 160ms ease; }
.nzc-frame { display: grid; grid-template-columns: var(--rail-w) var(--side-w) minmax(0, 1fr); min-block-size: calc(100vh - var(--top-h)); transition: grid-template-columns 160ms ease; }
.nzc-app[data-side="collapsed"] .nzc-frame { grid-template-columns: var(--rail-w) 0 minmax(0, 1fr); }
.nzc-app[data-side="collapsed"] .nzc-side { visibility: hidden; border-inline-end-color: transparent; }
.nzc-rail { background: var(--nzc-rail); border-inline-end: 1px solid var(--nzc-border); display: flex; flex-direction: column; align-items: center; padding-block: 14px; gap: 6px; block-size: 100%; overflow-y: auto; z-index: 20; }
.nzc-rail ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; align-items: center; }
.nzc-rail .nzc-grow { flex: 1; }
.nzc-brand { display: grid; place-items: center; inline-size: 40px; block-size: 40px; border-radius: 12px; background: var(--nzc-grad); color: #14181b; box-shadow: var(--nzc-glow-accent); font-weight: 700; font-size: 17px; text-decoration: none !important; }
.nzc-logo { display: block; block-size: 26px; inline-size: auto; }
.nzc-logo-mark { display: none; }
.nzc[data-theme="light"] .nzc-logo { filter: invert(1) brightness(0.2); }
.nzc-auth-logo { display: inline-block; margin-block-end: 22px; }
.nzc-auth-logo .nzc-logo { block-size: 32px; }
.nzc-brandlink { display: inline-flex; align-items: center; gap: 10px; color: var(--nzc-fg) !important; font-weight: 650; font-size: 16px; letter-spacing: .01em; text-decoration: none !important; margin-inline-end: 6px; }
.nzc-brand { inline-size: 34px; block-size: 34px; border-radius: 10px; font-size: 15px; }
.nzc-rail-link { position: relative; display: grid; place-items: center; inline-size: 44px; block-size: 44px; border-radius: 12px; color: var(--nzc-muted); background: transparent; border: 0; cursor: pointer; text-decoration: none !important; }
.nzc-rail-link:hover { background: var(--nzc-elev); color: var(--nzc-fg); }
.nzc-rail-link[aria-current="true"], .nzc-rail-link[aria-current="page"] { background: var(--nzc-elev); color: var(--nzc-accent); box-shadow: inset 0 0 0 1px var(--nzc-border); }
.nzc-icon-btn { position: relative; }
.nzc-dot { position: absolute; inset-block-start: 7px; inset-inline-end: 7px; min-inline-size: 16px; block-size: 16px; padding-inline: 4px; border-radius: 999px; background: var(--nzc-grad); color: var(--nzc-on-accent); font-size: 10.5px; line-height: 16px; text-align: center; font-weight: 600; }
/* tooltip: shown on hover and keyboard focus, never the only label (the link has aria-label) */
.nzc-rail-link[data-tip]::after { content: attr(data-tip); position: absolute; inset-inline-start: calc(100% + 10px); inset-block-start: 50%; transform: translateY(-50%); white-space: nowrap; background: var(--nzc-elev); color: var(--nzc-fg); border: 1px solid var(--nzc-border); border-radius: 8px; padding: 4px 10px; font-size: 12.5px; box-shadow: var(--nzc-shadow); opacity: 0; pointer-events: none; transition: opacity 120ms ease; z-index: 40; }
.nzc-rail-link[data-tip]:hover::after, .nzc-rail-link[data-tip]:focus-visible::after { opacity: 1; }
.nzc-avatar { display: grid; place-items: center; inline-size: 34px; block-size: 34px; border-radius: 50%; background: var(--nzc-accent-soft); color: var(--nzc-accent); font-weight: 600; font-size: 13px; border: 1px solid var(--nzc-border); }

.nzc-side { background: var(--nzc-side); border-inline-end: 1px solid var(--nzc-border); padding: 18px 12px; overflow-y: auto; block-size: 100%; min-inline-size: 0; }
.nzc-side h2 { margin: 2px 10px 14px; font-size: 15px; font-weight: 650; letter-spacing: .01em; }
.nzc-group { margin-block-end: 16px; }
.nzc-group-title { margin: 0 10px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--nzc-muted); }
.nzc-side ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.nzc-side a, .nzc-side summary { display: flex; align-items: center; min-block-size: 38px; padding-inline: 10px; border-radius: 9px; color: var(--nzc-muted); font-weight: 500; cursor: pointer; text-decoration: none !important; list-style: none; }
.nzc-side summary::-webkit-details-marker { display: none; }
.nzc-side a:hover, .nzc-side summary:hover { background: var(--nzc-elev); color: var(--nzc-fg); }
.nzc-side a[aria-current="page"] { background: var(--nzc-elev); color: var(--nzc-fg); font-weight: 600; box-shadow: inset 0 0 0 1px var(--nzc-border); }
.nzc-side summary { justify-content: space-between; gap: 8px; }
.nzc-side summary .nzc-icon { transition: transform 140ms ease; }
.nzc-side details[open] > summary .nzc-icon { transform: rotate(90deg); }
[dir="rtl"] .nzc-side summary .nzc-icon { transform: scaleX(-1); }
[dir="rtl"] .nzc-side details[open] > summary .nzc-icon { transform: scaleX(-1) rotate(90deg); }
.nzc-side details > ul { margin-inline-start: 14px; padding-inline-start: 8px; border-inline-start: 1px solid var(--nzc-border); margin-block: 2px 4px; }
.nzc-side details > ul a { min-block-size: 34px; font-size: 13.5px; }

.nzc-top { flex: none; display: flex; align-items: center; gap: 10px; padding: 0 18px; block-size: var(--top-h); position: relative; z-index: 30; }
.nzc-top .nzc-grow { flex: 1; }
.nzc-icon-btn { display: inline-grid; place-items: center; inline-size: 38px; block-size: 38px; border-radius: 10px; border: 1px solid transparent; background: transparent; color: var(--nzc-muted); cursor: pointer; font: inherit; text-decoration: none !important; }
.nzc-icon-btn:hover { background: var(--nzc-elev); color: var(--nzc-fg); }
.nzc-chip { display: inline-flex; align-items: center; gap: 8px; min-block-size: 38px; padding-inline: 12px; border-radius: 10px; border: 1px solid var(--nzc-border); background: var(--nzc-card); color: var(--nzc-fg) !important; font-weight: 550; text-decoration: none !important; }
.nzc-chip:hover { background: var(--nzc-elev); }
.nzc-chip .nzc-icon { color: var(--nzc-accent); }
.nzc-top select { min-block-size: 38px; max-inline-size: 200px; }
.nzc > .nz-main { padding: 56px 20px; }
.nzc > .nz-main > p:last-child a { display: inline-block; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--nzc-border); background: var(--nzc-card); color: var(--nzc-fg); }
.nzc-body, .nzc-side, .nzc-rail { scrollbar-width: none; -ms-overflow-style: none; }
.nzc-body::-webkit-scrollbar, .nzc-side::-webkit-scrollbar, .nzc-rail::-webkit-scrollbar { display: none; }
.nzc-menu { position: relative; }
.nzc-menu-panel { position: absolute; inset-block-start: calc(100% + 8px); inset-inline-end: 0; min-inline-size: 260px; background: var(--nzc-elev); border: 1px solid var(--nzc-border); border-radius: 12px; box-shadow: var(--nzc-shadow); padding: 8px; z-index: 50; }
.nzc-menu-panel .nzc-who { padding: 8px 10px 10px; border-block-end: 1px solid var(--nzc-border); margin-block-end: 6px; }
.nzc-menu-panel .nzc-who strong { display: block; }
.nzc-menu-panel a, .nzc-menu-panel button { display: flex; align-items: center; gap: 10px; inline-size: 100%; min-block-size: 38px; padding-inline: 10px; border-radius: 8px; border: 0; background: transparent; color: var(--nzc-fg) !important; font: inherit; cursor: pointer; text-align: start; text-decoration: none !important; }
.nzc-menu-panel a:hover, .nzc-menu-panel button:hover { background: var(--nzc-card); }
.nzc-avatar-btn { display: inline-grid; place-items: center; inline-size: 40px; block-size: 40px; border-radius: 50%; border: 1px solid transparent; background: transparent; cursor: pointer; padding: 0; }
.nzc-avatar-btn:hover { background: var(--nzc-elev); }
.nzc-menu-title { margin: 8px 10px 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--nzc-muted); }
.nzc-menu-panel .nzc-grow { flex: 1; }
.nzc-check { color: var(--nzc-accent); font-weight: 700; }
.nzc-switch { position: relative; inline-size: 34px; block-size: 20px; border-radius: 999px; background: var(--nzc-border); transition: background 120ms ease; flex: none; }
.nzc-switch::after { content: ''; position: absolute; inset-block-start: 2px; inset-inline-start: 2px; inline-size: 16px; block-size: 16px; border-radius: 50%; background: #fff; transition: inset-inline-start 120ms ease; }
.nzc-switch[data-on="true"] { background: var(--nzc-accent); }
.nzc-switch[data-on="true"]::after { inset-inline-start: 16px; }
.nzc-body { padding: 30px 36px 56px; min-inline-size: 0; min-block-size: 0; block-size: 100%; overflow-y: auto; }
.nzc-body > * { max-inline-size: 1400px; margin-inline: auto; }
.nzc-body > .nz-main { padding: 0; }
.nzc-banner-slot { flex: none; }
.nzc-banner-slot > .nz-banner { border-block-end: 1px solid var(--nzc-border); }
.nzc-pill { display: inline-flex; align-items: center; gap: 10px; min-inline-size: 0; max-inline-size: 100%; padding: 5px 6px 5px 14px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--nzc-warn) 45%, transparent); background: var(--nzc-warn-soft); color: var(--nzc-warn); font-weight: 520; font-size: 13.5px; }
[dir="rtl"] .nzc-pill { padding: 5px 14px 5px 6px; }
.nzc-pill .nzc-icon { flex: none; }
.nzc-pill-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nzc-pill button { flex: none; min-block-size: 30px; padding-inline: 12px; border-radius: 999px; border: 0; background: var(--nzc-warn); color: #14110a; font: inherit; font-weight: 600; cursor: pointer; }
.nzc-pill button:hover { filter: brightness(1.08); }
.nzc-only-mobile { display: none; }

/* ---- shared components, restyled ---- */
.nzc .nz-main { padding: 0; }
.nzc .nz-h1 { font-size: 1.55rem; font-weight: 650; letter-spacing: -.01em; margin-block-end: 18px; }
.nzc .nz-h2 { font-size: 1.02rem; font-weight: 620; }
.nzc .nz-card { background: var(--nzc-card-bg); border: 1px solid var(--nzc-border); border-radius: 18px; padding: 22px; box-shadow: none; }
.nzc .nz-card h2 { margin-block-start: 0; }
.nzc .nz-grid { gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.nzc .nz-btn { min-block-size: 38px; border-radius: 10px; font-weight: 580; border: 1px solid transparent; background: var(--nzc-grad); color: var(--nzc-on-accent); transition: background 120ms ease, border-color 120ms ease; }
.nzc .nz-btn:hover { filter: brightness(1.07); text-decoration: none; }
.nzc .nz-btn[data-variant="secondary"]:hover { filter: none; }
.nzc .nz-btn[data-variant="secondary"] { background: var(--nzc-elev); background-image: none; color: var(--nzc-fg); border-color: var(--nzc-border); }
.nzc .nz-btn[data-variant="secondary"]:hover { background: color-mix(in srgb, var(--nzc-elev) 82%, var(--nzc-fg)); }
.nzc .nz-btn[data-variant="danger"] { background-image: none; background: var(--nzc-danger-soft); color: var(--nzc-danger); border-color: color-mix(in srgb, var(--nzc-danger) 40%, transparent); }
.nzc .nz-table-wrap { border: 1px solid var(--nzc-border); border-radius: 18px; background: var(--nzc-card-bg); }
.nzc .nz-table caption { color: var(--nzc-fg); font-size: .98rem; padding: 16px 18px 8px; }
.nzc .nz-table th { background: var(--nzc-elev); color: var(--nzc-muted); font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; padding: 10px 18px; border-block-start: 1px solid var(--nzc-border); }
.nzc .nz-table td { padding: 13px 18px; border-block-start: 1px solid var(--nzc-border); }
.nzc .nz-table tbody tr:hover td { background: color-mix(in srgb, var(--nzc-fg) 4%, transparent); }
.nzc .nz-badge { padding: 2px 9px; border-radius: 8px; font-size: 12px; font-weight: 560; border: 1px solid transparent; background: var(--nzc-elev); color: var(--nzc-muted); }
.nzc .nz-badge[data-tone="success"] { background: var(--nzc-success-soft); color: var(--nzc-success); border-color: color-mix(in srgb, var(--nzc-success) 30%, transparent); }
.nzc .nz-badge[data-tone="warn"] { background: var(--nzc-warn-soft); color: var(--nzc-warn); }
.nzc .nz-badge[data-tone="danger"] { background: var(--nzc-danger-soft); color: var(--nzc-danger); }
.nzc .nz-banner { border: 0; border-block-end: 1px solid var(--nzc-border); }
.nzc .nz-banner[data-tone="warn"] { background: var(--nzc-warn-soft); color: var(--nzc-warn); }
.nzc .nz-banner[data-tone="danger"] { background: var(--nzc-danger-soft); color: var(--nzc-danger); }
.nzc .nz-state { background: var(--nzc-card-bg); border: 1px dashed var(--nzc-border); border-radius: 18px; padding: 44px 20px; }
.nzc .nz-state h2 { font-size: 1.05rem; }
.nzc .nz-state p { color: var(--nzc-muted); max-inline-size: 46ch; margin-inline: auto; }
.nzc .nz-skeleton { background: linear-gradient(90deg, var(--nzc-elev), color-mix(in srgb, var(--nzc-elev) 70%, var(--nzc-fg)), var(--nzc-elev)); background-size: 200% 100%; animation: nzc-shimmer 1.4s linear infinite; }
.nzc .nz-meter { block-size: 8px; accent-color: var(--nzc-accent); }
.nzc .nz-bars .nz-bar { background: var(--nzc-elev); block-size: 8px; border-radius: 999px; }
.nzc .nz-bars .nz-bar > span { background: linear-gradient(90deg, var(--nzc-accent-strong), var(--nzc-accent)); border-radius: 999px; }
/* the old per-section button rows (billing, privacy, ...) are replaced by the contextual sidebar */
.nzc .nz-subnav { display: none; }
.nzc hr { border: 0; border-block-start: 1px solid var(--nzc-border); margin-block: 16px; }

/* ---- data entry ---- */
.nzc .nz-field { gap: 8px; margin-block-end: 18px; }
.nzc .nz-field label, .nzc label.nzc-label { font-weight: 600; font-size: 14px; color: var(--nzc-fg); }
.nzc .nz-help { font-size: 13px; line-height: 1.5; }
.nzc .nz-error-text { font-size: 13px; font-weight: 520; }
.nzc .nz-input, .nzc select, .nzc textarea, .nzc input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="hidden"]) {
  min-block-size: 52px; padding-inline: 16px; font-size: 15px; font: inherit; font-size: 15px; color: var(--nzc-fg);
  background-color: var(--nzc-field); border: 1px solid var(--nzc-field-border); border-radius: 14px;
  transition: border-color 120ms ease, box-shadow 120ms ease, background-color 120ms ease;
}
.nzc .nz-input:hover, .nzc select:hover, .nzc textarea:hover { border-color: color-mix(in srgb, var(--nzc-accent) 40%, var(--nzc-field-border)); }
.nzc .nz-input:focus, .nzc select:focus, .nzc textarea:focus { outline: none; border-color: var(--nzc-accent); box-shadow: 0 0 0 4px var(--nzc-accent-soft); }
.nzc .nz-input::placeholder, .nzc textarea::placeholder { color: var(--nzc-muted); opacity: .75; }
.nzc .nz-input[aria-invalid="true"], .nzc textarea[aria-invalid="true"], .nzc select[aria-invalid="true"] { border-color: var(--nzc-danger); box-shadow: 0 0 0 4px var(--nzc-danger-soft); }
.nzc .nz-input:disabled, .nzc select:disabled, .nzc textarea:disabled { opacity: .55; cursor: not-allowed; }
.nzc textarea, .nzc textarea.nz-input { padding-block: 14px; min-block-size: 132px; line-height: 1.55; resize: vertical; }
.nzc select, .nzc select.nz-input { appearance: none; -webkit-appearance: none; padding-inline-end: 46px; cursor: pointer; background-image: var(--nzc-chevron); background-repeat: no-repeat; background-position: calc(100% - 18px) center; }
[dir="rtl"] .nzc select, [dir="rtl"] .nzc select.nz-input { background-position: 18px center; }
.nzc input[type="file"] { padding: 12px 14px; border: 1px dashed var(--nzc-field-border); border-radius: 14px; background: var(--nzc-field); color: var(--nzc-muted); max-inline-size: 100%; }
.nzc input[type="file"]::file-selector-button { margin-inline-end: 12px; padding: 7px 14px; border-radius: 10px; border: 1px solid var(--nzc-border); background: var(--nzc-elev); color: var(--nzc-fg); font: inherit; cursor: pointer; }
.nzc input[type="date"], .nzc input[type="datetime-local"], .nzc input[type="time"] { color-scheme: inherit; }
.nzc fieldset { margin: 0 0 18px; padding: 16px 20px 18px; border: 1px solid var(--nzc-border); border-radius: 16px; background: color-mix(in srgb, var(--nzc-elev) 35%, transparent); min-inline-size: 0; }
.nzc fieldset > legend { padding-inline: 10px; font-weight: 620; font-size: 14px; color: var(--nzc-fg); }
.nzc fieldset.nz-card { background: var(--nzc-card-bg); }
/* checkboxes and radios: drawn controls with the accent, 20px, a visible focus ring */
.nzc input[type="checkbox"], .nzc input[type="radio"] { appearance: none; -webkit-appearance: none; flex: none; inline-size: 20px; block-size: 20px; min-block-size: 0; margin: 0; vertical-align: middle; border: 1.5px solid var(--nzc-field-border); background-color: var(--nzc-field); cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease; }
.nzc input[type="checkbox"] { border-radius: 6px; }
.nzc input[type="radio"] { border-radius: 50%; }
.nzc input[type="checkbox"]:hover, .nzc input[type="radio"]:hover { border-color: var(--nzc-accent); }
.nzc input[type="checkbox"]:checked { background-color: var(--nzc-accent); border-color: var(--nzc-accent); background-image: var(--nzc-check); background-size: 14px; background-position: center; background-repeat: no-repeat; }
.nzc input[type="radio"]:checked { border-color: var(--nzc-accent); background-color: var(--nzc-accent); box-shadow: inset 0 0 0 4px var(--nzc-field); }
.nzc input[type="checkbox"]:focus-visible, .nzc input[type="radio"]:focus-visible { outline: none; box-shadow: 0 0 0 4px var(--nzc-accent-soft); }
.nzc input[type="checkbox"]:disabled, .nzc input[type="radio"]:disabled { opacity: .5; cursor: not-allowed; }
.nzc label:has(> input[type="checkbox"]), .nzc label:has(> input[type="radio"]) { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; }
/* a radio with its label becomes a selectable card; the chosen one is outlined in the accent */
.nzc div.nz-row:has(> input[type="radio"]), .nzc label:has(> input[type="radio"]) { display: flex; flex-wrap: nowrap; gap: 14px; align-items: center; padding: 14px 18px; margin-block-end: 10px; border: 1.5px solid var(--nzc-border); border-radius: 16px; background: var(--nzc-card); transition: border-color 120ms ease, background-color 120ms ease; }
.nzc div.nz-row:has(> input[type="radio"]) > label { cursor: pointer; flex: 1; }
.nzc div.nz-row:has(> input[type="radio"]):hover, .nzc label:has(> input[type="radio"]):hover { border-color: color-mix(in srgb, var(--nzc-accent) 50%, var(--nzc-border)); }
.nzc div.nz-row:has(> input[type="radio"]:checked), .nzc label:has(> input[type="radio"]:checked) { border-color: var(--nzc-accent); background: var(--nzc-accent-soft); }
.nzc form .nz-btn[type="submit"], .nzc form button.nz-btn:not([data-variant]) { min-block-size: 48px; padding-inline: 26px; border-radius: 12px; font-size: 15px; }
.nzc .nzc-callout { padding: 18px 20px; border-radius: 16px; background: color-mix(in srgb, var(--nzc-elev) 80%, transparent); border: 1px solid var(--nzc-border); }
.nzc .nzc-callout h3 { margin: 0 0 6px; font-size: 15px; }
.nzc .nzc-callout p { margin: 0 0 8px; color: var(--nzc-muted); }

/* ---- dashboard pieces ---- */
.nzc-pagehead { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-block-end: 22px; }
.nzc-pagehead h1 { margin: 0; font-size: 1.6rem; font-weight: 650; letter-spacing: -.01em; }
.nzc-pagehead p { margin: 4px 0 0; color: var(--nzc-muted); }
.nzc-hero { position: relative; overflow: hidden; border: 1px solid var(--nzc-border); border-radius: 20px; padding: 28px 30px; margin-block-end: 18px; background: radial-gradient(34rem 14rem at 100% 0%, rgba(147, 182, 179, 0.22), transparent 70%), linear-gradient(180deg, var(--nzc-card-hi), var(--nzc-card)); }
.nzc-hero h1 { margin: 0; font-size: 1.7rem; font-weight: 650; letter-spacing: -.015em; }
.nzc-hero p { margin: 8px 0 0; color: var(--nzc-muted); max-inline-size: 60ch; }
.nzc-stats { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); margin-block-end: 20px; }
.nzc-stat { background: var(--nzc-card-bg); border: 1px solid var(--nzc-border); border-radius: 18px; padding: 18px 20px; display: grid; gap: 6px; text-decoration: none !important; color: var(--nzc-fg) !important; transition: border-color 120ms ease, transform 120ms ease; }
a.nzc-stat:hover { border-color: color-mix(in srgb, var(--nzc-accent) 45%, var(--nzc-border)); }
.nzc-stat[data-featured="true"] { background: var(--nzc-grad-card); border-color: transparent; color: #f4f0e8 !important; box-shadow: var(--nzc-glow-accent); }
.nzc-stat[data-featured="true"] .nzc-stat-label, .nzc-stat[data-featured="true"] .nzc-stat-sub { color: rgba(244, 240, 232, 0.82); }
.nzc-stat[data-featured="true"] .nzc-stat-label .nzc-icon { color: #bcdccb; }
.nzc-stat-label { display: flex; align-items: center; gap: 8px; color: var(--nzc-muted); font-size: 12.5px; font-weight: 560; }
.nzc-stat-label .nzc-icon { color: var(--nzc-accent); }
.nzc-stat-value { font-size: 1.7rem; font-weight: 650; letter-spacing: -.02em; line-height: 1.15; }
.nzc-stat-sub { color: var(--nzc-muted); font-size: 12.5px; }
.nzc-split { display: grid; gap: 16px; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); margin-block-end: 20px; }
.nzc-cardhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-block-end: 14px; }
.nzc-cardhead h2 { margin: 0; font-size: 1rem; font-weight: 620; }
.nzc-tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); list-style: none; margin: 0; padding: 0; }
.nzc-tile { display: grid; gap: 6px; padding: 16px; border: 1px solid var(--nzc-border); border-radius: 18px; background: var(--nzc-card-bg); color: var(--nzc-fg) !important; text-decoration: none !important; min-block-size: 112px; align-content: start; }
.nzc-tile:hover { border-color: color-mix(in srgb, var(--nzc-accent) 45%, var(--nzc-border)); background: linear-gradient(180deg, var(--nzc-card-hi), var(--nzc-card)); }
.nzc-tile .nzc-tile-icon { display: grid; place-items: center; inline-size: 34px; block-size: 34px; border-radius: 10px; background: var(--nzc-accent-soft); color: var(--nzc-accent); }
.nzc-tile strong { font-weight: 600; }
.nzc-tile span.nzc-tile-sub { color: var(--nzc-muted); font-size: 12.5px; }
.nzc-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.nzc-list li { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-block-end: 1px solid var(--nzc-border); }
.nzc-list li:last-child { border-block-end: 0; }
.nzc-dl { display: grid; grid-template-columns: max-content 1fr; gap: 10px 20px; margin: 0 0 16px; }
.nzc-dl dt { color: var(--nzc-muted); }
.nzc-dl dd { margin: 0; }
.nzc-subtabs { display: flex; gap: 4px; flex-wrap: wrap; border-block-end: 1px solid var(--nzc-border); margin-block-end: 22px; }
.nzc-subtabs a { padding: 10px 14px; color: var(--nzc-muted); border-block-end: 2px solid transparent; margin-block-end: -1px; text-decoration: none !important; font-weight: 550; }
.nzc-subtabs a[aria-current="page"] { color: var(--nzc-fg); border-block-end-color: var(--nzc-accent); }
.nzc .nzc-subtabs { gap: 6px; margin-block-end: 22px; padding: 5px; border: 1px solid var(--nzc-border); border-radius: 999px; background: var(--nzc-card); inline-size: fit-content; max-inline-size: 100%; overflow-x: auto; }
.nzc .nzc-subtabs a.nz-btn { background: transparent; color: var(--nzc-muted); border: 0; border-radius: 999px; min-block-size: 34px; padding-inline: 16px; font-weight: 560; }
.nzc .nzc-subtabs a.nz-btn:hover { color: var(--nzc-fg); background: transparent; text-decoration: none; }
.nzc .nzc-subtabs a.nz-btn[aria-current="page"] { background: var(--nzc-grad); color: var(--nzc-on-accent); }
.nzc-steps { margin-block-end: 22px; }
.nzc-steps ol { list-style: none; display: flex; align-items: center; gap: 0; margin: 0 0 8px; padding: 0; }
.nzc-steps li { display: flex; align-items: center; gap: 10px; color: var(--nzc-muted); font-weight: 560; }
.nzc-steps li + li::before { content: ''; inline-size: 44px; block-size: 2px; margin-inline: 12px; background: var(--nzc-border); border-radius: 2px; }
.nzc-steps li[data-state="done"] + li::before, .nzc-steps li[data-state="current"]::before { background: var(--nzc-accent); }
.nzc-step-dot { display: grid; place-items: center; inline-size: 28px; block-size: 28px; border-radius: 50%; border: 1.5px solid var(--nzc-border); font-size: 13px; font-weight: 650; background: var(--nzc-card); }
.nzc-steps li[data-state="current"] { color: var(--nzc-fg); }
.nzc-steps li[data-state="current"] .nzc-step-dot { background: var(--nzc-grad); color: var(--nzc-on-accent); border-color: transparent; }
.nzc-steps li[data-state="done"] .nzc-step-dot { border-color: var(--nzc-accent); color: var(--nzc-accent); }
.nzc-steps p { margin: 0; font-size: 13px; color: var(--nzc-fg); opacity: 0.78; }
.nzc > .nz-main > p.nz-muted { color: var(--nzc-fg); opacity: 0.78; }
.nzc-auth { min-block-size: 100vh; display: grid; place-items: center; padding: 24px; background: var(--nzc-bg) var(--nzc-glow) no-repeat; }
.nzc-auth > .nz-main { inline-size: min(100%, 460px); }

@keyframes nzc-shimmer { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) {
  .nzc-frame, .nzc-switch, .nzc-switch::after, .nzc-rail-link, .nzc-side summary .nzc-icon, .nzc .nz-btn, .nzc .nz-input { transition: none; }
  .nzc .nz-skeleton { animation: none; }
}
@media (max-width: 1180px) { .nzc-pill-text { display: none; } .nzc-pill { padding-inline-start: 12px; } }
@media (max-width: 1080px) { .nzc-split { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 900px) {
  .nzc-frame, .nzc-app[data-side="collapsed"] .nzc-frame { grid-template-columns: minmax(0, 1fr); margin-inline: 3px; margin-block-end: 0; border-start-start-radius: 16px; border-start-end-radius: 16px; overflow: visible; }
  .nzc-rail, .nzc-side { position: fixed; inset-block: var(--top-h) 0; block-size: auto; z-index: 60; transform: translateX(calc(-100% - var(--rail-w) - 12px)); transition: transform 180ms ease; }
  [dir="rtl"] .nzc-rail, [dir="rtl"] .nzc-side { transform: translateX(calc(100% + var(--rail-w) + 12px)); }
  .nzc-rail { inset-inline-start: 0; }
  .nzc-side { inset-inline-start: var(--rail-w); inline-size: var(--side-w); box-shadow: var(--nzc-shadow); }
  .nzc-app[data-drawer="open"] .nzc-rail, .nzc-app[data-drawer="open"] .nzc-side { transform: none; }
  .nzc-app[data-side="collapsed"] .nzc-side { visibility: visible; }
  .nzc-scrim { position: fixed; inset-inline: 0; inset-block: var(--top-h) 0; background: rgba(0, 0, 0, .5); z-index: 55; border: 0; }
  .nzc-only-mobile { display: inline-grid; }
  .nzc-only-desktop { display: none; }
  .nzc-app { overflow-x: clip; }
  .nzc-top { padding-inline: 10px; gap: 4px; min-inline-size: 0; }
  .nzc-logo-full { display: none; }
  .nzc-logo-mark { display: block; }
  .nzc-top select { max-inline-size: 118px; min-inline-size: 0; }
  .nzc-chip { padding-inline: 8px; gap: 6px; }
  .nzc-top a:not(.nzc-chip) { white-space: nowrap; font-size: 13px; }
  .nzc-body { padding: 18px 14px 40px; }
  .nzc-pill button { padding-inline: 10px; }
}
`;
