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
  --nuzm-font-sans: 'Cairo Variable', 'Cairo', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'SF Arabic', 'Geeza Pro', 'Noto Sans Arabic', Tahoma, sans-serif;
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
.nzc-app { --rail-w: 68px; --top-h: 64px; display: flex; flex-direction: column; block-size: 100vh; overflow: hidden; background: var(--nzc-chrome-glow) no-repeat, var(--nzc-chrome); }
.nzc-frame { flex: 1; min-block-size: 0; display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); margin-inline: 6px; margin-block-end: 0; border: 1px solid var(--nzc-border); border-block-end: 0; border-start-start-radius: 22px; border-start-end-radius: 22px; border-end-start-radius: 0; border-end-end-radius: 0; overflow: hidden; background: var(--nzc-bg) var(--nzc-glow) no-repeat; }
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


/* ---- section tabs (the selected category's pages, at the top of the page) ---- */
.nzc-tabs { position: relative; margin-block: -8px 26px; border-block-end: 1px solid var(--nzc-border); }
.nzc-tabs > ul { list-style: none; margin: 0; padding: 0; display: flex; align-items: stretch; gap: 4px; overflow-x: auto; overflow-y: visible; }
.nzc-tabs > ul > li { flex: none; display: flex; }
.nzc-tabs > ul > li[data-group-start] { margin-inline-start: 10px; padding-inline-start: 14px; border-inline-start: 1px solid var(--nzc-border); margin-block: 10px; }
.nzc-tabs > ul > li[data-group-start] > .nzc-tab, .nzc-tabs > ul > li[data-group-start] > .nzc-tab-menu > .nzc-tab { margin-block: -10px; }
.nzc-tab { position: relative; display: inline-flex; align-items: center; gap: 6px; min-block-size: 44px; padding-inline: 12px; color: var(--nzc-muted) !important; font-weight: 550; white-space: nowrap; cursor: pointer; list-style: none; text-decoration: none !important; border-radius: 8px 8px 0 0; }
.nzc-tab::-webkit-details-marker { display: none; }
.nzc-tab:hover { color: var(--nzc-fg) !important; background: var(--nzc-elev); }
.nzc-tab[aria-current="page"], .nzc-tab[data-current] { color: var(--nzc-fg) !important; font-weight: 650; }
.nzc-tab[aria-current="page"]::after, .nzc-tab[data-current]::after { content: ""; position: absolute; inset-inline: 10px; inset-block-end: -1px; block-size: 2px; border-radius: 2px; background: var(--nzc-accent); }
.nzc-tab .nzc-icon { transform: rotate(90deg); transition: transform 140ms ease; }
.nzc-tab-menu[open] > .nzc-tab .nzc-icon { transform: rotate(-90deg); }
.nzc-tab-menu { position: static; display: flex; }
.nzc-tab-menu > ul { position: absolute; z-index: 45; list-style: none; margin: 6px 0 0; padding: 6px; min-inline-size: 200px; background: var(--nzc-elev); border: 1px solid var(--nzc-border); border-radius: 12px; box-shadow: var(--nzc-shadow); display: grid; gap: 2px; }
.nzc-tab-menu > ul a { display: flex; align-items: center; min-block-size: 38px; padding-inline: 10px; border-radius: 8px; color: var(--nzc-fg) !important; text-decoration: none !important; }
.nzc-tab-menu > ul a:hover { background: var(--nzc-card); }
.nzc-tab-menu > ul a[aria-current="page"] { background: var(--nzc-card); font-weight: 600; box-shadow: inset 0 0 0 1px var(--nzc-border); }

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
.nzc-body, .nzc-rail, .nzc-tabs > ul { scrollbar-width: none; -ms-overflow-style: none; }
.nzc-body::-webkit-scrollbar, .nzc-rail::-webkit-scrollbar, .nzc-tabs > ul::-webkit-scrollbar { display: none; }
.nzc-menu { position: relative; }
.nzc-menu-panel { position: absolute; inset-block-start: calc(100% + 8px); inset-inline-end: 0; min-inline-size: 260px; background: var(--nzc-elev); border: 1px solid var(--nzc-border); border-radius: 12px; box-shadow: var(--nzc-shadow); padding: 8px; z-index: 50; }
.nzc-menu-panel .nzc-who { padding: 8px 10px 10px; border-block-end: 1px solid var(--nzc-border); margin-block-end: 6px; }
.nzc-menu-panel .nzc-who strong { display: block; }
.nzc-menu-panel a, .nzc-menu-panel button { display: flex; align-items: center; gap: 10px; inline-size: 100%; min-block-size: 38px; padding-inline: 10px; border-radius: 8px; border: 0; background: transparent; color: var(--nzc-fg) !important; font: inherit; cursor: pointer; text-align: start; text-decoration: none !important; }
.nzc-menu-panel a:hover, .nzc-menu-panel button:hover { background: var(--nzc-card); }
.nzc-menu-panel a[aria-current="page"] { background: var(--nzc-card); color: var(--nzc-accent) !important; }
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
/* the old per-section button rows (billing, privacy, ...) are replaced by the section tabs */
.nzc .nz-subnav { display: none; }
.nzc hr { border: 0; border-block-start: 1px solid var(--nzc-border); margin-block: 16px; }

