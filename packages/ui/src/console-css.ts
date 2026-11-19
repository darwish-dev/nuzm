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
  /* the brand's own tones (teal-sage #93b6b3, mint #bcdccb, #cfe8da, deep slate #587079): the light theme's counterpart of the dark theme's slate-to-sage chrome */
  --nzc-chrome: linear-gradient(98deg, #8fb2af 0%, #a9cbc1 34%, #bcdccb 62%, #d3ebdd 100%);
  --nzc-chrome-glow: radial-gradient(40rem 14rem at 10% -3rem, rgba(88, 112, 121, 0.34), transparent 70%), radial-gradient(40rem 14rem at 92% -2rem, rgba(255, 255, 255, 0.5), transparent 70%);
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
/* tooltip: shown on hover and keyboard focus, never the only label (the link has aria-label). Fixed, because the rail scrolls and would clip an absolutely placed one; RailTips sets --nzc-tip-y. */
.nzc-rail-link[data-tip]::after { content: attr(data-tip); position: fixed; inset-inline-start: calc(var(--rail-w) + 14px); inset-block-start: var(--nzc-tip-y, 50%); transform: translateY(-50%); white-space: nowrap; background: var(--nzc-elev); color: var(--nzc-fg); border: 1px solid var(--nzc-border); border-radius: 8px; padding: 4px 10px; font-size: 12.5px; box-shadow: var(--nzc-shadow); opacity: 0; pointer-events: none; transition: opacity 120ms ease; z-index: 40; }
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
/* top bar: the organization chip (icon link to the workspaces + switcher) and the notifications pop-up share the 38px height of the balance chips */
.nzc-org { padding-inline: 0; gap: 0; overflow: hidden; }
.nzc-org > a { display: inline-grid; place-items: center; align-self: stretch; inline-size: 38px; color: var(--nzc-accent) !important; text-decoration: none !important; border-inline-end: 1px solid var(--nzc-border); }
.nzc-org > a:hover { background: var(--nzc-elev); }
.nzc .nzc-org select { border: 0; border-radius: 0; background-color: transparent; background-position: calc(100% - 12px) center; font-size: inherit; font-weight: 550; block-size: 36px; min-block-size: 0; padding-block: 0; padding-inline: 12px 34px; max-inline-size: 170px; text-overflow: ellipsis; box-shadow: none; }
[dir="rtl"] .nzc .nzc-org select { background-position: 12px center; }
.nzc .nzc-org select:hover, .nzc .nzc-org select:focus { background-color: var(--nzc-elev); box-shadow: none; }
.nzc-org:focus-within { border-color: var(--nzc-accent); }
.nzc-org select option { color: initial; }
.nzc-notif-panel { inline-size: 380px; max-inline-size: calc(100vw - 24px); padding: 0; overflow: hidden; }
.nzc-notif-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-block-end: 1px solid var(--nzc-border); font-weight: 600; }
.nzc-notif-list { list-style: none; margin: 0; padding: 6px; max-block-size: 380px; overflow-y: auto; display: grid; gap: 2px; }
.nzc-notif-list li { display: flex; align-items: flex-start; gap: 10px; padding: 10px 10px; border-radius: 8px; }
.nzc-notif-list li[data-read="false"] { background: var(--nzc-card); }
.nzc-notif-list .nzc-notif-text { flex: 1; min-inline-size: 0; font-size: 13.5px; line-height: 1.5; }
.nzc-notif-list li[data-read="false"] .nzc-notif-text { font-weight: 600; }
.nzc-notif-list .nzc-notif-when { display: block; color: var(--nzc-muted); font-size: 12px; font-weight: 400; }
.nzc-notif-panel .nzc-notif-toggle { inline-size: auto; min-block-size: 30px; padding-inline: 10px; font-size: 12.5px; border: 1px solid var(--nzc-border); flex: none; }
.nzc-notif-empty { padding: 28px 14px; text-align: center; color: var(--nzc-muted); }
.nzc-notif-foot { border-block-start: 1px solid var(--nzc-border); padding: 6px; }
.nzc-notif-foot a { justify-content: center; color: var(--nzc-accent) !important; }
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
/* dense data entry: three fields per row and tighter controls (admin settings forms); 2 columns <= 1000px, 1 column <= 560px */
.nzc-form-grid--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 14px; }
.nzc-form-grid--3 .nzc-span-2 { grid-column: span 2; }
.nzc .nzc-dense .nz-field { gap: 6px; margin-block-end: 14px; }
.nzc .nzc-dense .nz-field label { font-size: 13px; }
.nzc .nzc-dense .nz-help { font-size: 12px; line-height: 1.45; }
.nzc .nzc-dense .nz-input, .nzc .nzc-dense select, .nzc .nzc-dense input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]) { min-block-size: 42px; padding-inline: 12px; font-size: 14px; border-radius: 11px; }
.nzc .nzc-dense textarea { min-block-size: 0; padding: 10px 12px; font-size: 13px; line-height: 1.5; border-radius: 11px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.nzc .nzc-dense .nzc-form-foot .nz-btn { min-block-size: 42px; padding-inline: 20px; }
.nzc .nz-card.nzc-dense { padding: 18px 20px; }
.nzc-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px 20px; flex-wrap: wrap; margin-block-end: 16px; padding-block-end: 12px; border-block-end: 1px solid var(--nzc-border); }
.nzc-panel-head h2, .nzc-panel-head h3 { margin: 0; font-size: 16px; }
.nzc-panel-head p { margin: 4px 0 0; max-inline-size: 72ch; font-size: 13px; }
.nzc-inline-row { display: grid; grid-template-columns: minmax(0, 2fr) auto; align-items: start; gap: 0 12px; }
.nzc-inline-row > .nz-row { padding-block-start: 26px; }
@media (max-width: 1000px) { .nzc-form-grid--3 { grid-template-columns: repeat(2, minmax(0, 1fr)); } .nzc-form-grid--3 .nzc-span-2 { grid-column: 1 / -1; } }
@media (max-width: 560px) { .nzc-form-grid--3 { grid-template-columns: minmax(0, 1fr); } .nzc-inline-row { grid-template-columns: minmax(0, 1fr); } .nzc-inline-row > .nz-row { padding-block-start: 0; } }
.nzc details.nzc-adv > summary { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border: 1px solid var(--nzc-border); border-radius: 14px; background: var(--nzc-card); cursor: pointer; font-weight: 600; font-size: 14px; list-style: none; }
.nzc details.nzc-adv > summary::-webkit-details-marker { display: none; }
.nzc details.nzc-adv > summary::before { content: ""; inline-size: 7px; block-size: 7px; border-inline-end: 2px solid var(--nzc-muted); border-block-end: 2px solid var(--nzc-muted); transform: rotate(-45deg); transition: transform 120ms ease; }
[dir="rtl"] .nzc details.nzc-adv > summary::before { transform: rotate(45deg); }
.nzc details.nzc-adv[open] > summary::before { transform: rotate(45deg); }
.nzc details.nzc-adv[open] > summary { margin-block-end: 14px; border-end-start-radius: 14px; }
.nzc details.nzc-adv > summary:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }

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
  .nzc-rail-link[data-tip]::after { display: none; }
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
/* the builder start page is full screen: no body padding, the prompt card fills the area (the examples sit below it), and "your projects" scroll in underneath */
.nzc-body:has(> .nzc-start-full) { padding: 0; }
.nzc-body > .nzc-start-full { max-inline-size: none; margin: 0; min-block-size: 100%; display: flex; flex-direction: column; }
.nzc-start-full > .nzc-dsearch { flex: 1; display: flex; flex-direction: column; justify-content: center; margin: 0; border: 0; border-radius: 0; }
.nzc-start-full > .nzc-dsearch .nzc-dsearch-inner { inline-size: 100%; }
.nzc-start-full > .nzc-pex-wrap { padding: 8px 36px 40px; max-inline-size: 1100px; margin-inline: auto; inline-size: 100%; }
.nzc-body > .nzc-start-projects { padding: 30px 36px 56px; }
/* "get a new cloud server": the choices on the start side, the live summary and monthly price on the other (below it on a narrow screen) */
.nzc-cfg { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 28px; align-items: start; text-align: start; }
.nzc-cfg-main { display: grid; gap: 28px; min-inline-size: 0; }
.nzc-cfg-h { margin: 0 0 12px; font-size: 13px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--nzc-muted); }
.nzc-cfg .nzc-tlds { margin-block-start: 0; }
.nzc-cfg .nzc-tlds-grid { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
.nzc .nzc-tlds label.nzc-opt input[type="radio"] { inline-size: 18px; block-size: 18px; accent-color: var(--nzc-accent); }
.nzc .nzc-tlds label.nzc-opt:has(input:checked) { border-color: var(--nzc-accent); background: color-mix(in srgb, var(--nzc-accent) 14%, var(--nzc-bg)); }
.nzc .nzc-tlds label.nzc-opt:has(input:focus-visible) { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }
.nzc-opt-name { font-size: 17px; font-weight: 650; line-height: 1.25; color: var(--nzc-fg); unicode-bidi: isolate; }
.nzc-opt-from { color: var(--nzc-fg); font-weight: 600; }
.nzc-cfg-sum { position: sticky; inset-block-start: 16px; display: grid; gap: 14px; padding: 20px; border-radius: 16px; border: 1px solid color-mix(in srgb, var(--nzc-accent) 28%, var(--nzc-border)); background: color-mix(in srgb, var(--nzc-accent) 6%, var(--nzc-card)); }
.nzc-cfg-sum .nzc-cfg-h { margin: 0; }
.nzc-cfg-sum dl { margin: 0; display: grid; gap: 10px; }
.nzc-cfg-sum dl > div { display: grid; gap: 2px; }
.nzc-cfg-sum dt { font-size: 12px; color: var(--nzc-muted); }
.nzc-cfg-sum dd { margin: 0; font-weight: 550; }
.nzc-cfg-price { display: grid; gap: 2px; margin: 4px 0 0; padding-block-start: 14px; border-block-start: 1px solid var(--nzc-border); }
.nzc-cfg-price strong { font-size: 28px; line-height: 1.15; }
.nzc-cfg-sum .nzc-dsearch-note { margin: 0; text-align: start; }
.nzc-cfg-sum .nz-btn { inline-size: 100%; min-block-size: 46px; }
@media (max-width: 1000px) { .nzc-cfg { grid-template-columns: minmax(0, 1fr); } .nzc-cfg-sum { position: static; } }
/* hosting shop: types as tabs, plans as cards, a comparison table, what every plan includes, a short FAQ */
.nzc-shop { display: grid; gap: 22px; }
.nzc-shop-head { text-align: center; padding-block: 10px 0; }
.nzc-shop-head h2 { margin: 0 0 8px; font-size: clamp(22px, 2.6vw, 32px); font-weight: 700; letter-spacing: -.02em; }
.nzc-shop-head p { margin: 0; color: var(--nzc-muted); }
.nzc-shop-card { border: 1px solid var(--nzc-border); border-radius: 20px; background: var(--nzc-card); padding: 18px; }
.nzc-shop-tabs { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 4px; border-radius: 14px; background: var(--nzc-field); border: 1px solid var(--nzc-border); }
.nzc-shop-tabs button { border: 0; background: transparent; color: var(--nzc-muted); font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 10px; cursor: pointer; }
.nzc-shop-tabs button:hover { color: var(--nzc-fg); }
.nzc-shop-tabs button[aria-selected="true"] { background: var(--nzc-elev); color: var(--nzc-fg); box-shadow: inset 0 0 0 1px var(--nzc-border); }
.nzc-shop-tabs button:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 1px; }
.nzc-shop-tag { margin: 16px 2px 14px; color: var(--nzc-muted); }
.nzc-shop-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
.nzc-shop-plan { display: grid; gap: 12px; align-content: start; padding: 20px; border-radius: 16px; border: 1px solid var(--nzc-border); background: var(--nzc-bg); }
.nzc-shop-plan h3 { margin: 0; font-size: 19px; font-weight: 700; }
.nzc-shop-price { margin: 0; min-block-size: 40px; display: flex; align-items: center; font-size: 15px; }
.nzc-shop-price strong { font-size: 28px; line-height: 1.1; }
.nzc-shop-plan .nz-btn { inline-size: 100%; min-block-size: 44px; }
.nzc-shop-specs { list-style: none; margin: 4px 0 0; padding: 14px 0 0; border-block-start: 1px solid var(--nzc-border); display: grid; gap: 10px; font-size: 14px; }
.nzc-shop-specs li { display: flex; gap: 10px; align-items: flex-start; }
.nzc-shop-specs .nzc-icon, .nzc-shop-every .nzc-icon { color: var(--nzc-accent); flex: none; margin-block-start: 3px; }
.nzc-shop-runtimes { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 12px; border-radius: 12px; background: var(--nzc-field); font-size: 13px; }
.nzc-shop-chip { padding: 3px 9px; border-radius: 999px; border: 1px solid var(--nzc-border); background: var(--nzc-card); font-weight: 600; font-size: 12.5px; }
.nzc-shop-compare-btn { display: flex; align-items: center; justify-content: center; gap: 8px; inline-size: 100%; margin-block-start: 16px; padding: 14px; border-radius: 14px; border: 1px solid var(--nzc-border); background: transparent; color: var(--nzc-accent); font: inherit; font-weight: 650; cursor: pointer; }
.nzc-shop-compare-btn:hover { background: var(--nzc-elev); }
.nzc-shop-chev { display: inline-grid; transform: rotate(90deg); transition: transform 140ms ease; }
.nzc-shop-chev[data-open="true"] { transform: rotate(-90deg); }
.nzc-shop-table-wrap { margin-block-start: 14px; overflow-x: auto; border: 1px solid var(--nzc-border); border-radius: 14px; }
.nzc-shop-table { inline-size: 100%; border-collapse: collapse; min-inline-size: 520px; }
.nzc-shop-table th, .nzc-shop-table td { padding: 14px 16px; text-align: center; border-block-end: 1px solid var(--nzc-border); }
.nzc-shop-table thead th { vertical-align: top; font-weight: 700; background: var(--nzc-field); }
.nzc-shop-table thead th > span { display: block; margin-block-end: 10px; }
.nzc-shop-table thead .nz-btn { min-block-size: 38px; }
.nzc-shop-table tbody th { text-align: start; font-weight: 550; color: var(--nzc-muted); }
.nzc-shop-table thead th:first-child { text-align: start; }
.nzc-shop-table tbody tr:last-child > * { border-block-end: 0; }
.nzc-shop-yes { color: var(--nzc-accent); display: inline-grid; }
.nzc-shop-every { border: 1px solid var(--nzc-border); border-radius: 20px; background: var(--nzc-card); padding: 22px 24px; display: grid; grid-template-columns: minmax(180px, 1fr) minmax(0, 2fr); gap: 16px 28px; align-items: center; }
.nzc-shop-every h3 { margin: 0; font-size: 22px; line-height: 1.3; }
.nzc-shop-every ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px 22px; }
.nzc-shop-every li { display: flex; gap: 10px; align-items: flex-start; font-size: 14.5px; }
.nzc-shop-faq { border: 1px solid var(--nzc-border); border-radius: 20px; background: var(--nzc-card); padding: 22px 24px; display: grid; gap: 10px; }
.nzc-shop-faq h3 { margin: 0 0 6px; font-size: 22px; text-align: center; }
.nzc-shop-faq details { border: 1px solid var(--nzc-border); border-radius: 14px; background: var(--nzc-bg); }
.nzc-shop-faq summary { cursor: pointer; padding: 16px 18px; font-weight: 600; list-style: none; display: flex; justify-content: space-between; gap: 12px; }
.nzc-shop-faq summary::-webkit-details-marker { display: none; }
.nzc-shop-faq summary::after { content: '+'; color: var(--nzc-muted); font-size: 20px; line-height: 1; }
.nzc-shop-faq details[open] summary::after { content: '–'; }
.nzc-shop-faq details p { margin: 0; padding: 0 18px 16px; color: var(--nzc-muted); }
@media (max-width: 800px) { .nzc-shop-every { grid-template-columns: minmax(0, 1fr); } }
/* add a website: how do you want to build it? */
.nzc-methods { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-block-start: 6px; }
.nzc-method { display: grid; gap: 8px; align-content: start; padding: 20px; border-radius: 16px; border: 1px solid var(--nzc-border); background: var(--nzc-card); color: var(--nzc-fg) !important; text-decoration: none !important; position: relative; transition: border-color 120ms ease, transform 120ms ease; }
a.nzc-method:hover { border-color: var(--nzc-accent); transform: translateY(-2px); }
.nzc-method[data-soon="true"] { opacity: .7; }
.nzc-method[data-featured="true"] { border-color: color-mix(in srgb, var(--nzc-accent) 55%, var(--nzc-border)); background: color-mix(in srgb, var(--nzc-accent) 9%, var(--nzc-card)); }
.nzc-method-ico { display: grid; place-items: center; inline-size: 44px; block-size: 44px; border-radius: 12px; background: var(--nzc-field); color: var(--nzc-accent); }
.nzc-method h3 { margin: 4px 0 0; font-size: 17px; font-weight: 700; }
.nzc-method p { margin: 0; font-size: 13.5px; color: var(--nzc-muted); }
.nzc-method .nz-badge, .nzc-method .nzc-method-soon { position: absolute; inset-block-start: 14px; inset-inline-end: 14px; }
.nzc-method-soon { font-size: 11.5px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--nzc-border); color: var(--nzc-muted); }
.nzc-method-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-block-end: 14px; padding: 12px 16px; border-radius: 14px; border: 1px solid var(--nzc-border); background: var(--nzc-field); }
/* illustrations: flat shapes in the theme's accent tones (decorative, hidden from assistive technology) */
.nzc-art { display: block; inline-size: 100%; block-size: auto; }
.nzc-art-a { fill: var(--nzc-accent); }
.nzc-art-a2 { fill: color-mix(in srgb, var(--nzc-accent) 62%, transparent); }
.nzc-art-a3 { fill: color-mix(in srgb, var(--nzc-accent) 34%, transparent); }
.nzc-art-c { fill: color-mix(in srgb, var(--nzc-fg) 11%, var(--nzc-card)); }
.nzc-art-m { fill: color-mix(in srgb, var(--nzc-fg) 24%, transparent); }
.nzc-art-s { fill: color-mix(in srgb, var(--nzc-fg) 9%, transparent); }
.nzc-art-t { fill: var(--nzc-fg); font-family: inherit; }
.nzc-art-on { stroke: var(--nzc-on-accent); fill: none; }
.nzc-art-g { stroke: color-mix(in srgb, var(--nzc-accent) 75%, transparent); }
/* a hero card with art: the text and the actions on the start side, the drawing on the other */
.nzc-hero[data-art] { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 360px); align-items: center; gap: 24px 36px; padding-block: 30px; }
.nzc-hero-main { position: relative; display: grid; gap: 22px; align-content: center; }
.nzc-hero[data-art] .nzc-hero-text { max-inline-size: 560px; }
.nzc-hero[data-art] .nzc-hero-text h2 { font-size: clamp(22px, 2.4vw, 30px); letter-spacing: -.02em; }
.nzc-hero[data-art] .nzc-hero-text p { font-size: 15px; line-height: 1.6; }
.nzc-hero-art { position: relative; max-inline-size: 360px; justify-self: end; }
@media (max-width: 900px) { .nzc-hero[data-art] { grid-template-columns: minmax(0, 1fr); } .nzc-hero-art { display: none; } }
/* the domain search page: a drawing above the heading */
.nzc-dsearch-art { max-inline-size: 230px; margin: 0 auto 6px; }
/* the hosting shop's type header and the plan cards: an accent mark, the name, then the limits */
.nzc-shop-type { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 220px); align-items: center; gap: 16px 28px; padding: 6px 4px 14px; }
.nzc-shop-type p { margin: 0; color: var(--nzc-muted); font-size: 15px; line-height: 1.6; }
.nzc-shop-type strong { display: block; margin-block-end: 4px; color: var(--nzc-fg); font-size: 20px; letter-spacing: -.01em; }
@media (max-width: 700px) { .nzc-shop-type { grid-template-columns: minmax(0, 1fr); } .nzc-shop-type .nzc-art { display: none; } }
.nzc-shop-plan-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.nzc-shop-plan-top .nzc-shop-mark { display: grid; place-items: center; inline-size: 38px; block-size: 38px; border-radius: 12px; background: var(--nzc-accent-soft); color: var(--nzc-accent); }
.nzc-shop-price .nzc-shop-from { font-size: 13px; color: var(--nzc-muted); }
.nzc-shop-plan { transition: background-color 140ms ease, transform 140ms ease; }
.nzc-shop-plan:hover { transform: translateY(-2px); }
/* size cards of the cloud configurator: the three numbers that decide the price, big and in a row */
.nzc-opt-specs { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; margin-block-start: 2px; }
.nzc-opt-specs span { display: grid; gap: 1px; padding: 8px 10px; border-radius: 10px; background: color-mix(in srgb, var(--nzc-fg) 6%, transparent); font-size: 12px; color: var(--nzc-muted); }
.nzc-opt-specs b { white-space: nowrap; font-size: 17px; color: var(--nzc-fg); line-height: 1.1; unicode-bidi: isolate; }
.nzc-opt-code { display: inline-grid; place-items: center; min-inline-size: 30px; block-size: 24px; padding-inline: 6px; border-radius: 8px; background: var(--nzc-accent-soft); color: var(--nzc-accent); font-size: 12px; font-weight: 700; letter-spacing: .04em; }
.nzc-cfg-step { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; font-size: 13px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--nzc-muted); }
.nzc-cfg-step > i { display: inline-grid; place-items: center; inline-size: 24px; block-size: 24px; border-radius: 50%; background: var(--nzc-accent); color: var(--nzc-on-accent); font-style: normal; font-size: 12px; letter-spacing: 0; }
/* contrast: the "send again" button on the warm pill must reach 4.5:1 in the light theme too */
.nzc[data-theme="light"] .nzc-pill button { color: #ffffff; }
/* labels that are cards act like buttons: the pointer says so */
.nzc label.nzc-opt, .nzc label.nzc-tld, .nzc label.nzc-plan { cursor: pointer; }
@media (prefers-reduced-motion: reduce) { .nzc-shop-plan, a.nzc-method { transition: none; } .nzc-shop-plan:hover, a.nzc-method:hover { transform: none; } }
/* showcase header: a soft glow, a pill, a big headline and a device showing the product (the look of a case-study cover, in the console's own tones) */
.nzc-showcase { position: relative; overflow: hidden; display: grid; justify-items: center; gap: 14px; padding: 44px 24px 0; border-radius: 28px; text-align: center;
  background: radial-gradient(52rem 24rem at 50% -8rem, color-mix(in srgb, var(--nzc-accent) 40%, transparent), transparent 72%), radial-gradient(30rem 18rem at 88% 70%, color-mix(in srgb, var(--nzc-accent-strong) 22%, transparent), transparent 70%), var(--nzc-card); }
.nzc-showcase-pill { padding: 7px 16px; border-radius: 999px; background: color-mix(in srgb, var(--nzc-fg) 9%, transparent); font-size: 13px; font-weight: 600; letter-spacing: .04em; }
.nzc-showcase h2 { margin: 0; max-inline-size: 18ch; font-size: clamp(30px, 4.4vw, 54px); line-height: 1.08; letter-spacing: -.03em; font-weight: 750; text-wrap: balance; }
.nzc-showcase p { margin: 0; max-inline-size: 52ch; color: var(--nzc-muted); font-size: 16px; line-height: 1.6; }
.nzc-showcase-device { inline-size: min(720px, 100%); margin-block-start: 22px; }
@media (max-width: 700px) { .nzc-showcase-device { display: none; } .nzc-showcase { padding-block-end: 36px; } }
/* the floating basket: an overlay (so it keeps a soft shadow), bottom corner of every page, collapsed to a round button with the count */
.nzc-cart { position: fixed; inset-block-end: 22px; inset-inline-end: 22px; z-index: 55; display: grid; gap: 12px; justify-items: end; max-inline-size: calc(100vw - 32px); }
.nzc-cart-panel { inline-size: min(370px, calc(100vw - 32px)); max-block-size: min(70vh, 640px); overflow-y: auto; padding: 18px; border-radius: 24px; background: var(--nzc-elev); box-shadow: var(--nzc-shadow); display: grid; gap: 12px; animation: nzc-cart-in 280ms cubic-bezier(.16, 1, .3, 1) both; }
@keyframes nzc-cart-in { from { opacity: 0; transform: translateY(14px) scale(.98); } to { opacity: 1; transform: none; } }
.nzc-cart-head { display: flex; align-items: baseline; gap: 10px; }
.nzc-cart-head strong { font-size: 17px; }
.nzc-cart-head .nzc-cart-x { margin-inline-start: auto; align-self: center; }
.nzc-cart-x { display: inline-grid; place-items: center; inline-size: 30px; block-size: 30px; border-radius: 10px; border: 0; background: transparent; color: var(--nzc-muted); cursor: pointer; flex: none; }
.nzc-cart-x:hover { background: color-mix(in srgb, var(--nzc-fg) 9%, transparent); color: var(--nzc-fg); }
.nzc-cart-lines { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.nzc-cart-lines li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; padding: 10px 10px 10px 12px; border-radius: 14px; background: color-mix(in srgb, var(--nzc-fg) 6%, transparent); }
.nzc-cart-line-main { display: grid; gap: 1px; min-inline-size: 0; }
.nzc-cart-line-main b { font-size: 14.5px; overflow-wrap: anywhere; }
.nzc-cart-line-main .nz-muted { font-size: 12px; }
.nzc-cart-line-price { font-weight: 650; font-size: 14px; white-space: nowrap; }
.nzc-cart-total { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding-block-start: 6px; font-size: 15px; }
.nzc-cart-total strong { font-size: 22px; letter-spacing: -.01em; }
.nzc-cart-note { margin: 0; font-size: 12.5px; color: var(--nzc-muted); }
.nzc-cart-panel .nz-btn { inline-size: 100%; min-block-size: 46px; }
.nzc-cart-clear { border: 0; background: transparent; color: var(--nzc-muted); font: inherit; font-size: 13px; cursor: pointer; padding: 4px; justify-self: center; text-decoration: underline; text-underline-offset: 3px; }
.nzc-cart-clear:hover { color: var(--nzc-fg); }
.nzc-cart-fab { position: relative; display: grid; place-items: center; inline-size: 60px; block-size: 60px; border-radius: 50%; border: 0; background: var(--nzc-grad); color: var(--nzc-on-accent); cursor: pointer; box-shadow: var(--nzc-shadow); transition: transform 140ms ease; }
.nzc-cart-fab:hover { transform: translateY(-2px); }
.nzc-cart-fab:focus-visible { outline: 3px solid var(--nzc-fg); outline-offset: 3px; }
.nzc-cart-badge { position: absolute; inset-block-start: -4px; inset-inline-end: -4px; min-inline-size: 22px; block-size: 22px; padding-inline: 5px; display: grid; place-items: center; border-radius: 999px; background: var(--nzc-fg); color: var(--nzc-bg); font-size: 12px; font-weight: 700; }
@media (prefers-reduced-motion: reduce) { .nzc-cart-panel { animation: none; } .nzc-cart-fab { transition: none; } .nzc-cart-fab:hover { transform: none; } }
/* checkout */
.nzc-co { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 24px; align-items: start; }
.nzc-co-main { display: grid; gap: 16px; min-inline-size: 0; }
.nzc-co-card { padding: 22px; border-radius: 20px; background: var(--nzc-card); display: grid; gap: 16px; }
.nzc-co-card h2, .nzc-co-card h3 { margin: 0; font-size: 18px; }
.nzc-co-steps { list-style: none; margin: 0 0 4px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.nzc-co-steps li { display: flex; align-items: center; gap: 8px; padding: 7px 14px 7px 8px; border-radius: 999px; background: var(--nzc-card); color: var(--nzc-muted); font-size: 13.5px; font-weight: 600; }
.nzc-co-steps li > i { display: inline-grid; place-items: center; inline-size: 24px; block-size: 24px; border-radius: 50%; background: color-mix(in srgb, var(--nzc-fg) 10%, transparent); font-style: normal; font-size: 12px; }
.nzc-co-steps li[aria-current="step"] { color: var(--nzc-fg); background: color-mix(in srgb, var(--nzc-accent) 18%, var(--nzc-card)); }
.nzc-co-steps li[aria-current="step"] > i, .nzc-co-steps li[data-done="true"] > i { background: var(--nzc-accent); color: var(--nzc-on-accent); }
.nzc-co-line { display: grid; gap: 12px; padding: 16px; border-radius: 16px; background: var(--nzc-card-hi); }
.nzc-co-line-head { display: flex; align-items: center; gap: 10px; }
.nzc-co-line-head b { font-size: 16px; }
.nzc-co-line-head .nz-muted { font-size: 13px; }
.nzc-co-line-head .nzc-co-line-price { margin-inline-start: auto; font-weight: 700; }
.nzc-co-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px 16px; }
.nzc-co-methods { display: grid; gap: 8px; }
.nzc-co-method { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 14px; background: var(--nzc-card-hi); cursor: pointer; }
.nzc-co-method:has(input:checked) { background: color-mix(in srgb, var(--nzc-accent) 18%, var(--nzc-card)); }
.nzc-co-method input { inline-size: 18px; block-size: 18px; accent-color: var(--nzc-accent); }
.nzc-co-method small { color: var(--nzc-muted); }
.nzc-co-sum { position: sticky; inset-block-start: 16px; padding: 20px; border-radius: 20px; background: color-mix(in srgb, var(--nzc-accent) 8%, var(--nzc-card)); display: grid; gap: 12px; }
.nzc-co-sum h2 { margin: 0; font-size: 16px; }
.nzc-co-sum dl { margin: 0; display: grid; gap: 8px; }
.nzc-co-sum dl > div { display: flex; justify-content: space-between; gap: 10px; font-size: 14px; }
.nzc-co-sum dd { margin: 0; }
.nzc-co-total { padding-block-start: 10px; font-size: 15px; }
.nzc-co-total dd { font-size: 24px; font-weight: 750; }
.nzc-co-foot { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.nzc-co-done li { display: flex; gap: 10px; align-items: center; padding: 12px 14px; border-radius: 14px; background: var(--nzc-card-hi); list-style: none; }
.nzc-co-done { margin: 0; padding: 0; display: grid; gap: 8px; }
@media (max-width: 980px) { .nzc-co { grid-template-columns: minmax(0, 1fr); } .nzc-co-sum { position: static; } }
/* ===== sign-in / sign-up: a brand panel beside the form ===== */
.nzc-split { min-block-size: 100vh; display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 16px; padding: 16px; background: var(--nzc-bg); }
.nzc-split-panel { position: relative; overflow: hidden; display: flex; align-items: flex-end; min-block-size: calc(100vh - 32px); padding: 44px 40px; border-radius: 30px; color: #f4f0e8;
  background: radial-gradient(60% 38% at 24% 6%, rgba(255, 255, 255, 0.55), transparent 72%), linear-gradient(180deg, #cfe8da 0%, #93b6b3 22%, #587079 50%, #34434d 74%, #1b1f23 100%); }
.nzc-split-glow { position: absolute; inset-inline: 8%; inset-block-start: -12%; block-size: 62%; border-radius: 50%; background: radial-gradient(closest-side, rgba(255, 255, 255, 0.4), transparent); filter: blur(26px); pointer-events: none; }
.nzc-split-content { position: relative; inline-size: min(100%, 420px); margin-inline: auto; display: grid; gap: 14px; justify-items: center; text-align: center; }
.nzc-split-logo { display: inline-block; margin-block-end: 8px; }
.nzc-split-panel .nzc-logo, .nzc[data-theme="light"] .nzc-split-panel .nzc-logo { filter: none; block-size: 34px; }
.nzc-split-headline { margin: 0; font-size: clamp(30px, 3.4vw, 42px); line-height: 1.1; font-weight: 750; letter-spacing: -0.025em; text-wrap: balance; }
.nzc-split-sub { margin: 0; max-inline-size: 38ch; color: rgba(244, 240, 232, 0.82); line-height: 1.55; }
.nzc-split-list { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 8px; inline-size: 100%; }
.nzc-split-list li { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 14px; background: rgba(255, 255, 255, 0.1); color: #f4f0e8; font-weight: 600; text-align: start; }
.nzc-split-list li > i { flex: none; display: inline-grid; place-items: center; inline-size: 26px; block-size: 26px; border-radius: 50%; background: rgba(255, 255, 255, 0.18); font-style: normal; font-size: 12px; }
.nzc-split-list li[data-state="current"] { background: #f4f0e8; color: #14181b; }
.nzc-split-list li[data-state="current"] > i { background: #14181b; color: #f4f0e8; }
.nzc-split-list li[data-state="done"] > i { background: #bcdccb; color: #14181b; }
.nzc-split-main { display: flex; flex-direction: column; min-inline-size: 0; padding: 8px 24px 24px; }
.nzc-split-top { display: flex; justify-content: flex-end; padding-block: 8px; }
.nzc-split-card { margin: auto; inline-size: min(100%, 440px); display: grid; gap: 16px; padding-block: 24px; }
.nzc-split-card h1 { margin: 0; text-align: center; font-size: 28px; letter-spacing: -0.02em; }
.nzc-split-card-sub { margin: -6px 0 4px; text-align: center; color: var(--nzc-muted); }
.nzc-split-card form { max-inline-size: none !important; display: grid; gap: 14px; }
.nzc-split-card .nz-btn { inline-size: 100%; min-block-size: 50px; border-radius: 12px; justify-content: center; }
.nzc-split-links { margin: 0; text-align: center; color: var(--nzc-muted); font-size: 14px; }
.nzc-or { display: flex; align-items: center; gap: 14px; color: var(--nzc-muted); font-size: 13px; }
.nzc-or::before, .nzc-or::after { content: ''; flex: 1; block-size: 1px; background: color-mix(in srgb, var(--nzc-fg) 14%, transparent); }
.nzc-pw { position: relative; display: block; }
.nzc-pw input { inline-size: 100%; padding-inline-end: 52px; }
.nzc-pw-toggle { position: absolute; inset-block: 0; inset-inline-end: 8px; margin-block: auto; inline-size: 38px; block-size: 38px; display: grid; place-items: center; border: 0; border-radius: 10px; background: transparent; color: var(--nzc-muted); cursor: pointer; }
.nzc-pw-toggle:hover { background: color-mix(in srgb, var(--nzc-fg) 9%, transparent); color: var(--nzc-fg); }
.nzc-pw-toggle:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 1px; }
@media (max-width: 900px) {
  .nzc-split { grid-template-columns: minmax(0, 1fr); padding: 10px; }
  .nzc-split-panel { min-block-size: 0; align-items: flex-start; padding: 26px 22px; border-radius: 24px; }
  .nzc-split-list, .nzc-split-sub { display: none; }
  .nzc-split-headline { font-size: 26px; }
  .nzc-split-main { padding-inline: 8px; }
}
.nzc-yp-head { margin-block: 8px 12px; font-size: 18px; font-weight: 650; }
@media (max-width: 640px) { .nzc-prompt-foot { flex-wrap: wrap; } }
/* ================= flat surfaces ==========   Cards and chips are told apart by their FILL (page < card < raised), never by a stroke or a shadow. A selected card is a stronger tint instead of an
   outline. Inputs keep their border (it is what says "type here"), overlays (menus, tooltips) keep a soft shadow (they float over content), and
   keyboard focus keeps its outline: removing that would make the console unusable without a mouse. */
.nzc .nz-card, .nzc .nz-table-wrap, .nzc-hero, .nzc-dsearch, .nzc .nzc-tlds label.nzc-tld, .nzc-dres-best, .nzc-dres-list, .nzc-rhead, .nzc-facts,
.nzc-navcard, .nzc-quota, .nzc .nzc-plans label.nzc-plan, .nzc-panel, .nzc-action, .nzc .nzc-callout, .nzc-stat, .nzc-stat[data-featured="true"], .nzc-tile,
.nzc-prompt-opts-grid, .nzc .nzc-pex, .nzc-cfg-sum, .nzc-shop-card, .nzc-shop-plan, .nzc-shop-every, .nzc-shop-faq, .nzc-shop-faq details, .nzc-method,
.nzc-method-bar, .nzc label.nzc-switch-row, .nzc-steps-row li, .nzc-dns-unsaved, .nzc-shop-table-wrap, .nzc-shop-compare-btn,
.nzc div.nz-row:has(> input[type="radio"]), .nzc label:has(> input[type="radio"]) { border: 0; box-shadow: none; }
.nzc-chip, .nzc-pill, .nzc .nz-badge, .nzc-shop-chip, .nzc-method-soon, .nzc-shop-tabs, .nz-view-toggle,
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="chip"] .nz-cell-value { border: 0; box-shadow: none; }
.nzc-shop-tabs button[aria-selected="true"], .nzc-rail-link[aria-current="true"], .nzc-rail-link[aria-current="page"], .nzc-tab-menu > ul a[aria-current="page"] { box-shadow: none; }
.nzc-org > a { border-inline-end: 0; background: var(--nzc-elev); }
.nzc-chip, .nzc-pill { background: var(--nzc-card); }
.nzc .nz-badge:not([data-tone]) { background: var(--nzc-elev); }
.nzc-shop-chip, .nzc-method-soon { background: var(--nzc-elev); }
.nzc-shop-tabs { background: var(--nzc-card); }
/* selected cards: a stronger tint, plus the filled radio / check inside them */
.nzc label:has(> input[type="radio"]:checked) { background: color-mix(in srgb, var(--nzc-accent) 20%, var(--nzc-card)); }
.nzc-method[data-featured="true"] { background: color-mix(in srgb, var(--nzc-accent) 12%, var(--nzc-card)); }
.nzc-shop-plan { background: var(--nzc-card-hi); }
.nzc-shop-faq details { background: var(--nzc-card-hi); }
.nzc-shop-table thead th { background: var(--nzc-card-hi); }
.nzc-shop-runtimes { background: var(--nzc-card); }
.nzc-cfg-sum { background: color-mix(in srgb, var(--nzc-accent) 8%, var(--nzc-card)); }
.nzc-shop-table th, .nzc-shop-table td { border-color: color-mix(in srgb, var(--nzc-fg) 6%, transparent); }

/* hover: the card keeps its own fill (no grey) and a thin stroke appears; an outline draws it without moving anything */
.nzc .nz-table-wrap[data-view="cards"] tbody tr:hover, .nzc .nz-table-wrap[data-view="cards"][data-card="rich"] tbody tr:hover, .nzc .nzc-tlds label.nzc-tld:hover,
a.nzc-navcard:hover, .nzc-tile:hover { background: var(--nzc-card); }
/* list cards (servers, sites, databases, domains...): the icon with the status label beside it on top, the name under the icon, then the details */
.nzc .nz-table-wrap[data-view="cards"] tbody tr { border: 0; box-shadow: none; background: var(--nzc-card); border-radius: 22px; transition: background-color 120ms ease; }
.nzc .nz-table-wrap[data-view="cards"] tbody tr:hover { border: 0; transform: none; background: var(--nzc-card); }
.nzc .nz-table-wrap[data-view="cards"] td { border-block-start: 0; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] tbody tr { background: var(--nzc-card); box-shadow: none; padding: 22px; gap: 4px 8px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] tbody tr:hover { background: var(--nzc-card); box-shadow: none; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] .nz-card-icon { order: 0; flex: 1 1 0; margin: 0; min-inline-size: 0; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] .nz-card-icon > span { box-shadow: none; inline-size: 46px; block-size: 46px; border-radius: 14px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="badge"] { order: 1; flex: 0 0 auto; margin: 0 0 0 auto; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] tbody tr::before { order: 2; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="title"] { order: 3; flex: 0 0 100%; margin-block-start: 12px; font-size: 18px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="subtitle"] { order: 4; flex: 0 0 100%; margin-block-start: 0; font-size: 13.5px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="subtitle"] + td[data-card="title"] { margin-block-start: 12px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] tbody tr::after { block-size: 0; margin-block: 10px 0; background: transparent; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="chip"] .nz-cell-value { background: var(--nzc-elev); border: 0; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td.nz-manage-col .nz-btn { border: 0; }

/* Service images retain the original illustration footprint. */
.nzc-art-render { object-fit:contain; border-radius:0; }
.nzc-hero-art.nzc-art-render { max-inline-size:360px; inline-size:100%; justify-self:center; }
.nzc-shop-type .nzc-art-render { max-inline-size:180px; justify-self:center; }
/* ================= page transitions =================
   Moving between pages: the old content clears out, then the new page's blocks rise in one after another and the dashboard figures count up.
   The chrome (top bar, rail) stays still: only the content area is its own transition layer. A browser without cross-document view transitions
   still gets the staggered entrance. Everything is off for people who ask for reduced motion. */
@view-transition { navigation: auto; }
.nzc-body { view-transition-name: nzc-content; }
::view-transition-old(root), ::view-transition-new(root) { animation: none; mix-blend-mode: normal; }
::view-transition-old(nzc-content) { animation: nzc-fade-out 140ms cubic-bezier(.4, 0, 1, 1) both; }
::view-transition-new(nzc-content) { animation: nzc-fade-in 240ms ease-out 60ms both; }
@keyframes nzc-fade-out { to { opacity: 0; transform: translateY(-6px); } }
@keyframes nzc-fade-in { from { opacity: 0; } }
@keyframes nzc-rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
.nzc-body > * { animation: nzc-rise 520ms cubic-bezier(.16, 1, .3, 1) both; }
.nzc-body > *:nth-child(2) { animation-delay: 60ms; }
.nzc-body > *:nth-child(3) { animation-delay: 120ms; }
.nzc-body > *:nth-child(4) { animation-delay: 180ms; }
.nzc-body > *:nth-child(5) { animation-delay: 240ms; }
.nzc-body > *:nth-child(n + 6) { animation-delay: 300ms; }
.nzc .nz-table-wrap[data-view="cards"] tbody tr, .nzc-stat, .nzc-shop-plan, a.nzc-method, .nzc .nzc-tlds label.nzc-tld { animation: nzc-rise 480ms cubic-bezier(.16, 1, .3, 1) both; }
.nzc .nz-table-wrap[data-view="cards"] tbody tr:nth-child(1), .nzc-stat:nth-child(1), .nzc-shop-plan:nth-child(1) { animation-delay: 140ms; }
.nzc .nz-table-wrap[data-view="cards"] tbody tr:nth-child(2), .nzc-stat:nth-child(2), .nzc-shop-plan:nth-child(2) { animation-delay: 200ms; }
.nzc .nz-table-wrap[data-view="cards"] tbody tr:nth-child(3), .nzc-stat:nth-child(3), .nzc-shop-plan:nth-child(3) { animation-delay: 260ms; }
.nzc .nz-table-wrap[data-view="cards"] tbody tr:nth-child(4), .nzc-stat:nth-child(4), .nzc-shop-plan:nth-child(4) { animation-delay: 320ms; }
.nzc .nz-table-wrap[data-view="cards"] tbody tr:nth-child(n + 5) { animation-delay: 380ms; }
@media (prefers-reduced-motion: reduce) {
  @view-transition { navigation: none; }
  .nzc-body > *, .nzc .nz-table-wrap[data-view="cards"] tbody tr, .nzc-stat, .nzc-shop-plan, a.nzc-method, .nzc .nzc-tlds label.nzc-tld { animation: none; }
  ::view-transition-old(nzc-content), ::view-transition-new(nzc-content) { animation: none; }
}

/* Builder composer: compact hierarchy, neutral surfaces, focused teal accents. */
.nzc .nzc-prompt { padding:36px 24px 30px; background:radial-gradient(ellipse at 50% 0%,color-mix(in srgb,var(--nzc-accent) 9%,transparent),transparent 60%),var(--nzc-card); border:1px solid var(--nzc-border); border-radius:22px; }
.nzc-prompt .nzc-dsearch-inner { max-inline-size:820px; }
.nzc-builder-mark { display:grid; place-items:center; inline-size:54px; block-size:54px; margin:0 auto 18px; border-radius:16px; background:color-mix(in srgb,var(--nzc-accent) 12%,var(--nzc-card)); color:var(--nzc-accent); border:1px solid color-mix(in srgb,var(--nzc-accent) 22%,transparent); }
.nzc-prompt h2 { font-size:clamp(26px,3vw,36px); letter-spacing:-.03em; margin-block-end:12px; }
.nzc-prompt .nzc-dsearch-sub { max-inline-size:62ch; margin:0 auto 26px; line-height:1.7; }
.nzc-prompt .nzc-prompt-bar { padding:1px; border:1px solid color-mix(in srgb,var(--nzc-accent) 35%,var(--nzc-border)); background:var(--nzc-card); border-radius:18px; box-shadow:0 8px 28px color-mix(in srgb,var(--nzc-accent) 9%,transparent); }
.nzc-prompt .nzc-prompt-bar:focus-within { border-color:var(--nzc-accent); box-shadow:0 0 0 3px color-mix(in srgb,var(--nzc-accent) 12%,transparent); }
.nzc .nzc-prompt-bar textarea.nzc-prompt-input { min-block-size:120px; background:var(--nzc-card); font-size:15px; }
.nzc-prompt .nzc-prompt-foot { background:var(--nzc-card); padding:12px 14px 14px 20px; }
.nzc-prompt .nzc-tlds { margin-block-start:24px; }
.nzc-prompt .nzc-tlds-title { text-align:start; text-transform:none; letter-spacing:0; font-size:13px; margin-block-end:12px; }
.nzc .nzc-prompt label.nzc-ptype { padding:18px; background:var(--nzc-card); border:1px solid var(--nzc-border); border-radius:14px; backdrop-filter:none; box-shadow:none; }
.nzc .nzc-prompt label.nzc-ptype:has(input:checked) { background:color-mix(in srgb,var(--nzc-accent) 7%,var(--nzc-card)); border-color:var(--nzc-accent); }
.nzc-prompt .nzc-ptype-name { display:flex; align-items:center; gap:10px; font-size:17px; }
.nzc-prompt .nzc-tld-hint { font-size:12px; line-height:1.7; }
.nzc-prompt .nzc-prompt-opts { border-block-start:1px solid var(--nzc-border); padding-block-start:18px; }
.nzc-prompt .nzc-prompt-opts > summary { text-align:start; }
.nzc-prompt .nzc-prompt-opts > summary::after { content:' +'; color:var(--nzc-accent); }
.nzc-prompt .nzc-prompt-opts[open] > summary::after { content:' −'; }
.nzc-prompt .nzc-dsearch-note { text-align:start; font-size:12px; line-height:1.7; }
@media(max-width:640px) { .nzc .nzc-prompt { padding:24px 16px; } .nzc-prompt .nzc-tlds-grid { grid-template-columns:1fr; } .nzc-prompt-count { font-size:11px; } }

/* A framed creation workspace, rather than a full-height empty form. */
.nzc-body > .nzc-start-full { padding:32px; background:var(--nzc-bg); box-sizing:border-box; }
.nzc-start-full > .nzc-prompt { flex:0 0 auto; display:block; padding:30px 36px; border:1px solid var(--nzc-border); border-radius:24px; background:var(--nzc-card); box-shadow:0 12px 44px color-mix(in srgb,var(--nzc-accent) 5%,transparent); }
.nzc-start-full > .nzc-prompt .nzc-dsearch-inner { max-inline-size:1000px; }
.nzc-create-intro { display:grid; grid-template-columns:minmax(0,1fr) 240px; gap:32px; align-items:center; margin-block-end:24px; }
.nzc-create-brand { display:inline-flex; align-items:center; gap:8px; color:var(--nzc-accent); font-size:13px; font-weight:650; margin-block-end:18px; }
.nzc-create-intro h2 { text-align:start; font-size:clamp(30px,3.2vw,44px); line-height:1.14; max-inline-size:16ch; margin:0 0 16px; }
.nzc-create-intro .nzc-dsearch-sub { text-align:start; margin:0; max-inline-size:52ch; font-size:14px; }
.nzc-create-visual { display:grid; place-items:center; border-radius:28px; background:radial-gradient(ellipse,color-mix(in srgb,var(--nzc-accent) 18%,transparent),transparent 70%); }
.nzc-create-visual img { display:block; inline-size:100%; block-size:auto; }
.nzc-start-full .nzc-prompt-bar { border-radius:20px; border-color:color-mix(in srgb,var(--nzc-accent) 30%,var(--nzc-border)); box-shadow:0 6px 20px color-mix(in srgb,var(--nzc-accent) 6%,transparent); }
.nzc-start-full .nzc-prompt-bar textarea.nzc-prompt-input { min-block-size:145px; padding:22px 24px 10px !important; font-size:16px; }
.nzc-start-full .nzc-prompt-foot { padding:12px 14px 14px 24px; }
.nzc-start-full .nzc-prompt-foot .nz-btn { background:var(--nzc-accent); color:var(--nzc-card); min-inline-size:112px; }
.nzc-start-full .nzc-tlds-grid { gap:12px; }
.nzc .nzc-start-full label.nzc-ptype { padding:16px; }
.nzc .nzc-start-full label.nzc-ptype:has(input:checked) { box-shadow:inset 0 0 0 1px var(--nzc-accent); }
.nzc-start-full .nzc-ptype-name > .nzc-icon { padding:8px; inline-size:38px; block-size:38px; box-sizing:border-box; background:color-mix(in srgb,var(--nzc-accent) 10%,var(--nzc-card)); border-radius:10px; }
.nzc-start-full .nzc-prompt-opts { margin-block-start:20px; }
.nzc-start-full > .nzc-pex-wrap { max-inline-size:1072px; padding:0; margin-block:26px 4px; }
.nzc-start-full .nzc-pex-wrap > .nzc-tlds-title { text-transform:none; letter-spacing:0; text-align:start; font-size:15px; color:var(--nzc-fg); margin-block-end:14px; }
.nzc-start-full .nzc-pex-grid { grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; }
.nzc .nzc-start-full .nzc-pex { min-block-size:150px; position:relative; border-radius:18px; padding:18px; gap:14px; background:var(--nzc-card); font-size:13px; }
.nzc-example-icon { display:grid; place-items:center; inline-size:44px; block-size:44px; border-radius:14px; background:#e8eddf; color:#537146; }
.nzc-pex[data-example="portfolio"] .nzc-example-icon { background:#e0ece9; color:#286759; }
.nzc-pex[data-example="clinic"] .nzc-example-icon { background:#e2eff0; color:#386d70; }
.nzc-pex[data-example="shop"] .nzc-example-icon { background:#f2eadd; color:#856947; }
.nzc-start-full .nzc-pex > .nzc-icon { position:absolute; inset-inline-end:18px; inset-block-start:26px; }
@media(max-width:700px) { .nzc-body > .nzc-start-full { padding:16px; } .nzc-start-full > .nzc-prompt { padding:22px 18px; } .nzc-create-intro { grid-template-columns:minmax(0,1fr); gap:0; } .nzc-create-visual { display:none; } .nzc-start-full .nzc-pex-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }

/* Full builder canvas: soft mint light across creation and existing projects. */
.nzc-body:has(> .nzc-start-full) { background:radial-gradient(ellipse at 12% 8%,color-mix(in srgb,var(--nzc-accent) 15%,transparent),transparent 48%),radial-gradient(ellipse at 90% 38%,color-mix(in srgb,var(--nzc-accent) 10%,transparent),transparent 50%),linear-gradient(145deg,var(--nzc-card),var(--nzc-bg)); background-attachment:fixed; }
.nzc-body > .nzc-start-full { background:transparent; padding:32px 40px 8px; }
.nzc-start-full > .nzc-prompt { background:transparent; border:0; box-shadow:none; padding:8px 24px 24px; }
.nzc-create-intro { max-inline-size:820px; margin:0 auto 22px; grid-template-columns:minmax(0,1fr) 190px; }
.nzc-create-intro h2 { max-inline-size:20ch; }
.nzc-start-full .nzc-prompt-bar { background:var(--nzc-card); border:1px solid color-mix(in srgb,var(--nzc-card) 60%,var(--nzc-accent)); box-shadow:0 16px 50px color-mix(in srgb,var(--nzc-accent) 10%,transparent),0 2px 4px #123c2c06; }
.nzc-start-full .nzc-prompt-bar textarea.nzc-prompt-input { min-block-size:112px; }
.nzc-start-full .nzc-tlds { margin-block-start:20px; }
.nzc .nzc-start-full label.nzc-ptype { background:color-mix(in srgb,var(--nzc-card) 75%,transparent); border-color:color-mix(in srgb,var(--nzc-accent) 13%,var(--nzc-card)); }
.nzc-start-full .nzc-prompt-opts { padding-block-start:12px; margin-block-start:16px; }
.nzc-start-full .nzc-prompt .nzc-dsearch-note { margin-block-start:14px; }
.nzc-start-full > .nzc-pex-wrap { max-inline-size:1000px; margin-block-start:8px; }
.nzc .nzc-start-full .nzc-pex { min-block-size:130px; background:color-mix(in srgb,var(--nzc-card) 80%,transparent); border:1px solid color-mix(in srgb,var(--nzc-accent) 10%,var(--nzc-card)); box-shadow:0 4px 18px #123c2c04; }
.nzc-body > .nzc-start-projects { max-inline-size:1080px; inline-size:100%; box-sizing:border-box; margin-inline:auto; padding:28px 40px 48px; }
.nzc-start-projects .nzc-yp-head { font-size:20px; margin:0 0 18px; }
.nzc .bld-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr)); gap:20px; padding:0; list-style:none; }
.nzc .bld-list > li { min-inline-size:0; }
.nzc .bld-list .nz-card { overflow:hidden; padding:0; border:1px solid color-mix(in srgb,var(--nzc-accent) 12%,var(--nzc-card)); border-radius:20px; background:var(--nzc-card); box-shadow:0 8px 28px #123c2c06; block-size:100%; }
.nzc-project-cover { position:relative; block-size:120px; display:grid; place-items:center; background:radial-gradient(ellipse at 75% 20%,color-mix(in srgb,var(--nzc-accent) 20%,transparent),transparent 65%),color-mix(in srgb,var(--nzc-accent) 7%,var(--nzc-card)); border-block-end:1px solid var(--nzc-border); }
.nzc-project-cover img { block-size:115px; inline-size:auto; }
.nzc-project-cover-icon { position:absolute; inset-inline-start:20px; inset-block-end:-18px; display:grid; place-items:center; inline-size:40px; block-size:40px; border:3px solid var(--nzc-card); border-radius:12px; color:var(--nzc-accent); background:var(--nzc-elev); }
.nzc-project-content { padding:28px 20px 20px; }
.nzc .bld-list .nz-h2 { font-size:17px; line-height:1.5; margin:0 0 16px; }
.nzc .bld-list dl { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.2fr); gap:12px 16px; margin:0 0 20px; font-size:12px; }
.nzc .bld-list dt { color:var(--nzc-muted); }
.nzc .bld-list dd { margin:0; text-align:end; overflow-wrap:anywhere; }
.nzc-project-content > .nz-btn { inline-size:100%; justify-content:space-between; }
@media(max-width:700px) { .nzc-body > .nzc-start-full { padding:20px 12px 8px; } .nzc-start-full > .nzc-prompt { padding:0 8px 20px; } .nzc-create-intro { grid-template-columns:1fr; } .nzc-body > .nzc-start-projects { padding:24px 20px; } }

/* Compact hosting planner replaces the oversized monitor showcase. */
.nzc-shop .nzc-host-planner { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr); gap:36px; align-items:center; padding:28px 32px; margin-block-end:24px; text-align:start; min-block-size:0; background:radial-gradient(ellipse at 0% 0%,color-mix(in srgb,var(--nzc-accent) 15%,transparent),transparent 65%),var(--nzc-card); }
.nzc-host-planner::before,.nzc-host-planner::after { display:none; }
.nzc-host-planner .nzc-showcase-pill { margin:0 0 14px; font-size:12px; padding:5px 12px; }
.nzc-shop .nzc-host-planner h2 { font-size:clamp(26px,3vw,38px); max-inline-size:23ch; line-height:1.15; margin:0 0 14px; letter-spacing:-.025em; }
.nzc-shop .nzc-host-planner-copy > p { font-size:14px; margin:0; max-inline-size:48ch; line-height:1.7; }
.nzc-host-planner-panel { position:relative; display:grid; gap:10px; padding:22px; border-radius:18px; background:var(--nzc-card); border:1px solid color-mix(in srgb,var(--nzc-accent) 20%,var(--nzc-border)); box-shadow:0 10px 28px color-mix(in srgb,var(--nzc-accent) 8%,transparent); }
.nzc-host-planner-heading { display:flex; align-items:center; gap:10px; color:var(--nzc-accent); margin-block-end:4px; font-size:16px; }
.nzc-host-planner-panel label { font-size:12px; font-weight:600; color:var(--nzc-muted); }
.nzc-host-planner-panel select { inline-size:100%; min-block-size:42px; }
.nzc-shop .nzc-host-planner-panel p { font-size:12px; margin:0; line-height:1.6; text-align:start; }
.nzc-host-planner-panel .nz-btn { justify-content:space-between; inline-size:100%; margin-block-start:4px; }
.nzc-shop-card[id] { scroll-margin-block-start:20px; }
@media(max-width:700px) { .nzc-shop .nzc-host-planner { grid-template-columns:1fr; padding:24px 20px; gap:22px; } .nzc-host-planner-panel { padding:18px; } }

/* Shorter service banners; preserve their horizontal layout and widths. */
.nzc-hero[data-art] { padding-block:16px; }
.nzc-hero[data-art] .nzc-hero-art.nzc-art-render { block-size:180px; object-fit:contain; }

/* Server configuration: compact choices and a distinct live summary. */
.nzc .nzc-server-steps { gap:0; margin-block:20px 18px !important; padding:14px 18px !important; border:1px solid var(--nzc-border); border-radius:14px; background:var(--nzc-card); }
.nzc-server-steps li { display:flex; align-items:center; gap:16px; }
.nzc-server-steps li:not(:last-child)::after { content:''; inline-size:48px; block-size:1px; margin-inline-end:16px; background:var(--nzc-border); }
.nzc-server-steps .nz-badge { padding:7px 12px; font-size:12px; }
.nzc .nzc-server-wizard { padding:24px; border:1px solid var(--nzc-border); border-radius:20px; background:var(--nzc-card); }
.nzc-server-wizard > #wiz-h { font-size:20px; margin:0 0 22px; padding-block-end:16px; border-block-end:1px solid var(--nzc-border); }
.nzc-server-wizard > #wiz-h:focus:not(:focus-visible) { outline:none; box-shadow:none; }
.nzc-server-wizard .nzc-cfg { grid-template-columns:minmax(0,1fr) 280px; gap:24px; }
.nzc-server-wizard .nzc-cfg-main { gap:24px; }
.nzc-server-wizard .nzc-cfg-main > section { min-inline-size:0; }
.nzc-server-wizard .nzc-cfg-step { text-transform:none; letter-spacing:0; color:var(--nzc-fg); font-size:14px; }
.nzc-server-wizard .nzc-cfg-step > i { inline-size:24px; block-size:24px; border-radius:8px; }
.nzc-server-wizard .nzc-tlds-grid { grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
.nzc .nzc-server-wizard label.nzc-opt { padding:14px; border:1px solid var(--nzc-border); border-radius:12px; background:var(--nzc-bg); box-shadow:none; backdrop-filter:none; gap:8px; }
.nzc .nzc-server-wizard label.nzc-opt:has(input:checked) { border-color:var(--nzc-accent); box-shadow:inset 0 0 0 1px var(--nzc-accent); background:color-mix(in srgb,var(--nzc-accent) 9%,var(--nzc-card)); }
.nzc-server-wizard .nzc-opt-name { font-size:14px; line-height:1.4; }
.nzc-server-wizard .nzc-tld-hint { font-size:11px; line-height:1.5; }
.nzc-server-wizard .nzc-opt-code { font-size:10px; border-radius:6px; }
.nzc-server-wizard .nzc-cfg-main .nzc-dsearch-note { text-align:start; margin-block-start:12px; font-size:11px; line-height:1.6; }
.nzc-server-wizard .nzc-cfg-sum { padding:20px; gap:16px; background:linear-gradient(150deg,color-mix(in srgb,var(--nzc-accent) 10%,var(--nzc-card)),var(--nzc-card)); border-radius:16px; }
.nzc-server-summary-art { inline-size:100px; block-size:66px; object-fit:contain; justify-self:center; }
.nzc-server-wizard .nzc-cfg-sum > .nzc-cfg-h { color:var(--nzc-fg); font-size:15px; text-transform:none; letter-spacing:0; }
.nzc-server-wizard .nzc-cfg-sum dl { gap:14px; }
.nzc-server-wizard .nzc-cfg-sum dt { font-size:11px; }
.nzc-server-wizard .nzc-cfg-sum dd { font-size:13px; line-height:1.5; }
.nzc-server-wizard .nzc-cfg-price strong { font-size:30px; letter-spacing:-.025em; }
.nzc-server-wizard .nzc-cfg-sum .nzc-dsearch-note { font-size:11px; line-height:1.6; }
@media(max-width:1000px) { .nzc-server-wizard .nzc-cfg { grid-template-columns:1fr; } }
@media(max-width:600px) { .nzc .nzc-server-wizard { padding:16px; } .nzc-server-steps li:not(:last-child)::after { inline-size:12px; margin-inline-end:8px; } .nzc-server-steps li { gap:8px; } .nzc-server-steps .nz-badge { font-size:11px; padding:6px; } }

/* Email artwork belongs to the original setup card. */
.nzc-email-setup-head { display:grid; grid-template-columns:minmax(0,1fr) 170px; gap:24px; align-items:center; margin-block-end:24px; }
.nzc-email-setup-head h2 { text-align:start; }
.nzc-email-setup-head .nzc-dsearch-sub { text-align:start; margin:12px 0 0; line-height:1.7; }
.nzc-email-setup-head .nzc-art { inline-size:170px; block-size:130px; object-fit:contain; }
@media(max-width:600px) { .nzc-email-setup-head { grid-template-columns:minmax(0,1fr) 90px; gap:12px; } .nzc-email-setup-head .nzc-art { inline-size:90px; block-size:90px; } }

/* Verification is a yellow notice in either theme. */
.nzc .nzc-verification-notice { background:#fff3bd; color:#684900; border:1px solid #efcd63; }
.nzc .nzc-verification-notice .nzc-pill-text,.nzc .nzc-verification-notice > .nzc-icon { color:#684900; }
.nzc .nzc-verification-notice button { background:#f5c542; color:#382800; border:1px solid #d8a620; }
.nzc .nzc-verification-notice button:hover { background:#eeb82e; }
.nzc-dashboard { display:grid; gap:22px; }
.nzc-dashboard > .nzc-hero { margin:0; padding:24px; border:1px solid var(--nzc-border); }
.nzc-dashboard .nzc-hero h1 { font-size:clamp(23px,2.5vw,30px); }
.nzc-dashboard .nzc-stats { margin:0; gap:16px; }
.nzc-dashboard .nzc-stat { padding:20px; gap:12px; border:1px solid var(--nzc-border); border-radius:18px; }
.nzc-dashboard .nzc-stat[data-featured="true"] { background:radial-gradient(24rem 12rem at 100% 0%,color-mix(in srgb,var(--nzc-accent) 8%,transparent),transparent 70%),linear-gradient(180deg,var(--nzc-card-hi),var(--nzc-card)); color:var(--nzc-fg) !important; border-color:var(--nzc-border); box-shadow:none; }
.nzc-dashboard .nzc-stat[data-featured="true"] .nzc-stat-label,.nzc-dashboard .nzc-stat[data-featured="true"] .nzc-stat-sub { color:var(--nzc-muted); }
.nzc-dashboard .nzc-stat[data-featured="true"] .nzc-icon { color:var(--nzc-accent); }
.nzc-dashboard .nzc-stat-value { font-size:30px; line-height:1.2; }
.nzc-dashboard .nzc-stat-label { font-size:13px; }
.nzc-dashboard .nzc-stat-sub { font-size:12px; }
.nzc-dashboard .nzc-split { gap:18px; align-items:start; margin:0; grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
.nzc-dashboard .nzc-split > .nz-card { padding:22px; border:1px solid var(--nzc-border); border-radius:18px; }
.nzc-dashboard .nzc-cardhead h2 { font-size:17px; }
.nzc-dashboard .nzc-cardhead > a { font-size:12px; }
.nzc-dashboard-empty { display:grid; place-items:center; align-content:center; min-block-size:240px; gap:14px; text-align:center; }
.nzc-dashboard-empty > span { display:grid; place-items:center; inline-size:60px; block-size:60px; border-radius:18px; background:var(--nzc-accent-soft); color:var(--nzc-accent); }
.nzc-dashboard-empty p { margin:0; font-size:13px; color:var(--nzc-muted); }
.nzc-dashboard-empty > a { display:flex; align-items:center; gap:8px; font-size:12px; }
.nzc-dashboard .nzc-list li { padding:12px 0; gap:12px; align-items:center; }
.nzc-dashboard-event { display:flex; align-items:center; gap:10px; font-size:12px; min-inline-size:0; }
.nzc-dashboard-event .nzc-icon { color:var(--nzc-accent); flex-shrink:0; }
.nzc-dashboard .nzc-list li > .nz-muted { font-size:11px; white-space:nowrap; }
.nzc-dashboard .nzc-tiles { grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); }
.nzc-dashboard .nzc-tile { min-block-size:110px; border:1px solid var(--nzc-border); }
@media(max-width:900px) { .nzc-dashboard .nzc-split { grid-template-columns:1fr; } }
@media(max-width:600px) { .nzc-dashboard .nzc-list li { align-items:start; flex-direction:column; gap:6px; } }

/* Branded dimensional service panels: teal surfaces, mint highlights. */
.nzc-service-banner { display:grid; grid-template-columns: 1.3fr 1fr; align-items:center; gap:28px; overflow:hidden; padding:36px; margin-block:20px 28px; border-radius:24px; color:#f2fff9; background:radial-gradient(ellipse at 90% 20%, #428f80 0%, transparent 55%), linear-gradient(120deg,#103e38,#21685c); }
.nzc-service-copy { position:relative; z-index:1; max-inline-size:560px; }
.nzc-service-copy h2 { font-size:clamp(25px,3vw,36px); line-height:1.2; letter-spacing:-.025em; margin:0 0 16px; }
.nzc-service-copy p { color:#d0e9e0; line-height:1.75; margin:0 0 24px; }
.nzc-service-banner .nz-btn { background:#c5ebd6; color:#123e35; border-color:#c5ebd6; box-shadow:0 6px 20px #082e3433; }
.nzc-service-art { position:relative; block-size:240px; inline-size:100%; max-inline-size:360px; justify-self:center; perspective:700px; }
.nzc-service-orbit { position:absolute; inset:0; border:1px solid #b5efd84d; border-radius:50%; transform:rotate(-25deg) scaleY(.8); }
.nzc-service-tile { position:absolute; inset:30px 65px; display:grid; place-items:center; border-radius:32px; color:#164f43; background:linear-gradient(140deg,#e2ffec,#83c9b4); border:1px solid #edfff0; transform:rotate(-9deg) rotateY(-16deg); box-shadow:14px 20px 0 #062e3440,0 26px 45px #062e3455,inset 0 2px 2px #ffffff; }
.nzc-service-layer { position:absolute; display:flex; gap:10px; align-items:center; padding:18px; border:1px solid #d6f9e9; border-radius:16px; background:#e4f9ee; color:#246b5c; box-shadow:0 16px 30px #062e3440; }
.nzc-service-layer span { inline-size:32px; block-size:6px; background:#74ad9e; border-radius:4px; }
.nzc-service-layer--back { inset-block-start:6px; inset-inline-end:0; transform:rotate(7deg); }
.nzc-service-layer--front { inset-block-end:12px; inset-inline-start:12px; transform:rotate(-5deg); }
.nzc-service-art--compute .nzc-service-tile { transform:rotate(8deg) rotateY(-18deg); border-radius:24px; }
@media(max-width:640px) { .nzc-service-banner { grid-template-columns:1fr; padding:24px; gap:14px; } .nzc-service-art { block-size:190px; max-inline-size:280px; } }


/* Builder workspace: a full-bleed, full-height editor (chat on one side, a large canvas, a collapsible properties panel, a slim top bar). */
.nzc-body:has(> .bws) { padding: 0; overflow: hidden; }
.nzc-body > .bws { max-inline-size: none; margin: 0; block-size: 100%; }
.bws { display: flex; flex-direction: column; min-block-size: 0; background: var(--nzc-bg); }
.bws-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; background: var(--nzc-card); }
.bws-back { font-size: 13px; color: var(--nzc-muted); text-decoration: none; white-space: nowrap; }
.bws-back::before { content: '\\2039\\00a0'; }
.bws-back:hover { color: var(--nzc-fg); }
[dir='rtl'] .bws-back::before { content: '\\203a\\00a0'; }
.bws-title { margin: 0; font-size: 15px; font-weight: 650; max-inline-size: 26ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bws-chip { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: var(--nzc-accent-soft); color: var(--nzc-accent); white-space: nowrap; }
.bws-state { font-size: 12px; color: var(--nzc-muted); white-space: nowrap; }
.bws-spacer { flex: 1; }
.bws-seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 12px; background: var(--nzc-field); }
.bws-seg button { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border: 0; border-radius: 9px; background: transparent; color: var(--nzc-muted); font: inherit; font-size: 13px; cursor: pointer; }
.bws-seg button:hover:not(:disabled) { color: var(--nzc-fg); }
.bws-seg button[aria-pressed='true'] { background: var(--nzc-card-hi); color: var(--nzc-fg); }
.bws-seg button:disabled { opacity: 0.4; cursor: default; }
.bws-seg-icons button { padding: 7px 9px; }
.bws-icon-btn, .bws-more summary { display: inline-grid; place-items: center; inline-size: 36px; block-size: 36px; border: 0; border-radius: 10px; background: var(--nzc-field); color: var(--nzc-muted); cursor: pointer; list-style: none; }
.bws-more summary::-webkit-details-marker { display: none; }
.bws-icon-btn:hover, .bws-more summary:hover, .bws-icon-btn[aria-pressed='true'] { color: var(--nzc-fg); background: var(--nzc-card-hi); }
.bws-more { position: relative; }
.bws-more ul { position: absolute; inset-inline-end: 0; margin: 6px 0 0; padding: 6px; min-inline-size: 190px; list-style: none; border-radius: 14px; background: var(--nzc-elev); box-shadow: 0 12px 34px rgba(0, 0, 0, 0.35); z-index: 30; }
.bws-more li a { display: block; padding: 9px 12px; border-radius: 9px; color: var(--nzc-fg); text-decoration: none; font-size: 13px; }
.bws-more li a:hover { background: var(--nzc-field); }
.bws-publish { padding: 8px 18px; border-radius: 10px; background: var(--nzc-accent); color: var(--nzc-on-accent); font-size: 13px; font-weight: 650; text-decoration: none; white-space: nowrap; }
.bws-body { flex: 1; min-block-size: 0; display: grid; grid-template-columns: 360px minmax(0, 1fr) 320px; gap: 12px; padding: 12px; }
.bws[data-inspector='closed'] .bws-body { grid-template-columns: 360px minmax(0, 1fr); }
.bws-chat, .bws-canvas, .bws-insp { min-block-size: 0; min-inline-size: 0; overflow: auto; border-radius: 18px; background: var(--nzc-card); }
.bws-chat { display: flex; flex-direction: column; }
.bld-chat { display: flex; flex-direction: column; flex: 1; min-block-size: 0; padding: 16px; gap: 12px; }
.bld-chat-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--nzc-muted); }
.bld-chat-log { flex: 1; min-block-size: 0; overflow: auto; }
.bld-chat-empty { flex: 1; margin: 0; }
.bld-composer-box { padding: 10px 12px 8px; border-radius: 18px; background: var(--nzc-field); }
.bld-composer-box:focus-within { box-shadow: 0 0 0 1px var(--nzc-accent); }
.bld-composer-input { inline-size: 100%; min-block-size: 64px; border: 0; outline: 0; background: transparent; color: var(--nzc-fg); resize: none; font: inherit; font-size: 14px; }
.bld-composer-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.bld-composer-help { font-size: 11px; color: var(--nzc-muted); }
.bld-send { display: grid; place-items: center; inline-size: 34px; block-size: 34px; border: 0; border-radius: 50%; background: var(--nzc-accent); color: var(--nzc-on-accent); cursor: pointer; flex-shrink: 0; }
.bld-send:disabled { opacity: 0.4; cursor: default; }
.bws-run { padding: 0 16px 14px; }
.bws-run summary { cursor: pointer; padding: 10px 0; font-size: 13px; font-weight: 600; }
.bws-canvas { display: flex; flex-direction: column; overflow: hidden; }
.bws-canvas .bld-preview-bare { flex: 1; min-block-size: 0; display: flex; flex-direction: column; }
.bws-canvas .bld-frame-wrap { flex: 1; min-block-size: 0; display: flex; justify-content: center; padding: 14px; border: 0; border-radius: 0; background: var(--nzc-field); overflow: auto; }
.bws-canvas .bld-frame { block-size: 100%; max-inline-size: 100%; border-radius: 12px; flex: 0 0 auto; margin: 0; }
.bws-canvas .bld-frame[data-viewport='desktop'] { inline-size: 100% !important; }
.bws-insp { padding: 14px; }
@media (max-width: 1180px) { .nzc-body:has(> .bws) { overflow: auto; } .bws-body { grid-template-columns: minmax(0, 1fr); } .bws[data-inspector='closed'] .bws-body { grid-template-columns: minmax(0, 1fr); } .bws-chat { max-block-size: 60vh; } .bws-canvas { min-block-size: 70vh; } }
`;