/* ---- stacked pages: several screens on one page, one section under the other (account, team, organization, privacy) ---- */
.nzc-stack { display: grid; gap: 18px; }
.nzc-stack-section { scroll-margin-block-start: 18px; min-inline-size: 0; }
.nzc-stack-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-block-end: 12px; }
.nzc-stack-head .nz-h2 { margin: 0; }
.nzc-stack-sub { margin: 20px 0 8px; font-size: 13px; font-weight: 600; color: var(--nzc-muted); }
.nzc-stack-section .nz-table-wrap { border-radius: 12px; }
/* the section heading names the screen: hide the screen's own page title, and keep table captions for screen readers only */
.nzc-stack-section h1.nz-h1 { display: none; }
.nzc-stack-section caption { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* ---- domains: hero banner, search and transfer heroes, extension cards, search results (card radius 18, nested 14, fields 14) ---- */
.nzc-hero { position: relative; overflow: hidden; display: flex; align-items: center; justify-content: space-between; gap: 20px 32px; flex-wrap: wrap; padding: 28px 30px; margin-block-end: 22px; border-radius: 18px; border: 1px solid var(--nzc-border);
  background:
    radial-gradient(28rem 14rem at 100% 0%, color-mix(in srgb, var(--nzc-accent) 18%, transparent), transparent 70%),
    linear-gradient(135deg, color-mix(in srgb, var(--nzc-accent-strong) 12%, var(--nzc-card)), var(--nzc-card) 65%); }
.nzc-hero-text { position: relative; max-inline-size: 580px; }
.nzc-hero-text h2 { margin: 0 0 6px; font-size: 22px; font-weight: 700; line-height: 1.3; letter-spacing: -.01em; }
.nzc-hero-text p { margin: 0; color: var(--nzc-muted); }
.nzc-hero-actions { position: relative; display: flex; gap: 10px; flex-wrap: wrap; }
.nzc .nzc-hero-actions .nz-btn { min-block-size: 44px; padding-inline: 18px; gap: 8px; }

/* a centred hero card that holds a form (domain search, domain transfer): dark top, an accent glow rising from the bottom */
.nzc-dsearch { position: relative; overflow: hidden; padding: 48px 32px 36px; margin-block-end: 22px; border-radius: 18px; border: 1px solid color-mix(in srgb, var(--nzc-accent) 22%, var(--nzc-border));
  background:
    radial-gradient(80% 55% at 50% 112%, color-mix(in srgb, var(--nzc-accent) 75%, transparent), transparent 75%),
    radial-gradient(45% 45% at 8% 105%, color-mix(in srgb, var(--nzc-accent-strong) 55%, transparent), transparent 70%),
    radial-gradient(45% 45% at 92% 105%, color-mix(in srgb, var(--nzc-accent-strong) 55%, transparent), transparent 70%),
    linear-gradient(180deg, color-mix(in srgb, var(--nzc-bg) 70%, var(--nzc-card)) 0%, color-mix(in srgb, var(--nzc-bg) 70%, var(--nzc-card)) 45%, color-mix(in srgb, var(--nzc-accent-strong) 30%, var(--nzc-card)) 100%); }
.nzc-dsearch-inner { position: relative; max-inline-size: 780px; margin-inline: auto; }
.nzc-dsearch h2 { margin: 0 0 8px; text-align: center; font-size: clamp(24px, 2.8vw, 34px); font-weight: 700; letter-spacing: -.02em; }
.nzc-dsearch-sub { margin: 0 0 28px; text-align: center; color: var(--nzc-muted); }
/* the search field: a 1px accent gradient frame with a soft glow, the submit button inside it */
.nzc-dsearch-bar { position: relative; padding: 1.5px; border-radius: 16px; background: linear-gradient(100deg, var(--nzc-accent-strong), var(--nzc-accent) 50%, var(--nzc-accent-strong)); box-shadow: 0 0 0 5px color-mix(in srgb, var(--nzc-accent) 10%, transparent), 0 10px 40px -8px color-mix(in srgb, var(--nzc-accent) 45%, transparent); transition: box-shadow 140ms ease; }
.nzc-dsearch-bar:focus-within { box-shadow: 0 0 0 6px color-mix(in srgb, var(--nzc-accent) 22%, transparent), 0 10px 44px -6px color-mix(in srgb, var(--nzc-accent) 60%, transparent); }
.nzc-dsearch-field { position: relative; }
.nzc-dsearch-field > .nzc-icon { position: absolute; inset-inline-start: 18px; inset-block-start: 50%; transform: translateY(-50%); color: var(--nzc-muted); pointer-events: none; }
/* the global field rule is very specific (a chain of :not()), so this field's own frame and room need !important */
.nzc .nzc-dsearch-field input.nzc-dsearch-input { inline-size: 100%; min-block-size: 60px; padding-inline: 50px 150px !important; border: 0 !important; border-radius: 14.5px !important; background-color: color-mix(in srgb, var(--nzc-bg) 88%, var(--nzc-card)) !important; box-shadow: none !important; font-size: 16px; }
.nzc .nzc-dsearch-field .nz-btn { position: absolute; inset-inline-end: 8px; inset-block-start: 50%; transform: translateY(-50%); min-block-size: 44px; padding-inline: 18px 16px; border-radius: 10px; gap: 8px; font-size: 15px; }
[dir="rtl"] .nzc-dsearch-field .nz-btn .nzc-icon { transform: scaleX(-1); }
.nzc-dsearch-note { margin: 22px 0 0; text-align: center; font-size: 12.5px; color: color-mix(in srgb, var(--nzc-fg) 72%, transparent); }

.nzc-tlds { margin-block-start: 26px; }
.nzc-tlds-title { margin: 0 0 10px; text-align: center; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--nzc-muted); }
.nzc-tlds-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.nzc .nzc-tlds label.nzc-tld { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px 10px; padding: 18px 18px 16px; border-radius: 14px; border: 1px solid color-mix(in srgb, var(--nzc-fg) 8%, transparent); background: color-mix(in srgb, var(--nzc-bg) 72%, transparent); backdrop-filter: blur(6px); cursor: pointer; transition: border-color 120ms ease, background-color 120ms ease, transform 120ms ease; }
.nzc .nzc-tlds label.nzc-tld:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--nzc-accent) 45%, transparent); }
.nzc .nzc-tlds label.nzc-tld:has(input:checked) { border-color: var(--nzc-accent); background: color-mix(in srgb, var(--nzc-accent) 14%, var(--nzc-bg)); }
.nzc .nzc-tlds label.nzc-tld input[type="checkbox"] { inline-size: 18px; block-size: 18px; border-radius: 5px; }
.nzc-tld-name { font-size: 24px; font-weight: 700; line-height: 1.15; color: var(--nzc-accent); direction: ltr; unicode-bidi: isolate; letter-spacing: -.01em; }
.nzc-tld-hint { grid-column: 1 / -1; font-size: 12.5px; color: var(--nzc-muted); }

/* email domain: the domain field and its button on one line, purposes as switch cards */
.nzc-emd-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 0 12px; text-align: start; }
.nzc .nzc-emd-bar .nz-field { margin-block-end: 0; }
.nzc .nzc-emd-bar > .nz-btn { min-block-size: 52px; margin-block-start: 30px; padding-inline: 24px; border-radius: 14px; }
.nzc .nzc-tlds label.nzc-tld input[type="checkbox"].nzc-switch-input { inline-size: 40px; block-size: 24px; border-radius: 999px; background-color: var(--nzc-elev); background-image: radial-gradient(circle at 11px 50%, var(--nzc-muted) 7px, transparent 7.5px); background-size: auto; }
.nzc .nzc-tlds label.nzc-tld input[type="checkbox"].nzc-switch-input:checked { background-color: var(--nzc-accent); border-color: var(--nzc-accent); background-image: radial-gradient(circle at 28px 50%, #fff 8px, transparent 8.5px); background-size: auto; }
.nzc-purpose-name { font-size: 16px; font-weight: 650; color: var(--nzc-fg); }
@media (max-width: 700px) { .nzc-emd-bar { grid-template-columns: minmax(0, 1fr); } .nzc .nzc-emd-bar > .nz-btn { margin-block-start: 14px; } }

/* numbered steps under a hero title */
.nzc-steps-row { list-style: none; margin: 0 0 26px; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; counter-reset: s; }
.nzc-steps-row li { counter-increment: s; display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--nzc-border); background: var(--nzc-field); font-size: 13.5px; line-height: 1.45; }
.nzc-steps-row li::before { content: counter(s); flex: none; display: grid; place-items: center; inline-size: 24px; block-size: 24px; border-radius: 8px; background: var(--nzc-accent-soft); color: var(--nzc-accent); font-weight: 700; font-size: 12.5px; }

/* a form split into titled parts, fields two to a row */
.nzc-form-part + .nzc-form-part { margin-block-start: 8px; padding-block-start: 20px; border-block-start: 1px solid var(--nzc-border); }
.nzc-form-part h3 { margin: 0 0 14px; font-size: 14px; font-weight: 650; }
.nzc-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; align-items: start; }
.nzc-form-grid .nzc-span { grid-column: 1 / -1; }
.nzc-form-foot { display: flex; align-items: center; justify-content: space-between; gap: 14px 20px; flex-wrap: wrap; margin-block-start: 4px; padding-block-start: 18px; border-block-start: 1px solid var(--nzc-border); }
.nzc .nzc-form-foot .nz-btn { min-block-size: 46px; padding-inline: 22px; }

.nzc-dres-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 4px 0 12px; }
.nzc-dres-head h2, .nzc-dres-head h3 { margin: 0; font-size: 16px; font-weight: 650; }
.nzc-dres-best { display: flex; align-items: center; justify-content: space-between; gap: 16px 24px; flex-wrap: wrap; padding: 22px 24px; margin-block-end: 18px; border-radius: 18px; border: 1px solid color-mix(in srgb, var(--nzc-success) 40%, var(--nzc-border)); background: radial-gradient(30rem 12rem at 0% 0%, var(--nzc-success-soft), transparent 75%), var(--nzc-card); }
.nzc-dres-best .nzc-kicker { display: inline-flex; align-items: center; gap: 6px; margin-block-end: 6px; font-size: 12.5px; font-weight: 600; color: var(--nzc-success); }
.nzc-dres-best .nzc-dname { margin-block-end: 8px; font-size: 24px; font-weight: 700; letter-spacing: -.01em; }
.nzc-dres-price { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.nzc-dres-price strong { display: block; font-size: 22px; font-weight: 700; }
.nzc-dres-price small { display: block; color: var(--nzc-muted); font-size: 12.5px; }
.nzc .nzc-dres-price .nz-btn { min-block-size: 46px; padding-inline: 22px; }
.nzc-dres-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--nzc-border); border-radius: 18px; overflow: hidden; background: var(--nzc-card); }
.nzc-dres-list li { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1.4fr) minmax(0, .9fr) minmax(150px, auto); align-items: center; gap: 10px 16px; padding: 14px 20px; border-block-start: 1px solid var(--nzc-border); }
.nzc-dres-list li:first-child { border-block-start: 0; }
.nzc-dres-list li > :last-child { justify-self: end; }
.nzc-dres-list li > .nz-badge { justify-self: start; }
.nzc-dres-list li[data-state="taken"] .nzc-dname, .nzc-dres-list li[data-state="blocked"] .nzc-dname { color: var(--nzc-muted); }
.nzc-dres-list .nzc-dname { font-weight: 650; font-size: 15.5px; }
.nzc-dres-list .nzc-dprice { font-weight: 650; }
.nzc-dres-list .nz-muted { font-size: 12.5px; }
.nzc-dname-cell { font-weight: 650; }
.nzc-back { display: inline-flex; align-items: center; gap: 6px; margin-block-end: 14px; color: var(--nzc-muted) !important; font-size: 13.5px; font-weight: 550; text-decoration: none !important; }
.nzc-back:hover { color: var(--nzc-fg) !important; }
.nzc-back .nzc-icon { transform: scaleX(-1); }
[dir="rtl"] .nzc-back .nzc-icon { transform: none; }
@media (max-width: 700px) {
  .nzc-hero, .nzc-dsearch { padding: 22px 16px; }
  .nzc-form-grid { grid-template-columns: minmax(0, 1fr); }
  .nzc .nzc-dsearch-field input.nzc-dsearch-input { padding-inline-end: 64px !important; }
  .nzc .nzc-dsearch-field .nz-btn > span { display: none; }
  .nzc-dres-list li { grid-template-columns: minmax(0, 1fr) auto; }
  .nzc-dres-list li > :nth-child(2) { grid-column: 1 / -1; grid-row: 2; }
  .nzc-dres-list li > :nth-child(3) { grid-row: 3; }
}

/* ---- resource pages: a header card with key facts, cards that lead to the resource's sections ---- */
.nzc-rhead { display: grid; gap: 18px; padding: 24px 26px; margin-block-end: 18px; border-radius: 18px; border: 1px solid var(--nzc-border);
  background: radial-gradient(40rem 14rem at 100% 0%, color-mix(in srgb, var(--nzc-accent) 12%, transparent), transparent 70%), var(--nzc-card); }
.nzc-rhead-top { display: flex; align-items: center; justify-content: space-between; gap: 14px 20px; flex-wrap: wrap; }
.nzc-rhead-title { display: flex; align-items: center; gap: 14px; min-inline-size: 0; }
.nzc-rhead-icon { flex: none; display: grid; place-items: center; inline-size: 48px; block-size: 48px; border-radius: 14px; background: var(--nzc-accent-soft); color: var(--nzc-accent); }
.nzc-rhead h2 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -.01em; overflow-wrap: anywhere; }
.nzc-rhead-sub { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-block-start: 4px; color: var(--nzc-muted); font-size: 13.5px; }
.nzc-rhead-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.nzc .nzc-rhead-actions .nz-btn { min-block-size: 42px; padding-inline: 18px; gap: 8px; }
.nzc-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin: 0; border-radius: 14px; overflow: hidden; border: 1px solid var(--nzc-border); background: var(--nzc-border); }
.nzc-facts > div { padding: 12px 16px; background: color-mix(in srgb, var(--nzc-bg) 55%, var(--nzc-card)); }
.nzc-facts dt { margin: 0 0 4px; font-size: 12px; color: var(--nzc-muted); }
.nzc-facts dd { margin: 0; font-weight: 600; font-size: 14.5px; overflow-wrap: anywhere; }

.nzc-navcards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin-block-end: 22px; }
.nzc-navcard { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 14px; padding: 18px; border-radius: 18px; border: 1px solid var(--nzc-border); background: var(--nzc-card); color: var(--nzc-fg) !important; text-decoration: none !important; transition: border-color 120ms ease, transform 120ms ease, background-color 120ms ease; }
a.nzc-navcard:hover { border-color: color-mix(in srgb, var(--nzc-accent) 45%, var(--nzc-border)); transform: translateY(-2px); background: var(--nzc-card-hi); }
.nzc-navcard[aria-disabled="true"] { opacity: .6; }
.nzc-navcard-icon { display: grid; place-items: center; inline-size: 40px; block-size: 40px; border-radius: 12px; background: var(--nzc-accent-soft); color: var(--nzc-accent); }
.nzc-navcard-body { display: grid; gap: 4px; min-inline-size: 0; }
.nzc-navcard-title { font-weight: 650; font-size: 15px; }
.nzc-navcard-desc { color: var(--nzc-muted); font-size: 13px; line-height: 1.45; }
.nzc-navcard-meta { margin-block-start: 6px; font-size: 12.5px; }
.nzc-navcard-go { color: var(--nzc-muted); align-self: center; }
[dir="rtl"] .nzc-navcard-go .nzc-icon { transform: scaleX(-1); }
.nzc-section-title { margin: 6px 0 12px; font-size: 16px; font-weight: 650; }

.nzc-quotas { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-block-end: 22px; }
.nzc-quota { display: grid; gap: 8px; padding: 16px 18px; border-radius: 18px; border: 1px solid var(--nzc-border); background: var(--nzc-card); }
.nzc-quota-label { font-size: 12.5px; color: var(--nzc-muted); }
.nzc-quota-value { font-size: 18px; font-weight: 700; }
.nzc-quota-value small { font-size: 12.5px; font-weight: 500; color: var(--nzc-muted); }

.nzc-plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.nzc .nzc-plans label.nzc-plan { display: grid; gap: 6px; padding: 16px 18px; border-radius: 14px; border: 1px solid var(--nzc-border); background: var(--nzc-field); cursor: pointer; transition: border-color 120ms ease, background-color 120ms ease; }
.nzc .nzc-plans label.nzc-plan:hover { border-color: color-mix(in srgb, var(--nzc-accent) 45%, var(--nzc-border)); }
.nzc .nzc-plans label.nzc-plan:has(input:checked) { border-color: var(--nzc-accent); background: color-mix(in srgb, var(--nzc-accent) 12%, var(--nzc-bg)); }
.nzc-plan-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.nzc-plan-name { font-weight: 700; font-size: 16px; }
.nzc-plan-sum { font-size: 12.5px; color: var(--nzc-muted); }
.nzc-plan-price { font-weight: 650; color: var(--nzc-accent); }

/* ---- resource overview: a main column of panels and a side column of summary cards ---- */
.nzc-ov { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 18px; align-items: start; }
.nzc-ov-main, .nzc-ov-side { display: grid; gap: 18px; min-inline-size: 0; }
.nzc-panel { padding: 24px; border-radius: 18px; border: 1px solid var(--nzc-border); background: var(--nzc-card); }
.nzc-panel > h2 { margin: 0 0 6px; font-size: 20px; font-weight: 700; letter-spacing: -.01em; overflow-wrap: anywhere; }
.nzc-panel > p.nzc-panel-sub { margin: 0 0 18px; color: var(--nzc-muted); }
.nzc-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-block-end: 10px; }
.nzc-panel-head h3 { margin: 0; font-size: 16px; font-weight: 650; }
.nzc-panel-head a { font-weight: 600; font-size: 14px; }
.nzc-actions { display: grid; gap: 12px; }
.nzc-action { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 14px 16px; padding: 16px 18px; border-radius: 14px; border: 1px solid var(--nzc-border); background: var(--nzc-field); }
.nzc-action[data-featured] { border-color: color-mix(in srgb, var(--nzc-accent) 45%, var(--nzc-border)); background: radial-gradient(30rem 10rem at 0% 0%, var(--nzc-accent-soft), transparent 75%), var(--nzc-field); }
.nzc-action-icon { display: grid; place-items: center; inline-size: 46px; block-size: 46px; border-radius: 12px; background: var(--nzc-elev); color: var(--nzc-accent); }
.nzc-action-title { display: block; font-weight: 650; }
.nzc-action-desc { display: block; margin-block-start: 2px; font-size: 13px; color: var(--nzc-muted); }
.nzc .nzc-action .nz-btn { gap: 8px; white-space: nowrap; }
[dir="rtl"] .nzc-action .nz-btn .nzc-icon { transform: scaleX(-1); }
.nzc-side-name { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-block-end: 18px; }
.nzc-side-name strong { display: inline-flex; align-items: center; gap: 8px; font-size: 19px; overflow-wrap: anywhere; }
.nzc-side-name a { color: var(--nzc-muted) !important; display: inline-grid; }
.nzc-side-badges { display: inline-flex; align-items: center; gap: 8px; }
.nzc-lock { display: inline-grid; place-items: center; inline-size: 30px; block-size: 30px; border-radius: 9px; background: var(--nzc-elev); color: var(--nzc-muted); }
.nzc-lock[data-on] { color: var(--nzc-success); }
.nzc-expiry { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 18px; padding-block-end: 18px; margin-block-end: 14px; border-block-end: 1px solid var(--nzc-border); }
.nzc-ring { position: relative; inline-size: 96px; block-size: 96px; }
.nzc-ring svg { inline-size: 100%; block-size: 100%; transform: rotate(-90deg); }
.nzc-ring-track { fill: none; stroke: var(--nzc-elev); stroke-width: 8; }
.nzc-ring-bar { fill: none; stroke: var(--ring, var(--nzc-accent)); stroke-width: 8; stroke-linecap: round; }
.nzc-ring-label { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; font-size: 12px; line-height: 1.2; color: var(--nzc-muted); }
.nzc-ring-label strong { display: block; font-size: 20px; color: var(--nzc-fg); }
.nzc-expiry dt { font-size: 12.5px; color: var(--nzc-muted); }
.nzc-expiry dd { margin: 2px 0 6px; font-size: 18px; font-weight: 700; }
.nzc-side-rows { display: grid; gap: 10px; margin: 0; }
.nzc-side-rows > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 14px; }
.nzc-side-rows dt { display: inline-flex; align-items: center; gap: 8px; color: var(--nzc-muted); }
.nzc-side-rows dd { margin: 0; font-weight: 600; text-align: end; overflow-wrap: anywhere; }
.nzc-ns-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.nzc-ns-list li { padding: 10px 14px; border-radius: 10px; background: var(--nzc-field); font-size: 14px; direction: ltr; unicode-bidi: isolate; text-align: start; }
.nzc-expiry > .nzc-spec-tiles { grid-column: 1 / -1; }
.nzc-spec-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.nzc-spec-tiles > div { display: grid; gap: 2px; padding: 12px; border-radius: 12px; background: var(--nzc-field); text-align: center; }
.nzc-spec-tiles strong { font-size: 18px; font-weight: 700; }
.nzc-spec-tiles span { font-size: 12px; color: var(--nzc-muted); }
.nzc-action[data-tone="danger"] { border-color: color-mix(in srgb, var(--nzc-danger) 40%, var(--nzc-border)); }
.nzc-action[data-tone="danger"] .nzc-action-icon { color: var(--nzc-danger); background: var(--nzc-danger-soft); }
.nzc-action[data-tone="warn"] { border-color: color-mix(in srgb, var(--nzc-warn) 40%, var(--nzc-border)); background: color-mix(in srgb, var(--nzc-warn) 8%, var(--nzc-field)); }
.nzc-action[data-tone="warn"] .nzc-action-icon { color: var(--nzc-warn); }
.nzc-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-block-start: 14px; }
@media (max-width: 1100px) { .nzc-ov { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 700px) { .nzc-action { grid-template-columns: auto minmax(0, 1fr); } .nzc-action > :last-child { grid-column: 1 / -1; } }

/* DNS editor: the add form in one row, an unsaved-changes bar that cannot be missed */
.nzc-dns-add { display: grid; grid-template-columns: minmax(110px, 1fr) 120px 110px minmax(180px, 2.2fr) auto; align-items: end; gap: 0 12px; }
.nzc .nzc-dns-add .nz-field { margin-block-end: 0; }
.nzc .nzc-dns-add > .nz-btn { min-block-size: 52px; }
.nzc-dns-unsaved { position: sticky; inset-block-start: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 12px 18px; flex-wrap: wrap; padding: 14px 18px; border-radius: 14px; border: 1px solid color-mix(in srgb, var(--nzc-warn) 45%, var(--nzc-border)); background: color-mix(in srgb, var(--nzc-warn) 12%, var(--nzc-card)); }
.nzc-dns-unsaved ul { list-style: none; margin: 6px 0 0; padding: 0; font-size: 13px; color: var(--nzc-muted); }
.nzc-dns-unsaved .nzc-row-actions { display: flex; gap: 8px; }
.nzc-dns-table tr[data-gone] td { text-decoration: line-through; opacity: .55; }
@media (max-width: 900px) { .nzc-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); } .nzc-dns-add { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 12px; } .nzc .nzc-dns-add .nz-field { margin-block-end: 14px; } .nzc-dns-add > .nz-btn { grid-column: 1 / -1; } }

/* ---- data tables: card view (the default) and table view, one <table> restyled; the switch sits top-end ---- */
.nzc .nz-table-wrap { position: relative; }
.nz-view-toggle { position: absolute; inset-block-start: 10px; inset-inline-end: 12px; z-index: 2; display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; border: 1px solid var(--nzc-border); background: var(--nzc-card); }
.nz-view-toggle button { display: grid; place-items: center; inline-size: 30px; block-size: 28px; border: 0; border-radius: 7px; background: transparent; color: var(--nzc-muted); cursor: pointer; }
.nz-view-toggle button:hover { color: var(--nzc-fg); }
.nz-view-toggle button[aria-pressed="true"] { background: var(--nzc-elev); color: var(--nzc-accent); }
.nzc .nz-table-wrap[data-view="table"] .nz-table caption { padding-inline-end: 96px; }
.nzc .nz-manage-col { inline-size: 1%; white-space: nowrap; text-align: end; }

.nzc .nz-table-wrap[data-view="cards"] { border: 0; background: transparent; overflow: visible; }
.nzc .nz-table-wrap[data-view="cards"] .nz-table { display: block; }
.nzc .nz-table-wrap[data-view="cards"] .nz-table caption { display: block; padding: 8px 100px 14px 2px; text-align: start; }
[dir="rtl"] .nzc .nz-table-wrap[data-view="cards"] .nz-table caption { padding: 8px 2px 14px 100px; }
.nzc .nz-table-wrap[data-view="cards"] thead { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.nzc .nz-table-wrap[data-view="cards"] tbody { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 14px; }
.nzc .nz-table-wrap[data-view="cards"] tbody tr { display: flex; flex-direction: column; gap: 2px; padding: 18px 18px 16px; border-radius: 18px; border: 1px solid var(--nzc-border); background: var(--nzc-card); transition: border-color 120ms ease, transform 120ms ease; }
.nzc .nz-table-wrap[data-view="cards"] tbody tr:hover { border-color: color-mix(in srgb, var(--nzc-accent) 40%, var(--nzc-border)); transform: translateY(-1px); }
.nzc .nz-table-wrap[data-view="cards"] tbody tr:hover td { background: transparent; }
.nzc .nz-table-wrap[data-view="cards"] td { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 7px 0; border: 0; border-block-start: 1px solid color-mix(in srgb, var(--nzc-border) 70%, transparent); min-inline-size: 0; overflow-wrap: anywhere; text-align: end; }
.nz-cell-label { display: none; }
.nzc .nz-table-wrap[data-view="cards"] .nz-cell-label { display: inline-flex; align-items: center; gap: 7px; flex: none; max-inline-size: 48%; color: var(--nzc-muted); font-size: 12.5px; text-align: start; }
.nzc .nz-table-wrap[data-view="cards"] .nz-cell-label .nzc-icon { color: var(--nzc-accent); opacity: .85; }
.nzc .nz-table-wrap[data-view="cards"] .nz-cell-value { min-inline-size: 0; }
.nzc .nz-table-wrap[data-view="cards"] td:not([data-label]) { justify-content: flex-start; text-align: start; }
/* the first column is the card's title */
.nzc .nz-table-wrap[data-view="cards"] td:first-child { display: block; padding: 0 0 10px; margin-block-end: 4px; border: 0; font-size: 16px; font-weight: 650; text-align: start; }
.nzc .nz-table-wrap[data-view="cards"] td:first-child .nz-cell-label { display: none; }
.nzc .nz-table-wrap[data-view="cards"] td.nz-manage-col { display: block; inline-size: auto; margin-block-start: auto; padding: 14px 0 0; border: 0; text-align: start; }
.nzc .nz-table-wrap[data-view="cards"] td.nz-manage-col .nz-btn { inline-size: 100%; min-block-size: 40px; }
.nzc .nz-table-wrap[data-view="cards"] td.nz-manage-col:empty { display: none; }

/* rich cards (columns with card roles): icon + badge, subtitle, title, meta, chips, a divider, then footer value + Manage */
.nz-card-icon { display: none; }
.nzc .nz-table-wrap:not([data-view="cards"]) .nz-cell-value > .nzc-icon { display: none; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] tbody { grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 16px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] tbody tr { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; align-content: flex-start; gap: 8px; padding: 20px; border-radius: 20px; background: linear-gradient(180deg, var(--nzc-card-hi), var(--nzc-card)); box-shadow: 0 1px 0 color-mix(in srgb, var(--nzc-fg) 4%, transparent) inset, 0 12px 30px -18px rgba(0, 0, 0, .55); }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td { display: block; padding: 0; margin: 0; border: 0; font-size: 14px; font-weight: 400; text-align: start; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td .nz-cell-label { display: none; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] .nz-card-icon { order: 0; display: block; flex: 0 0 100%; margin-block-end: 6px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] .nz-card-icon > span { display: grid; place-items: center; inline-size: 48px; block-size: 48px; border-radius: 14px; background: var(--nzc-accent-soft); color: var(--nzc-accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nzc-accent) 25%, transparent); }
/* the status sits in front of the name, on the title line */
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="badge"] { order: 3; flex: 0 1 auto; margin-block-start: 2px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="badge"] .nz-cell-value { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="subtitle"] { order: 2; flex: 0 0 100%; margin-block-start: 6px; color: var(--nzc-muted); font-size: 12.5px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="title"] { order: 4; flex: 1 1 140px; min-inline-size: 0; font-size: 17px; font-weight: 700; letter-spacing: -.01em; overflow-wrap: anywhere; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="subtitle"] + td[data-card="title"], .nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="title"] { margin-block-start: 2px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="meta"] { order: 6; flex: 0 0 100%; color: var(--nzc-muted); font-size: 13px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="title"] + td[data-card="meta"], .nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="meta"]:first-of-type { margin-block-start: 6px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="meta"] .nz-cell-value,
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="chip"] .nz-cell-value { display: inline-flex; align-items: center; gap: 6px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="chip"] { order: 7; margin-block-start: 6px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="chip"]:has(.nz-cell-value:empty) { display: none; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="chip"] .nz-cell-value { padding: 4px 10px; border-radius: 8px; background: var(--nzc-elev); border: 1px solid var(--nzc-border); font-size: 12.5px; color: var(--nzc-fg); }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="chip"] .nzc-icon, .nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="meta"] .nzc-icon { color: var(--nzc-accent); }
/* a line break after the status + name line */
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] tbody tr::before { content: ""; order: 5; flex: 0 0 100%; block-size: 0; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] tbody tr::after { content: ""; order: 8; flex: 0 0 100%; block-size: 1px; margin-block: 14px 6px; background: var(--nzc-border); }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="footer"] { order: 9; flex: 1 1 0; min-inline-size: 0; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="footer"] .nz-cell-value { display: block; font-weight: 700; font-size: 15px; overflow-wrap: anywhere; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td.nz-manage-col { order: 10; flex: 0 0 auto; margin: 0 0 0 auto; padding: 0; inline-size: auto; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td.nz-manage-col .nz-btn { inline-size: auto; min-block-size: 40px; padding-inline: 18px; background: var(--nzc-grad); color: var(--nzc-on-accent); border-color: transparent; }

/* ---- on/off as a switch: read-only display (.nzc-onoff) and checkboxes drawn as switches (.nzc-switch-input) ---- */
.nzc-onoff { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--nzc-muted); }
.nzc-onoff::before { content: ""; flex: none; inline-size: 34px; block-size: 20px; border-radius: 999px; background: var(--nzc-elev); border: 1px solid var(--nzc-border); box-shadow: inset 0 0 0 2px var(--nzc-elev); background-image: radial-gradient(circle at 9px 50%, var(--nzc-muted) 6px, transparent 6.5px); }
.nzc-onoff[data-on="true"] { color: var(--nzc-fg); }
.nzc-onoff[data-on="true"]::before { background-color: var(--nzc-accent); border-color: var(--nzc-accent); box-shadow: none; background-image: radial-gradient(circle at 24px 50%, #fff 6.5px, transparent 7px); }
[dir="rtl"] .nzc-onoff::before { transform: scaleX(-1); }
.nzc input[type="checkbox"].nzc-switch-input { inline-size: 40px; block-size: 24px; border-radius: 999px; background-image: radial-gradient(circle at 11px 50%, var(--nzc-muted) 7px, transparent 7.5px); background-color: var(--nzc-elev); background-size: auto; transition: background-position 140ms ease, background-color 140ms ease; }
.nzc input[type="checkbox"].nzc-switch-input:checked { background-color: var(--nzc-accent); border-color: var(--nzc-accent); background-image: radial-gradient(circle at 28px 50%, #fff 8px, transparent 8.5px); background-size: auto; }
[dir="rtl"] .nzc input[type="checkbox"].nzc-switch-input { transform: scaleX(-1); }
.nzc label.nzc-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; border-radius: 12px; background: var(--nzc-field); border: 1px solid var(--nzc-border); }

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
  .nzc-frame, .nzc-switch, .nzc-switch::after, .nzc-rail-link, .nzc-tab .nzc-icon, .nzc .nz-btn, .nzc .nz-input { transition: none; }
  .nzc .nz-skeleton { animation: none; }
}
@media (max-width: 1180px) { .nzc-pill-text { display: none; } .nzc-pill { padding-inline-start: 12px; } }
@media (max-width: 1080px) { .nzc-split { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 900px) {
  .nzc-frame { grid-template-columns: minmax(0, 1fr); margin-inline: 3px; margin-block-end: 0; border-start-start-radius: 16px; border-start-end-radius: 16px; overflow: visible; }
  .nzc-rail { position: fixed; inset-block: var(--top-h) 0; block-size: auto; z-index: 60; transform: translateX(calc(-100% - var(--rail-w) - 12px)); transition: transform 180ms ease; }
  [dir="rtl"] .nzc-rail { transform: translateX(calc(100% + var(--rail-w) + 12px)); }
  .nzc-rail { inset-inline-start: 0; }
  .nzc-app[data-drawer="open"] .nzc-rail { transform: none; }
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

/* prompt-first project start (the domain search hero, with a prompt box instead of a search field) */
.nzc-orb { display: block; inline-size: 44px; block-size: 44px; margin: 0 auto 14px; border-radius: 50%; background: radial-gradient(circle at 32% 28%, #fff 0, color-mix(in srgb, var(--nzc-accent) 85%, #fff) 22%, var(--nzc-accent-strong) 70%); box-shadow: 0 0 0 6px color-mix(in srgb, var(--nzc-accent) 14%, transparent), 0 10px 36px -4px color-mix(in srgb, var(--nzc-accent) 70%, transparent); }
.nzc-prompt-bar > .nzc-prompt-input, .nzc-prompt-bar > .nzc-prompt-foot { background-color: color-mix(in srgb, var(--nzc-bg) 88%, var(--nzc-card)); }
.nzc .nzc-prompt-bar textarea.nzc-prompt-input { display: block; inline-size: 100%; min-block-size: 132px; resize: vertical; padding: 18px 20px 6px !important; border: 0 !important; border-radius: 14.5px 14.5px 0 0 !important; box-shadow: none !important; font-size: 16px; line-height: 1.6; color: var(--nzc-fg); }
.nzc-prompt-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px 10px; padding-inline: 20px 10px; border-radius: 0 0 14.5px 14.5px; }
.nzc-prompt-count { font-size: 12.5px; color: var(--nzc-muted); }
.nzc .nzc-prompt-foot .nz-btn { min-block-size: 44px; padding-inline: 18px 16px; border-radius: 10px; gap: 8px; font-size: 15px; }
[dir="rtl"] .nzc-prompt-foot .nz-btn .nzc-icon { transform: scaleX(-1); }
.nzc-prompt-err { margin: 10px 0 0; text-align: center; }
.nzc .nzc-tlds label.nzc-ptype input[type="radio"] { inline-size: 18px; block-size: 18px; accent-color: var(--nzc-accent); }
.nzc .nzc-tlds label.nzc-ptype:has(input:checked) { border-color: var(--nzc-accent); background: color-mix(in srgb, var(--nzc-accent) 14%, var(--nzc-bg)); }
.nzc .nzc-tlds label.nzc-ptype[data-soon="true"] { opacity: .8; }
.nzc-ptype-name { direction: inherit; font-size: 19px; }
.nzc-prompt-opts { margin-block-start: 18px; text-align: start; }
.nzc-prompt-opts > summary { cursor: pointer; text-align: center; font-size: 13px; font-weight: 600; color: var(--nzc-muted); list-style: none; }
.nzc-prompt-opts > summary::-webkit-details-marker { display: none; }
.nzc-prompt-opts > summary:hover { color: var(--nzc-fg); }
.nzc-prompt-opts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-block-start: 12px; padding: 16px; border-radius: 14px; border: 1px solid color-mix(in srgb, var(--nzc-fg) 8%, transparent); background: color-mix(in srgb, var(--nzc-bg) 72%, transparent); }
.nzc-prompt-opts-grid fieldset { margin: 0; padding: 0; border: 0; }
.nzc-prompt-opts-grid legend, .nzc-prompt-field > span { display: block; margin-block-end: 6px; font-size: 13px; font-weight: 600; }
.nzc-prompt-field { display: grid; gap: 4px; align-content: start; }
.nzc-prompt-check { display: block; padding-block: 3px; }
.nzc-pex-wrap { margin-block: 26px 28px; }
.nzc-pex-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.nzc .nzc-pex { display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; gap: 14px; inline-size: 100%; min-block-size: 112px; padding: 16px; text-align: start; border-radius: 14px; border: 1px solid var(--nzc-border); background: color-mix(in srgb, var(--nzc-card) 92%, var(--nzc-bg)); color: var(--nzc-fg); font: inherit; font-size: 14px; line-height: 1.5; cursor: pointer; transition: border-color 120ms ease, transform 120ms ease, background-color 120ms ease; }
.nzc .nzc-pex:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--nzc-accent) 50%, transparent); background: color-mix(in srgb, var(--nzc-accent) 8%, var(--nzc-card)); }
.nzc .nzc-pex .nzc-icon { color: var(--nzc-accent); }
.nzc-yp-head { margin-block: 8px 12px; font-size: 18px; font-weight: 650; }
@media (max-width: 640px) { .nzc-prompt-foot { flex-wrap: wrap; } }
`;
