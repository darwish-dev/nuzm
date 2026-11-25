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
  /* the second brand colour (the website's orange): used in small touches, one per card or less. Teal stays the main colour. */
  --nzc-orange: #e9a16d;
  --nzc-orange-strong: #c9784a;
  --nzc-orange-soft: color-mix(in srgb, #e9a16d 16%, transparent);
  --nzc-orange-ink: #2a1a0e;
  --nzc-orange-text: #e9a16d;
  --nzc-orange-grad: linear-gradient(165deg, #f2b98c 0%, #e9a16d 100%);
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
  /* on white the fill orange is for shapes only (it is 2:1); orange text and thin icons use the deeper --nzc-orange-text (5.6:1 on white) */
  --nzc-orange: #e9a16d;
  --nzc-orange-strong: #c9784a;
  --nzc-orange-soft: color-mix(in srgb, #e9a16d 20%, transparent);
  --nzc-orange-ink: #2a1a0e;
  --nzc-orange-text: #a1521f;
  --nzc-orange-grad: linear-gradient(165deg, #f2b98c 0%, #e9a16d 100%);
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
/* a link inside running text is told apart by more than colour (WCAG 1.4.1; axe link-in-text-block): the accent on the muted text is only about 1.7:1 */
.nzc :is(p, li, label, .nz-cell-value) a:not([class]) { text-decoration: underline; text-underline-offset: 3px; }
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
.nzc[data-theme="light"] .nzc-logo { filter: brightness(0.62) saturate(1.5); }
.nzc-auth-logo { display: inline-block; margin-block-end: 22px; }
.nzc-auth-logo .nzc-logo { block-size: 32px; }
.nzc-brandlink { display: inline-flex; align-items: center; gap: 10px; color: var(--nzc-fg) !important; font-weight: 650; font-size: 16px; letter-spacing: .01em; text-decoration: none !important; margin-inline-end: 6px; }
.nzc-brand { inline-size: 34px; block-size: 34px; border-radius: 10px; font-size: 15px; }
.nzc-rail-link { position: relative; display: grid; place-items: center; inline-size: 44px; block-size: 44px; border-radius: 12px; color: var(--nzc-muted); background: transparent; border: 0; cursor: pointer; text-decoration: none !important; }
.nzc-rail-link:hover { background: var(--nzc-elev); color: var(--nzc-fg); }
.nzc-rail-link[aria-current="true"], .nzc-rail-link[aria-current="page"] { background: var(--nzc-elev); color: var(--nzc-accent); box-shadow: inset 0 0 0 1px var(--nzc-border); }
/* a small orange marker at the rail's edge for the current page (the tooltip owns ::after) */
.nzc-rail-link[aria-current="true"]::before, .nzc-rail-link[aria-current="page"]::before { content: ""; position: absolute; inset-inline-start: -11px; inset-block: 12px; inline-size: 3px; border-start-end-radius: 3px; border-end-end-radius: 3px; background: var(--nzc-orange); }
.nzc-icon-btn { position: relative; }
.nzc-dot { position: absolute; inset-block-start: 7px; inset-inline-end: 7px; min-inline-size: 16px; block-size: 16px; padding-inline: 4px; border-radius: 999px; background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); font-size: 10.5px; line-height: 16px; text-align: center; font-weight: 700; }
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
.nzc > .nz-main > p:last-child a { text-decoration: none; display: inline-block; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--nzc-border); background: var(--nzc-card); color: var(--nzc-fg); }
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
.nzc .nz-btn { min-block-size: 38px; border-radius: 10px; font-weight: 650; border: 1px solid transparent; background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); transition: background 120ms ease, border-color 120ms ease; }
.nzc .nz-btn:hover { filter: brightness(0.94); text-decoration: none; }
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
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td.nz-manage-col .nz-btn { inline-size: auto; min-block-size: 40px; padding-inline: 18px; background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); border-color: transparent; }

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
.nzc .nzc-subtabs a.nz-btn[aria-current="page"] { background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); }
.nzc-steps { margin-block-end: 22px; }
.nzc-steps ol { list-style: none; display: flex; align-items: center; gap: 0; margin: 0 0 8px; padding: 0; }
.nzc-steps li { display: flex; align-items: center; gap: 10px; color: var(--nzc-muted); font-weight: 560; }
.nzc-steps li + li::before { content: ''; inline-size: 44px; block-size: 2px; margin-inline: 12px; background: var(--nzc-border); border-radius: 2px; }
.nzc-steps li[data-state="done"] + li::before, .nzc-steps li[data-state="current"]::before { background: var(--nzc-accent); }
.nzc-step-dot { display: grid; place-items: center; inline-size: 28px; block-size: 28px; border-radius: 50%; border: 1.5px solid var(--nzc-border); font-size: 13px; font-weight: 650; background: var(--nzc-card); }
.nzc-steps li[data-state="current"] { color: var(--nzc-fg); }
.nzc-steps li[data-state="current"] .nzc-step-dot { background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); border-color: transparent; }
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
.nzc-cart-fab { position: relative; display: grid; place-items: center; inline-size: 60px; block-size: 60px; border-radius: 50%; border: 0; background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); cursor: pointer; box-shadow: var(--nzc-shadow); transition: transform 140ms ease; }
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
.nzc-split-back { margin-block-start: auto; align-self: center; padding: 10px 14px; color: var(--nz-text-muted, #9aa3a0); text-decoration: none; border-radius: 10px; font-size: 14px; }
.nzc-split-back:hover, .nzc-split-back:focus-visible { color: var(--nz-text, #fff); background: color-mix(in srgb, currentColor 8%, transparent); }
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
   Moving between pages: the new page's blocks rise in one after another and the dashboard figures count up. There is deliberately NO cross-document view
   transition: it cut the content out of the page into its own layer, and while the old content faded out (and the new one was not in yet) whatever lay behind
   showed for a moment. The browser keeps the old page on screen until the new one paints, and the new page's own background is opaque from its first frame.
   Everything is off for people who ask for reduced motion. */
html:has(.nzc) { background: #0b0b0c; }
html:has(.nzc[data-theme="light"]) { background: #f4f4f5; }
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
  .nzc-body > *, .nzc .nz-table-wrap[data-view="cards"] tbody tr, .nzc-stat, .nzc-shop-plan, a.nzc-method, .nzc .nzc-tlds label.nzc-tld { animation: none; }
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
.nzc-start-full .nzc-prompt-foot .nz-btn { background:var(--nzc-orange-grad); color:var(--nzc-orange-ink); min-inline-size:112px; }
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
.nzc-service-banner .nz-btn { background:var(--nzc-orange-grad); color:var(--nzc-orange-ink); border-color:transparent; box-shadow:0 6px 20px #082e3433; }
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
.bws-body { position: relative; }
.bwd.bws-panel { overflow: hidden; }
.bws-panel .bwd-tabs { flex: none; padding: 12px 24px; border-block-end: 1px solid var(--nzc-border); background: var(--nzc-card); }
.bws-panel .bwd-tabs button { padding: 8px 16px; font-size: 14px; font-weight: 560; }
.bws-panel > .mws-panel { flex: 1; min-block-size: 0; }
.bws-panel .mws-panel > :is(p, div):empty { display: none; }
.bws-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; background: var(--nzc-card); }
.nzc a.bws-back { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; inline-size: 36px; block-size: 36px; border-radius: 50%; background: #33363c; color: #fff; text-decoration: none; }
.nzc a.bws-back:hover { background: #454952; }
.nzc a.bws-back:focus-visible { outline: 2px solid var(--nzc-fg); outline-offset: 2px; }
.bws-back .nzc-icon { transform: scaleX(-1); }
[dir='rtl'] .bws-back .nzc-icon { transform: none; }
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
.bws-more { position: relative; }
.bws-more ul { position: absolute; inset-inline-end: 0; margin: 6px 0 0; padding: 6px; min-inline-size: 190px; list-style: none; border-radius: 14px; background: var(--nzc-elev); box-shadow: 0 12px 34px rgba(0, 0, 0, 0.35); z-index: 30; }
.bws-more li a { display: block; padding: 9px 12px; border-radius: 9px; color: var(--nzc-fg); text-decoration: none; font-size: 13px; }
.bws-more li a:hover { background: var(--nzc-field); }
.bws-more li button.bws-more-item { display: block; inline-size: 100%; text-align: start; padding: 9px 12px; border: 0; border-radius: 9px; background: none; color: var(--nzc-fg); font: inherit; font-size: 13px; cursor: pointer; }
.bws-more li button.bws-more-item:hover { background: var(--nzc-field); }
.bws-more li button.bws-more-danger { color: var(--nzc-danger); }
.pdel-dialog { inline-size: min(480px, calc(100vw - 32px)); padding: 22px; border: 1px solid var(--nzc-border); border-radius: 18px; background: var(--nzc-elev); color: var(--nzc-fg); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45); }
.pdel-dialog::backdrop { background: rgba(0, 0, 0, 0.55); }
.pdel-dialog .nz-h2 { margin-block-start: 0; }
.pdel-actions { justify-content: flex-end; margin-block-start: 8px; }
.bws .bws-publish, .bws a.bws-publish:hover, .bws a.bws-publish:visited { color: var(--nzc-card); }
.bws-publish { padding: 8px 18px; border-radius: 10px; background: var(--nzc-accent); color: var(--nzc-card); font-size: 13px; font-weight: 650; text-decoration: none; white-space: nowrap; }
.bws-body { --bws-chat: 360px; flex: 1; min-block-size: 0; display: grid; grid-template-columns: var(--bws-chat) minmax(0, 1fr) 320px; grid-template-areas: 'chat canvas insp'; gap: 12px; padding: 12px; }
.bws[data-inspector='closed'] .bws-body { grid-template-columns: var(--bws-chat) minmax(0, 1fr); grid-template-areas: 'chat canvas'; }
/* the divider between the chat and the preview: a 12px handle on the gap, a thin grip that lights up on hover, focus and while dragging */
.bws-resizer { position: absolute; z-index: 5; inset-block: 12px; inset-inline-start: calc(12px + var(--bws-chat)); inline-size: 12px; display: grid; place-items: center; cursor: col-resize; touch-action: none; border-radius: 6px; outline: none; }
.bws-resizer > span { inline-size: 4px; block-size: 44px; border-radius: 4px; background: var(--nzc-border); transition: background 0.15s ease, block-size 0.15s ease; }
.bws-resizer:hover > span, .bws-resizer:focus-visible > span, .bws-body[data-resizing] .bws-resizer > span { block-size: 88px; background: var(--nzc-accent); }
.bws-resizer:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--nzc-accent) 50%, transparent); }
/* while dragging, the framed preview must not swallow the pointer, and text must not get selected */
.bws-body[data-resizing] { cursor: col-resize; user-select: none; }
.bws-body[data-resizing] iframe { pointer-events: none; }
.bws-chat { grid-area: chat; }
.bws-canvas { grid-area: canvas; }
.bws-insp { grid-area: insp; }
.bws-insp[hidden] { display: none; }
.bws-logo { display: inline-grid; place-items: center; padding-inline-end: 6px; color: var(--nzc-fg); }
.bws-logo .nzc-logo { block-size: 22px; inline-size: auto; }
.bws-chat, .bws-canvas, .bws-insp { min-block-size: 0; min-inline-size: 0; overflow: auto; border-radius: 18px; background: var(--nzc-card); }
.bws-chat { display: flex; flex-direction: column; }
.bld-composer-box { padding: 14px 14px 10px; border: 1px solid var(--nzc-border); border-radius: 22px; background: var(--nzc-card-hi); transition: border-color 0.15s ease; }
.bld-composer-box:focus-within { border-color: var(--nzc-accent); box-shadow: none; }
.bld-composer-input { inline-size: 100%; min-block-size: 72px; border: 0; outline: 0; background: transparent; color: var(--nzc-fg); resize: none; font: inherit; font-size: 14px; }
.nzc .bld-composer-input, .nzc .bld-composer-input:hover, .nzc .bld-composer-input:focus { border: 0 !important; background: transparent !important; box-shadow: none !important; padding: 0 !important; min-block-size: 72px !important; font-size: 14.5px !important; }
.bld-composer-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.bld-composer-help { margin: 8px 6px 0; font-size: 11.5px; line-height: 1.5; color: var(--nzc-muted); }
.bld-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid var(--nzc-border); border-radius: 999px; background: transparent; color: var(--nzc-muted); font-size: 12.5px; font-weight: 600; }
.bld-send { display: grid; place-items: center; inline-size: 38px; block-size: 38px; border: 0; border-radius: 50%; background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); cursor: pointer; flex-shrink: 0; }
.bld-send:disabled { opacity: 0.4; cursor: default; }
.bws-canvas { display: flex; flex-direction: column; overflow: hidden; }
.bws-canvas .bld-preview-bare { flex: 1; min-block-size: 0; display: flex; flex-direction: column; }
.bws-canvas .bld-frame-wrap { flex: 1; min-block-size: 0; display: flex; justify-content: center; padding: 14px; border: 0; border-radius: 0; background: var(--nzc-field); overflow: auto; }
.bws-canvas .bld-frame-wrap, .bld-frame-wrap { position: relative; }
.bld-frame { transition: opacity 0.25s ease; }
.bld-frame[data-role='first'] { opacity: 0; }
.bld-frame[data-role='back'] { position: absolute; inset-block: 14px; block-size: calc(100% - 28px); opacity: 0; pointer-events: none; }
.bws-canvas .bld-frame { block-size: 100%; max-inline-size: 100%; border-radius: 12px; flex: 0 0 auto; margin: 0; }
.bws-canvas .bld-frame[data-viewport='desktop'] { inline-size: 100% !important; }
.bws-insp { padding: 14px; }
.bws-canvas { position: relative; }
.bws-refresh { position: absolute; inset-block-start: 22px; inset-inline-end: 22px; z-index: 2; display: grid; place-items: center; inline-size: 34px; block-size: 34px; border: 0; border-radius: 10px; background: var(--nzc-card); color: var(--nzc-muted); cursor: pointer; opacity: 0.85; }
.bws-refresh:hover:not(:disabled) { color: var(--nzc-fg); opacity: 1; }
@media (max-width: 1180px) { .bws-resizer { display: none; } .nzc-body:has(> .bws) { overflow: auto; } .bws-body, .bws[data-inspector='open'] .bws-body { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'chat' 'canvas' 'insp'; } .bws[data-inspector='closed'] .bws-body { grid-template-columns: minmax(0, 1fr); } .bws-chat { max-block-size: 60vh; } .bws-canvas { min-block-size: 70vh; } }

/* Full screen: while the workspace is open the console's sidebar, top bar and banner step aside (the workspace has its own top bar with a way back). */
.nzc-app:has(:is(.bws, .bfs-float)) { background: var(--nzc-bg); }
.nzc-app:has(:is(.bws, .bfs-float)) > .nzc-top, .nzc-app:has(:is(.bws, .bfs-float)) > .nzc-banner-slot, .nzc-app:has(:is(.bws, .bfs-float)) .nzc-rail, .nzc-app:has(:is(.bws, .bfs-float)) .nzc-scrim { display: none; }
.nzc-app:has(:is(.bws, .bfs-float)) .nzc-frame { grid-template-columns: minmax(0, 1fr); margin: 0; border: 0; border-radius: 0; box-shadow: none; background: var(--nzc-bg); }

/* Chat thread and the live run card */
.bld-chat { display: flex; flex-direction: column; flex: 1; min-block-size: 0; }
.bld-chat-title { margin: 0; padding: 14px 18px 4px; font-size: 13px; font-weight: 600; color: var(--nzc-muted); }
.bld-chat-scroll { flex: 1; min-block-size: 0; overflow-y: auto; padding: 8px 18px 18px; display: flex; flex-direction: column; gap: 14px; }
.bld-chat-scroll .bld-list { display: flex; flex-direction: column; gap: 10px; }
.bld-chat-empty { margin: 0; }
.bld-msg { display: flex; flex-direction: column; gap: 8px; max-inline-size: 100%; padding: 0; border: 0; background: transparent; }
.bld-msg[data-role='user'] { align-self: flex-end; max-inline-size: 88%; padding: 12px 18px; border-radius: 22px; background: var(--nzc-elev); }
.bld-msg-body { white-space: pre-wrap; font-size: 14.5px; line-height: 1.65; overflow-wrap: anywhere; }
.bld-msg-head { display: inline-flex; align-items: center; gap: 8px; }
.bld-msg-head .nzc-logo { block-size: 15px; inline-size: auto; }
.bld-msg-head strong { font-size: 15px; font-weight: 800; letter-spacing: -0.01em; }
.bld-msg-actions { display: flex; align-items: center; gap: 6px; color: var(--nzc-muted); }
.bld-msg-actions button { display: grid; place-items: center; inline-size: 28px; block-size: 28px; border: 0; border-radius: 8px; background: transparent; color: var(--nzc-muted); cursor: pointer; }
.bld-msg-actions button:hover { background: var(--nzc-elev); color: var(--nzc-fg); }
.bld-msg-actions time { font-size: 11px; opacity: 0.8; }
.bld-composer { flex: none; padding: 0 18px 18px; }
.bld-run { display: grid; gap: 12px; padding: 14px; border-radius: 18px; background: var(--nzc-field); }
.bld-run-head { display: flex; align-items: center; gap: 12px; }
.bld-run-head strong { display: block; font-size: 14px; }
.bld-run-sub { display: block; font-size: 12px; color: var(--nzc-muted); }
.bld-run-icon { display: grid; place-items: center; inline-size: 32px; block-size: 32px; border-radius: 50%; background: var(--nzc-card-hi); color: var(--nzc-muted); flex: none; }
.bld-run-icon[data-state='succeeded'] { background: var(--nzc-success-soft); color: var(--nzc-success); }
.bld-run-icon[data-state='waiting_approval'] { background: var(--nzc-accent-soft); color: var(--nzc-accent); }
.bld-run-icon[data-state='failed'], .bld-run-icon[data-state='cancelled'], .bld-run-icon[data-state='budget_exceeded'] { background: var(--nzc-danger-soft); color: var(--nzc-danger); }
.bld-orbit { inline-size: 32px; block-size: 32px; border-radius: 50%; flex: none; border: 3px solid var(--nzc-accent-soft); border-block-start-color: var(--nzc-accent); animation: bld-spin 0.9s linear infinite; }
.bld-spinner { display: inline-block; inline-size: 14px; block-size: 14px; border-radius: 50%; border: 2px solid var(--nzc-accent-soft); border-block-start-color: var(--nzc-accent); animation: bld-spin 0.8s linear infinite; }
@keyframes bld-spin { to { transform: rotate(360deg); } }
@keyframes bld-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.bld-bar { block-size: 6px; border-radius: 999px; background: var(--nzc-card-hi); overflow: hidden; }
.bld-bar > span { display: block; block-size: 100%; border-radius: inherit; background: var(--nzc-accent); transition: inline-size 0.5s ease; }
.bld-bar[data-busy] > span { background-image: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.45), transparent); background-size: 200% 100%; background-color: var(--nzc-accent); animation: bld-shimmer 1.4s linear infinite; min-inline-size: 8%; }
.bld-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.bld-steps li { display: flex; align-items: center; gap: 10px; padding: 5px 0; font-size: 13px; color: var(--nzc-muted); }
.bld-steps li[data-state='done'], .bld-steps li[data-state='active'] { color: var(--nzc-fg); }
.bld-steps li[data-state='active'] { font-weight: 600; }
.bld-steps li[data-state='failed'] { color: var(--nzc-danger); }
.bld-st-mark { display: grid; place-items: center; inline-size: 20px; block-size: 20px; border-radius: 50%; flex: none; background: var(--nzc-card-hi); }
.bld-st-mark[data-state='done'] { background: var(--nzc-success-soft); color: var(--nzc-success); }
.bld-st-mark[data-state='active'] { background: var(--nzc-accent-soft); }
.bld-st-mark[data-state='failed'] { background: var(--nzc-danger-soft); color: var(--nzc-danger); }
.bld-st-detail { margin-inline-start: auto; font-size: 12px; color: var(--nzc-muted); font-variant-numeric: tabular-nums; }
.bld-run-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
.bld-run-actions { display: inline-flex; gap: 14px; }
.bld-link { padding: 0; border: 0; background: none; color: var(--nzc-accent); font: inherit; cursor: pointer; text-decoration: none; }
.bld-link:disabled { opacity: 0.5; cursor: default; }
.bld-history { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; font-size: 12px; max-block-size: 220px; overflow: auto; }
.bld-run .nz-card { padding: 12px; border: 0; border-radius: 14px; background: var(--nzc-card-hi); box-shadow: none; }
.bld-run .nz-card h3 { margin: 0 0 6px; font-size: 14px; }
.bld-run .nz-card .bld-list { display: flex; flex-wrap: wrap; gap: 6px; margin-block: 8px; }
.bld-run .nz-card .bld-list li { padding: 4px 10px; border-radius: 999px; background: var(--nzc-field); font-size: 12px; }
.bws-working { position: absolute; inset-block-end: 24px; inset-inline: 0; margin-inline: auto; inline-size: max-content; max-inline-size: 90%; z-index: 3; display: flex; align-items: center; gap: 10px; padding: 9px 16px; border-radius: 999px; background: var(--nzc-elev); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); font-size: 13px; }
.bws-gen-state { flex: 1; min-block-size: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 32px; text-align: center; background: var(--nzc-card); }
.bws-gen-state p { margin: 0; max-inline-size: 60ch; color: var(--nzc-fg); }
.bws-gen-state p.nz-muted { color: var(--nzc-muted); }
.bws-gen-state[data-state='failed'] h2 { color: var(--nzc-danger, #e5484d); }
.bws-edit { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border: 0; border-radius: 10px; background: var(--nzc-field); color: var(--nzc-muted); font: inherit; font-size: 13px; cursor: pointer; }
.bws-edit:hover, .bws-edit[aria-pressed='true'] { background: var(--nzc-card-hi); color: var(--nzc-fg); }
.bws-more-meta { padding: 8px 12px; font-size: 12px; color: var(--nzc-muted); }
@media (prefers-reduced-motion: reduce) { .bld-orbit, .bld-spinner, .bld-bar[data-busy] > span { animation: none; } }

/* Code view: file tree and search, a numbered and tinted viewer, a collapsible bottom panel */
.bwc { flex: 1; min-block-size: 0; display: flex; flex-direction: column; background: var(--nzc-card); }
.bwc-main { flex: 1; min-block-size: 0; display: grid; grid-template-columns: 310px minmax(0, 1fr); gap: 0; border-block-end: 1px solid var(--nzc-line, rgba(127,127,127,0.18)); }
.bwc-side { min-block-size: 0; overflow: auto; background: var(--nzc-card); border-inline-end: 1px solid var(--nzc-line, rgba(127,127,127,0.18)); }
.bwc-side-tabs { display: flex; gap: 6px; padding: 0 14px; block-size: 46px; align-items: center; position: sticky; inset-block-start: 0; background: var(--nzc-card); border-block-end: 1px solid var(--nzc-line, rgba(127,127,127,0.18)); z-index: 1; }
.bwc-side-tabs button, .bwc-btabs button { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border: 0; border-radius: 9px; background: transparent; color: var(--nzc-muted); font: inherit; font-size: 13px; cursor: pointer; }
.bwc-side-tabs button:hover, .bwc-btabs button:hover { color: var(--nzc-fg); }
.bwc-side-tabs button { padding: 6px 8px; font-size: 15px; }
.bwc-side-tabs button[aria-selected='true'], .bwc-btabs button[aria-selected='true'] { background: transparent; color: var(--nzc-fg); font-weight: 600; }
.bwc-btabs button[aria-selected='true'] { background: var(--nzc-card-hi); }
.bwc-pad { padding: 12px 16px; margin: 0; }
.bwc-tree { list-style: none; margin: 0; padding: 6px 10px 12px; }
.bwc-tree .bwc-tree { padding: 0; padding-inline-start: 14px; }
.bwc-tree summary { display: flex; align-items: center; gap: 10px; min-block-size: 40px; padding: 0 10px; border-radius: 6px; cursor: pointer; list-style: none; font-size: 15px; color: var(--nzc-fg); }
.bwc-tree summary::-webkit-details-marker { display: none; }
.bwc-tree summary:hover, .bwc-file:hover { background: var(--nzc-card-hi); }
.bwc-tree summary .nzc-icon { transition: transform 0.15s; opacity: 0.7; }
.bwc-tree details[open] > summary .nzc-icon { transform: rotate(90deg); }
.bwc-file { display: flex; align-items: center; gap: 10px; inline-size: 100%; min-block-size: 40px; padding: 0 10px; border: 2px solid transparent; border-radius: 6px; background: transparent; color: var(--nzc-fg); font: inherit; font-size: 15px; cursor: pointer; text-align: start; }
.bwc-file .nzc-icon { opacity: 0.6; flex: none; }
.bwc-file[aria-current='true'] { border-color: var(--nzc-accent); background: transparent; }
.bwc-file:focus-visible, .bwc-tree summary:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: -2px; }
.bwc-search { padding: 8px 12px 14px; display: grid; gap: 10px; }
.bwc-search input { inline-size: 100%; padding: 9px 12px; border: 0; border-radius: 10px; background: var(--nzc-card-hi); color: var(--nzc-fg); font: inherit; font-size: 13px; outline: none; box-sizing: border-box; }
.bwc-search input:focus { box-shadow: 0 0 0 1px var(--nzc-accent); }
.bwc-search ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.bwc-search li button { display: grid; gap: 2px; inline-size: 100%; padding: 7px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--nzc-fg); font: inherit; font-size: 12px; text-align: start; cursor: pointer; }
.bwc-search li button:hover { background: var(--nzc-card-hi); }
.bwc-hit-path { color: var(--nzc-accent); }
.bwc-hit-text { color: var(--nzc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.bwc-editor { display: flex; flex-direction: column; min-inline-size: 0; min-block-size: 0; background: var(--nzc-card); }
.bwc-bar { display: flex; align-items: center; gap: 10px; flex-wrap: nowrap; block-size: 46px; padding: 0 16px; background: var(--nzc-card); border-block-end: 1px solid var(--nzc-line, rgba(127,127,127,0.18)); font-size: 15px; }
.bwc-bar .nzc-icon { opacity: 0.7; flex: none; }
.bwc-path { font-weight: 500; }
.bwc-meta { color: var(--nzc-muted); font-size: 12px; }
.bwc-chip { padding: 2px 10px; border-radius: 999px; background: var(--nzc-field); color: var(--nzc-muted); font-size: 11px; }
.bwc-copy { margin-inline-start: auto; padding: 5px 12px; border: 0; border-radius: 8px; background: var(--nzc-field); color: var(--nzc-fg); font: inherit; font-size: 12px; cursor: pointer; }
.bwc-copy:hover { background: var(--nzc-elev); }
.bwc-code { flex: 1; min-block-size: 0; overflow: auto; padding: 10px 0 24px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.65; }
.bwc-line { display: flex; }
.bwc-line:first-child { background: var(--nzc-card-hi); }
.bwc-line:hover { background: var(--nzc-card-hi); }
.bwc-line[data-hit='true'] { background: var(--nzc-accent-soft); }
.bwc-ln { flex: none; inline-size: 62px; padding-inline-end: 22px; text-align: end; color: var(--nzc-muted); opacity: 0.7; user-select: none; }
.bwc-line code { white-space: pre; tab-size: 2; font: inherit; }
.tok-tag { color: var(--nzc-success); }
.tok-prop { color: var(--nzc-accent); }
.tok-attr { color: var(--nzc-fg); opacity: 0.85; }
.tok-num, .tok-at { color: var(--nzc-warn); }
.tok-str { color: var(--nzc-warn); }
.tok-kw { color: var(--nzc-accent-strong, var(--nzc-accent)); font-weight: 600; }
.tok-com { color: var(--nzc-muted); font-style: italic; }
.bwc-empty { flex: 1; display: grid; place-content: center; justify-items: center; gap: 8px; padding: 24px; text-align: center; color: var(--nzc-muted); }
.bwc-empty strong { color: var(--nzc-fg); font-size: 15px; }
.bwc-empty p { margin: 0; max-inline-size: 42ch; }
.bwc-bottom { flex: none; background: var(--nzc-card); }
.bwc-btabs { display: flex; align-items: center; gap: 2px; padding: 6px 10px; }
.bwc-collapse { padding: 6px !important; }
.bwc-collapse .nzc-icon { transform: rotate(-90deg); transition: transform 0.15s; }
.bwc-collapse[aria-expanded='true'] .nzc-icon { transform: rotate(90deg); }
.bwc-bbody { block-size: 190px; overflow: auto; padding: 8px 18px 16px; font-size: 13px; border-block-start: 1px solid var(--nzc-line, rgba(127,127,127,0.18)); }
.bwc-term { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; line-height: 1.7; padding-block: 14px; }
.bwc-term p { margin: 0; }
.bwc-term .ok { color: var(--nzc-success); }
.bwc-term .arrow { color: var(--nzc-success); }
.bwc-term .hint { margin-block-start: 8px; color: var(--nzc-muted); }
.bwc-pub-head { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin: 0 0 8px; }
.bwc-log { margin: 0; max-block-size: 200px; overflow: auto; padding: 10px 12px; border-radius: 10px; background: var(--nzc-field); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
/* Data view */
.bwd { flex: 1; min-block-size: 0; display: flex; flex-direction: column; overflow: auto; background: var(--nzc-card); }
.bwd-tabs { display: flex; gap: 4px; padding: 10px 14px; position: sticky; inset-block-start: 0; background: var(--nzc-card); z-index: 1; }
.bwd-tabs button { padding: 8px 14px; border: 0; border-radius: 10px; background: transparent; color: var(--nzc-muted); font: inherit; font-size: 13px; cursor: pointer; }
.bwd-tabs button:hover { color: var(--nzc-fg); }
.bwd-tabs button[aria-selected='true'] { background: var(--nzc-accent-soft); color: var(--nzc-accent); }
.bwd-body { padding: 18px 28px 36px; max-inline-size: 1040px; display: grid; gap: 14px; align-content: start; }
.bwd-body h2 { margin: 0; font-size: 22px; }
.bwd-body > p { margin: 0; }
.bwd-cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.bwd-cards button { display: flex; align-items: center; gap: 12px; inline-size: 100%; padding: 14px 16px; border: 0; border-radius: 14px; background: var(--nzc-field); color: var(--nzc-fg); font: inherit; cursor: pointer; text-align: start; }
.bwd-cards button:hover { background: var(--nzc-card-hi); }
.bwd-cards button[aria-pressed='true'] { background: var(--nzc-card-hi); box-shadow: inset 0 0 0 1px var(--nzc-accent); }
.bwd-card-name { display: grid; flex: 1; min-inline-size: 0; }
.bwd-card-name small { color: var(--nzc-muted); font-size: 11px; }
.bwd-card-count { color: var(--nzc-muted); font-size: 12px; white-space: nowrap; }
.bwd-table { display: grid; gap: 10px; }
.bwd-table-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.bwd-scroll { overflow: auto; border-radius: 12px; background: var(--nzc-field); }
.bwd-scroll table { inline-size: 100%; border-collapse: collapse; font-size: 13px; }
.bwd-scroll th { padding: 10px 14px; text-align: start; color: var(--nzc-muted); font-weight: 600; font-size: 12px; white-space: nowrap; }
.bwd-scroll td { padding: 9px 14px; border-block-start: 1px solid var(--nzc-border); max-inline-size: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bwd-scroll tbody tr:hover { background: var(--nzc-card-hi); }
.bwd-empty { display: grid; justify-items: start; gap: 8px; padding: 22px; border-radius: 16px; background: var(--nzc-field); }
.bwd-empty strong { font-size: 15px; }
.bwd-empty p { margin: 0; }
.bwd-links { display: inline-flex; gap: 16px; }
.bwd-assets, .bwd-history { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.bwd-assets li { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 12px; background: var(--nzc-field); }
.bwd-assets small, .bwd-history small { display: block; color: var(--nzc-muted); font-size: 12px; }
.bwd-asset-ph { display: grid; place-items: center; inline-size: 44px; block-size: 44px; border-radius: 10px; background: var(--nzc-card-hi); color: var(--nzc-muted); flex: none; }
.bwd-history li { display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-radius: 12px; background: var(--nzc-field); }
.bwd-history li[data-current='true'] { box-shadow: inset 0 0 0 1px var(--nzc-accent); }
.bwd-v { font-weight: 600; min-inline-size: 84px; }
@media (max-width: 900px) { .bwc-main { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); } .bwc-side { max-block-size: 38vh; } }

/* The slim bar of the full-screen start page */
.nzc a.bws-exit { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 10px; background: var(--nzc-field); color: var(--nzc-muted); font-size: 13px; text-decoration: none; }
.nzc a.bws-exit { padding: 0; inline-size: 36px; block-size: 36px; justify-content: center; }
.nzc a.bws-exit:hover { background: var(--nzc-card-hi); color: var(--nzc-fg); }

/* The preview while the AI writes the site: a wireframe whose sections appear one after another, looping until the run ends */
.bscene-wrap { position: absolute; inset: 0; z-index: 2; animation: bscene-in 0.35s ease both; }
.bscene-wrap[data-leaving='true'] { animation: bscene-out 0.6s ease both; pointer-events: none; }
@keyframes bscene-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes bscene-out { from { opacity: 1; } to { opacity: 0; } }
.bscene { position: relative; inline-size: 100%; block-size: 100%; display: grid; place-items: center; padding: 28px 28px 84px; box-sizing: border-box; overflow: hidden; background: radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--nzc-accent) 14%, transparent), transparent 62%), var(--nzc-field); }
.bscene-line { position: absolute; inset-block-start: 0; inset-inline: 0; block-size: 3px; background: linear-gradient(90deg, transparent, var(--nzc-accent), transparent); background-size: 40% 100%; background-repeat: no-repeat; animation: bscene-sweep 1.8s ease-in-out infinite; }
@keyframes bscene-sweep { from { background-position: -40% 0; } to { background-position: 140% 0; } }
.bscene-window { position: relative; inline-size: min(900px, 100%); max-block-size: 100%; border-radius: 18px; background: var(--nzc-card); box-shadow: 0 24px 70px rgba(0, 0, 0, 0.35); overflow: hidden; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.bscene-chrome { display: flex; align-items: center; gap: 7px; padding: 12px 16px; background: var(--nzc-card-hi); }
.bscene-chrome span { inline-size: 10px; block-size: 10px; border-radius: 50%; background: var(--nzc-border); }
.bscene-chrome b { margin-inline-start: 14px; flex: 1; max-inline-size: 280px; block-size: 18px; border-radius: 9px; background: var(--nzc-field); }
.bscene-page { display: grid; gap: 18px; padding: 20px 24px 26px; align-content: start; overflow: hidden; }
.bscene-pop { animation: bscene-pop 6.4s cubic-bezier(0.22, 1, 0.36, 1) infinite; animation-delay: calc(var(--i, 0) * 0.5s); opacity: 0; }
@keyframes bscene-pop { 0% { opacity: 0; transform: translateY(14px) scale(0.985); } 9% { opacity: 1; transform: none; } 84% { opacity: 1; transform: none; } 100% { opacity: 0; transform: translateY(-4px); } }
.bscene i, .bscene-cards > div, .bscene-wide, .bscene-img { display: block; border-radius: 8px; background: var(--nzc-card-hi); }
.bscene-nav { display: flex; align-items: center; gap: 12px; }
.bscene-nav i { block-size: 10px; inline-size: 52px; }
.bscene-nav i.logo { inline-size: 92px; block-size: 18px; background: var(--nzc-accent); opacity: 0.85; }
.bscene-nav i.cta { margin-inline-start: auto; inline-size: 72px; block-size: 24px; border-radius: 12px; background: var(--nzc-accent-soft); }
.bscene-hero { display: grid; grid-template-columns: 1.15fr 1fr; gap: 22px; align-items: center; }
.bscene-copy { display: grid; gap: 10px; }
.bscene-copy i.t1 { block-size: 22px; inline-size: 88%; }
.bscene-copy i.t2 { block-size: 22px; inline-size: 62%; }
.bscene-copy i.p { block-size: 9px; inline-size: 94%; opacity: 0.7; }
.bscene-copy i.p.short { inline-size: 70%; }
.bscene-copy i.btn { block-size: 30px; inline-size: 120px; border-radius: 15px; background: var(--nzc-accent); opacity: 0.85; margin-block-start: 6px; }
.bscene-img { aspect-ratio: 4 / 3; border-radius: 14px; }
.bscene-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.bscene-cards > div { aspect-ratio: 5 / 4; border-radius: 12px; }
.bscene-wide { block-size: 68px; border-radius: 14px; }
.bscene-foot { display: flex; gap: 14px; padding-block-start: 4px; }
.bscene-foot i { block-size: 9px; inline-size: 70px; opacity: 0.6; }
.bscene .shimmer { background-image: linear-gradient(100deg, transparent 20%, color-mix(in srgb, var(--nzc-accent) 22%, transparent) 50%, transparent 80%); background-size: 220% 100%; background-color: var(--nzc-card-hi); animation: bscene-shimmer 1.6s linear infinite; }
@keyframes bscene-shimmer { from { background-position: 220% 0; } to { background-position: -120% 0; } }
.bscene-glow { position: absolute; inline-size: 120px; block-size: 120px; margin: -60px; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--nzc-accent) 45%, transparent), transparent 70%); filter: blur(6px); pointer-events: none; inset-inline-start: 12%; inset-block-start: 22%; animation: bscene-glow 6.4s ease-in-out infinite; }
@keyframes bscene-glow { 0% { inset-inline-start: 14%; inset-block-start: 16%; } 22% { inset-inline-start: 60%; inset-block-start: 34%; } 48% { inset-inline-start: 30%; inset-block-start: 58%; } 72% { inset-inline-start: 74%; inset-block-start: 74%; } 100% { inset-inline-start: 14%; inset-block-start: 16%; } }
@media (max-width: 720px) { .bscene-hero { grid-template-columns: 1fr; } .bscene-img { display: none; } }
@media (prefers-reduced-motion: reduce) { .bscene-pop { animation: none; opacity: 1; } .bscene .shimmer, .bscene-glow, .bscene-line { animation: none; } .bscene-wrap { animation: none; } }

/* Builder landing (/builder/projects): full-height hero with the prompt and the app choice, then tabs for the person's projects and starter examples. No top bar: the only chrome is the floating Exit. */
.nzc-body:has(> .bl) { padding: 0; background: var(--nzc-bg); }
.nzc-body > .bl { max-inline-size: none; margin: 0; }
.nzc a.bfs-float { position: fixed; inset-block-start: 16px; inset-inline-end: 16px; z-index: 60; display: inline-flex; align-items: center; gap: 8px; box-sizing: border-box; block-size: 40px; padding-inline: 12px 14px; border: 0; border-radius: 12px; background: var(--sig-chip, var(--nzc-field)); box-shadow: none; color: var(--nzc-fg); font: inherit; font-size: 14px; font-weight: 650; text-decoration: none; cursor: pointer; transition: background 0.15s ease, opacity 0.15s ease; }
/* the two corner buttons of the start screen (Projects, Exit) are one standard button: a quiet fill, no outline, no shadow */
.nzc a.bfs-float:hover, .bh-toggle:hover { background: var(--sig-chip-on, var(--nzc-card-hi)); }
.nzc a.bfs-float:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }
.bl-hero { position: relative; min-block-size: 100vh; min-block-size: 100dvh; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 56px 24px 96px; overflow: hidden; }
.bl-glow { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse 60% 45% at 15% 0%, color-mix(in srgb, var(--nzc-accent) 22%, transparent), transparent 70%), radial-gradient(ellipse 50% 40% at 90% 30%, color-mix(in srgb, var(--nzc-accent) 14%, transparent), transparent 70%), radial-gradient(ellipse 70% 50% at 50% 110%, color-mix(in srgb, var(--nzc-accent) 12%, transparent), transparent 70%); }
.bl-form { position: relative; inline-size: min(100%, 880px); display: grid; gap: 22px; }
.bl-intro { display: grid; justify-items: center; gap: 14px; text-align: center; }
.bl-brand { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border: 1px solid var(--nzc-border); border-radius: 999px; background: color-mix(in srgb, var(--nzc-card) 80%, transparent); color: var(--nzc-muted); font-size: 13px; font-weight: 600; }
.bl-title { margin: 0; font-size: clamp(34px, 5.6vw, 64px); line-height: 1.08; letter-spacing: -0.02em; font-weight: 800; max-inline-size: 16ch; text-wrap: balance; }
html[lang='ar'] .bl-title { letter-spacing: 0; line-height: 1.25; max-inline-size: 22ch; }
.bl-sub { margin: 0; max-inline-size: 56ch; color: var(--nzc-muted); font-size: clamp(15px, 1.6vw, 18px); line-height: 1.6; }
.bl-prompt { border: 1px solid color-mix(in srgb, var(--nzc-accent) 34%, var(--nzc-border)); border-radius: 26px; background: var(--nzc-card); box-shadow: 0 24px 70px color-mix(in srgb, var(--nzc-accent) 14%, transparent), 0 2px 6px #0000001f; transition: box-shadow 0.2s ease, border-color 0.2s ease; }
.bl-prompt:focus-within { border-color: var(--nzc-accent); box-shadow: 0 24px 80px color-mix(in srgb, var(--nzc-accent) 24%, transparent), 0 0 0 3px color-mix(in srgb, var(--nzc-accent) 22%, transparent); }
.bl-input { display: block; inline-size: 100%; box-sizing: border-box; min-block-size: 150px; resize: vertical; padding: 24px 26px 8px; border: 0; background: transparent; color: var(--nzc-fg); font: inherit; font-size: 17px; line-height: 1.6; outline: none; }
.bl-input::placeholder { color: var(--nzc-muted); }
.bl-prompt-foot { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding-block: 10px 14px; padding-inline: 26px 14px; }
.bl-count { color: var(--nzc-muted); font-size: 12.5px; }
.bl-prompt-foot .bl-count { flex: 1; min-inline-size: 0; }
.bl-src { position: relative; flex: none; }
.bl-src-plus { display: grid; place-items: center; inline-size: 40px; block-size: 40px; border: 1px solid var(--nzc-border); border-radius: 12px; background: var(--nzc-field); color: var(--nzc-fg); cursor: pointer; transition: background 0.15s ease, transform 0.15s ease, border-color 0.15s ease; }
.bl-src-plus:hover { background: var(--nzc-card-hi); border-color: color-mix(in srgb, var(--nzc-accent) 40%, var(--nzc-border)); }
.bl-src-plus[aria-expanded='true'] { background: color-mix(in srgb, var(--nzc-accent) 16%, var(--nzc-card)); border-color: var(--nzc-accent); }
.bl-src-plus[aria-expanded='true'] .nzc-icon { transform: rotate(45deg); }
.bl-src-plus .nzc-icon { transition: transform 0.18s ease; }
.bl-src-plus:focus-visible, .bl-src-item:focus-visible, .bl-chip-x:focus-visible, .bl-gh-list button:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }
.bl-src-menu { position: absolute; inset-block-end: calc(100% + 10px); inset-inline-start: -6px; z-index: 30; display: grid; gap: 2px; inline-size: min(330px, 86vw); padding: 8px; border: 1px solid var(--nzc-border); border-radius: 18px; background: var(--nzc-card); box-shadow: var(--nzc-shadow); animation: bl-pop 0.16s ease-out; }
@keyframes bl-pop { from { opacity: 0; transform: translateY(6px) scale(0.98); } }
.bl-src-title { margin: 4px 10px 6px; color: var(--nzc-muted); font-size: 12px; font-weight: 650; }
.bl-src-item { display: flex; align-items: center; gap: 12px; inline-size: 100%; padding: 9px 10px; border: 0; border-radius: 12px; background: transparent; color: var(--nzc-fg); font: inherit; text-align: start; cursor: pointer; transition: background 0.12s ease; }
.bl-src-item:hover:not(:disabled) { background: var(--nzc-card-hi); }
.bl-src-item:disabled { opacity: 0.5; cursor: not-allowed; }
.bl-src-icon { display: grid; place-items: center; flex: none; inline-size: 34px; block-size: 34px; border-radius: 10px; background: color-mix(in srgb, var(--nzc-accent) 14%, var(--nzc-field)); color: var(--nzc-accent); }
.bl-src-item:nth-of-type(3) .bl-src-icon { background: var(--nzc-orange-soft); color: var(--nzc-orange-text); }
.bl-src-text { display: grid; gap: 2px; min-inline-size: 0; }
.bl-src-text b { font-size: 14px; font-weight: 650; }
.bl-src-text small { color: var(--nzc-muted); font-size: 12px; line-height: 1.4; }
.bl-chip-src { display: flex; align-items: center; gap: 10px; inline-size: max-content; max-inline-size: calc(100% - 36px); margin: 16px 18px 0; padding-block: 8px; padding-inline: 10px 8px; border: 1px solid var(--nzc-border); border-radius: 14px; background: var(--nzc-field); animation: bl-pop 0.16s ease-out; }
.bl-chip-icon { display: grid; place-items: center; flex: none; inline-size: 32px; block-size: 32px; border-radius: 10px; background: color-mix(in srgb, var(--nzc-accent) 16%, var(--nzc-card)); color: var(--nzc-accent); }
.bl-chip-src[data-kind='github'] .bl-chip-icon { background: var(--nzc-orange-soft); color: var(--nzc-orange-text); }
.bl-chip-text { display: grid; gap: 1px; min-inline-size: 0; }
.bl-chip-text b { overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.bl-chip-text small { color: var(--nzc-muted); font-size: 12px; }
.bl-chip-x { display: grid; place-items: center; flex: none; inline-size: 28px; block-size: 28px; border: 0; border-radius: 8px; background: transparent; color: var(--nzc-muted); cursor: pointer; }
.bl-chip-x:hover { background: var(--nzc-card-hi); color: var(--nzc-fg); }
.bl-gh { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--nzc-border); border-radius: 20px; background: var(--nzc-card); box-shadow: var(--nzc-shadow); animation: bl-pop 0.16s ease-out; }
.bl-gh-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.bl-gh-head h3 { margin: 0; font-size: 16px; }
.bl-gh-note { margin: 0; color: var(--nzc-muted); font-size: 13.5px; line-height: 1.6; }
.bl-gh-fake { margin: 0; padding: 8px 12px; border-radius: 10px; background: var(--nzc-warn-soft); color: var(--nzc-warn); font-size: 12.5px; }
.bl-gh-connect { display: grid; justify-items: start; gap: 12px; }
.bl-gh-search { display: flex; align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--nzc-field-border); border-radius: 12px; background: var(--nzc-field); color: var(--nzc-muted); }
.bl-gh-search:focus-within { border-color: var(--nzc-accent); }
.bl-gh-search input { flex: 1; min-inline-size: 0; padding: 10px 0; border: 0; background: transparent; color: var(--nzc-fg); font: inherit; outline: none; }
.bl-gh-list { display: grid; gap: 2px; max-block-size: 260px; margin: 0; padding: 0; overflow-y: auto; list-style: none; }
.bl-gh-list button { display: flex; align-items: center; gap: 10px; inline-size: 100%; padding: 10px 12px; border: 0; border-radius: 10px; background: transparent; color: var(--nzc-fg); font: inherit; font-size: 14px; text-align: start; cursor: pointer; }
.bl-gh-list button:hover { background: var(--nzc-card-hi); }
.bl-gh-list button > .nzc-icon { flex: none; color: var(--nzc-orange-text); }
.bl-gh-list button > span { flex: 1; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bl-gh-list small { padding: 2px 8px; border-radius: 999px; background: var(--nzc-card-hi); color: var(--nzc-muted); font-size: 11.5px; }
.bl-type:has(input:disabled) { opacity: 0.45; cursor: not-allowed; }
.bl-type:has(input:disabled) input { cursor: not-allowed; }
.bh-toggle { position: fixed; inset-block-start: 16px; inset-inline-start: 16px; z-index: 62; display: inline-flex; align-items: center; gap: 8px; box-sizing: border-box; block-size: 40px; padding-inline: 12px 14px; border: 0; border-radius: 12px; background: var(--sig-chip, var(--nzc-field)); box-shadow: none; color: var(--nzc-fg); font: inherit; font-size: 14px; font-weight: 650; text-decoration: none; cursor: pointer; transition: background 0.15s ease, opacity 0.15s ease; }

.bh-toggle[aria-expanded='true'] { opacity: 0; pointer-events: none; }
.bh-toggle:focus-visible, .bh-icon:focus-visible, .bh-new:focus-visible, .bh-folder-btn:focus-visible, .bh-add:focus-visible, .bh-chats a:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }
/* docked like the support panel: a rounded card along the inline-start edge; the page makes room for it (wide screens) */
.bh-panel { position: fixed; overscroll-behavior: contain; inset-block: 10px; inset-inline-start: 10px; z-index: 64; display: flex; flex-direction: column; inline-size: 320px; box-sizing: border-box; overflow: hidden; border: 1px solid var(--nzc-border); border-radius: 22px; background: var(--nzc-card); animation: bh-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both; }
.bh-panel[hidden] { display: none; }
@keyframes bh-in { from { opacity: 0; transform: translateX(-16px); } to { opacity: 1; transform: none; } }
html[dir='rtl'] .bh-panel { animation-name: bh-in-rtl; }
@keyframes bh-in-rtl { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
.bl { transition: padding-inline-start 260ms cubic-bezier(0.16, 1, 0.3, 1); }
.bh-scrim { display: none; }
@media (min-width: 901px) {
  .bl:has(> .bh-panel:not([hidden])) { padding-inline-start: 340px; }
}
@media (max-width: 900px) {
  .bh-scrim { display: block; position: fixed; inset: 0; z-index: 63; background: #0000004d; }
  .bh-panel { inset-block: 0; inset-inline-start: 0; inline-size: min(330px, 88vw); border-radius: 0; border-block: 0; border-inline-start: 0; box-shadow: var(--nzc-shadow); }
}
.bh-head { display: flex; align-items: center; gap: 12px; padding-block: 14px; padding-inline: 16px 12px; border-block-end: 1px solid var(--nzc-border); background: color-mix(in srgb, var(--nzc-accent) 7%, var(--nzc-card)); }
.bh-avatar { display: grid; place-items: center; flex: none; inline-size: 38px; block-size: 38px; border-radius: 12px; background: var(--nzc-field); border: 1px solid var(--nzc-border); }
.nzc[data-theme='light'] .bh-avatar img { filter: brightness(0.62) saturate(1.3); }
.bh-head-text { display: grid; flex: 1; min-inline-size: 0; }
.bh-head-text strong { font-size: 15px; }
.bh-head-text small { color: var(--nzc-muted); font-size: 12.5px; }
.bh-icon { display: grid; place-items: center; flex: none; inline-size: 34px; block-size: 34px; border: 0; border-radius: 10px; background: transparent; color: var(--nzc-muted); cursor: pointer; }
.bh-icon:hover { background: var(--nzc-elev); color: var(--nzc-fg); }
.bh-tools { display: grid; gap: 8px; padding: 12px 12px 6px; }
.nzc a.bh-new { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; background: var(--nzc-field); color: var(--nzc-fg); font-size: 14px; font-weight: 650; text-decoration: none; transition: background 0.12s ease; }
.nzc a.bh-new:hover { background: var(--nzc-card-hi); }
.bh-new-icon { display: grid; place-items: center; flex: none; inline-size: 24px; block-size: 24px; border-radius: 50%; background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); }
.bh-search { display: flex; align-items: center; gap: 8px; min-inline-size: 0; padding: 0 10px; border: 1px solid var(--nzc-border); border-radius: 12px; background: transparent; color: var(--nzc-muted); transition: border-color 0.12s ease, box-shadow 0.12s ease; }
.bh-search:focus-within { border-color: var(--nzc-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--nzc-accent) 22%, transparent); }
/* the console styles every input; the search field is a bare line inside its box */
.nzc .bh-search input, .nzc .bh-search input:hover, .nzc .bh-search input:focus { flex: 1; min-inline-size: 0; inline-size: 100%; min-block-size: 0 !important; padding: 9px 0 !important; border: 0 !important; border-radius: 0 !important; background: transparent !important; box-shadow: none !important; outline: none; color: var(--nzc-fg); font: inherit; font-size: 13.5px; }
.bl-gh-search input:focus-visible { outline: none; }
.bl-gh-search:has(input:focus-visible) { box-shadow: 0 0 0 3px color-mix(in srgb, var(--nzc-accent) 25%, transparent); }
/* the list never scrolls sideways: every track is allowed to shrink and long names end with an ellipsis */
.bh-list { flex: 1; min-block-size: 0; min-inline-size: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 2px 8px 16px; }
.bh-label { margin: 12px 10px 6px; color: var(--nzc-muted); font-size: 11.5px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; }
html[lang='ar'] .bh-label { letter-spacing: 0; text-transform: none; font-size: 12.5px; }
.bh-folders, .bh-chats { display: grid; grid-template-columns: minmax(0, 1fr); margin: 0; padding: 0; list-style: none; }
.bh-folders { gap: 1px; }
.bh-folder { min-inline-size: 0; }
.bh-folder-row { display: flex; align-items: center; min-inline-size: 0; border-radius: 10px; transition: background 0.12s ease; }
.bh-folder-row:hover, .bh-folder[data-open] > .bh-folder-row { background: var(--nzc-card-hi); }
.nzc .bh-folder-btn { display: flex; flex: 1; align-items: center; gap: 8px; min-inline-size: 0; padding: 7px 6px; border: 0; border-radius: 10px; background: transparent; color: var(--nzc-fg); font: inherit; text-align: start; text-decoration: none; cursor: pointer; }
.bh-chev { display: grid; place-items: center; flex: none; inline-size: 14px; color: var(--nzc-muted); transition: transform 0.18s ease; }
.bh-folder[data-open] .bh-chev { transform: rotate(90deg); }
html[dir='rtl'] .bh-chev { transform: scaleX(-1); }
html[dir='rtl'] .bh-folder[data-open] .bh-chev { transform: rotate(90deg); }
.bh-folder-icon { display: grid; place-items: center; flex: none; inline-size: 26px; block-size: 26px; border-radius: 8px; background: color-mix(in srgb, var(--nzc-accent) 14%, var(--nzc-field)); color: var(--nzc-accent); }
.bh-folder-icon[data-type='webapp'] { background: var(--nzc-orange-soft); color: var(--nzc-orange-text); }
.bh-folder-name { flex: 1; min-inline-size: 0; overflow: hidden; font-size: 13.5px; font-weight: 600; text-align: start; text-overflow: ellipsis; white-space: nowrap; unicode-bidi: plaintext; }
.bh-count, .bh-when { flex: none; color: var(--nzc-muted); font-size: 11px; }
.bh-count { min-inline-size: 18px; padding: 1px 6px; border-radius: 999px; background: var(--nzc-field); text-align: center; }
.bh-add { display: grid; place-items: center; flex: none; inline-size: 28px; block-size: 28px; margin-inline-end: 4px; border: 0; border-radius: 8px; background: transparent; color: var(--nzc-muted); cursor: pointer; opacity: 0; transition: opacity 0.12s ease, background 0.12s ease; }
.bh-folder-row:hover .bh-add, .bh-folder-row:focus-within .bh-add, .bh-add[aria-busy='true'] { opacity: 1; }
.bh-add:hover { background: var(--nzc-orange-soft); color: var(--nzc-orange-text); }
.bh-add:disabled { cursor: wait; }
@media (hover: none) { .bh-add { opacity: 1; } }
.bh-chats { gap: 1px; margin-block: 2px 6px; margin-inline-start: 20px; padding-inline-start: 10px; border-inline-start: 1px solid var(--nzc-border); }
.bh-chats.bh-loose { margin-inline-start: 4px; border-inline-start: 0; padding-inline-start: 0; }
.nzc .bh-chats a, .bh-orphan { display: flex; align-items: baseline; gap: 8px; min-inline-size: 0; padding: 6px 10px; border-radius: 8px; color: color-mix(in srgb, var(--nzc-fg) 86%, var(--nzc-muted)); font-size: 13px; text-decoration: none; }
.bh-chats a > span, .bh-orphan > span { flex: 1; min-inline-size: 0; overflow: hidden; text-align: start; text-overflow: ellipsis; white-space: nowrap; unicode-bidi: plaintext; }
.bh-chats small, .bh-orphan small { flex: none; color: var(--nzc-muted); font-size: 11px; }
.nzc .bh-chats a:hover { background: var(--nzc-card-hi); color: var(--nzc-fg); }
.bh-orphan { color: var(--nzc-muted); }
.bh-note { margin: 10px; color: var(--nzc-muted); font-size: 13px; line-height: 1.6; }
.bh-err { margin: 2px 12px 8px; color: var(--nzc-danger); }
.bh-link { padding: 0; border: 0; background: none; color: var(--nzc-accent); font: inherit; cursor: pointer; text-decoration: underline; }
@media (prefers-reduced-motion: reduce) { .bh-panel, .bl { animation: none; transition: none; } }
.bl-tpl-btn { display: inline-flex; flex: none; align-items: center; gap: 7px; block-size: 40px; padding-inline: 12px 14px; border: 1px solid var(--nzc-border); border-radius: 12px; background: var(--nzc-field); color: var(--nzc-fg); font: inherit; font-size: 13.5px; font-weight: 650; cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease; }
.bl-tpl-btn:hover, .bl-tpl-btn[aria-expanded='true'] { background: var(--nzc-card-hi); border-color: color-mix(in srgb, var(--nzc-accent) 40%, var(--nzc-border)); }
.bl-tpl-btn > .nzc-icon { color: var(--nzc-accent); }
.bl-tpl-btn:focus-visible, .bl-tpl-tabs button:focus-visible, .bl-tpl-card:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }
.bl-tpl-scrim { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 20px; background: #0000008c; backdrop-filter: blur(4px); animation: bh-fade 0.16s ease-out; overscroll-behavior: contain; }
@keyframes bh-fade { from { opacity: 0; } }
.bl-tpl { display: flex; flex-direction: column; gap: 16px; inline-size: min(860px, 100%); max-block-size: min(720px, calc(100vh - 40px)); box-sizing: border-box; padding: 22px; overflow: hidden; border: 1px solid var(--sig-box-edge, var(--nzc-border)); border-radius: 22px; background: radial-gradient(60% 50% at 50% -10%, color-mix(in srgb, #bcdccb 14%, transparent), transparent 70%), var(--nzc-card); box-shadow: var(--nzc-shadow); animation: bl-pop 0.18s ease-out; }
.bl-tpl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.bl-tpl-head h2 { margin: 0 0 4px; color: var(--sig-ink, var(--nzc-fg)); font-size: 22px; font-weight: var(--sig-weight, 600); }
.bl-tpl-head p { margin: 0; max-inline-size: 60ch; color: var(--sig-sub, var(--nzc-muted)); font-size: 13.5px; line-height: 1.6; }
.bl-tpl-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.bl-tpl-tabs button { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border: 1px solid transparent; border-radius: 999px; background: var(--sig-chip, var(--nzc-field)); color: var(--sig-chip-ink, var(--nzc-muted)); font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; }
.bl-tpl-tabs button[aria-selected='true'] { border-color: color-mix(in srgb, var(--nzc-accent) 60%, transparent); background: var(--sig-chip-on, var(--nzc-card-hi)); color: var(--nzc-fg); }
.bl-tpl-tabs small { padding: 1px 7px; border-radius: 999px; background: var(--nzc-orange-soft); color: var(--nzc-orange-text); font-size: 10.5px; }
.bl-tpl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr)); gap: 14px; min-block-size: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px; scrollbar-width: thin; }
.bl-tpl-soon { grid-column: 1 / -1; text-align: start; }
.bl-tpl-card { display: grid; grid-template-rows: auto 1fr auto; padding: 0; overflow: hidden; border: 1px solid transparent; border-radius: 18px; background: var(--sig-chip, var(--nzc-field)); color: var(--nzc-fg); font: inherit; text-align: start; cursor: pointer; transition: transform 0.16s ease, border-color 0.16s ease; }
.bl-tpl-card:hover:not(:disabled) { transform: translateY(-3px); border-color: color-mix(in srgb, var(--nzc-accent) 45%, transparent); }
.bl-tpl-card:disabled { opacity: 0.5; cursor: not-allowed; }
.bl-tpl-art { --h: 160; position: relative; display: grid; align-content: end; gap: 6px; block-size: 96px; padding: 14px; box-sizing: border-box; background: linear-gradient(150deg, hsl(var(--h) 45% 44% / 0.32), hsl(calc(var(--h) + 40) 45% 40% / 0.08) 70%); }
.bl-tpl-art i { display: block; block-size: 7px; border-radius: 5px; background: hsl(var(--h) 35% 82% / 0.4); }
.bl-tpl-art i:nth-of-type(1) { inline-size: 58%; block-size: 9px; }
.bl-tpl-art i:nth-of-type(2) { inline-size: 84%; }
.bl-tpl-art i:nth-of-type(3) { inline-size: 42%; }
.bl-tpl-icon { position: absolute; inset-block-start: 12px; inset-inline-end: 12px; display: grid; place-items: center; inline-size: 36px; block-size: 36px; border-radius: 11px; background: var(--nzc-card); color: hsl(var(--h) 55% 62%); }
.bl-tpl-card[data-tpl='restaurant'] .bl-tpl-art { --h: 28; }
.bl-tpl-card[data-tpl='portfolio'] .bl-tpl-art { --h: 170; }
.bl-tpl-card[data-tpl='clinic'] .bl-tpl-art { --h: 195; }
.bl-tpl-card[data-tpl='shop'] .bl-tpl-art { --h: 340; }
.bl-tpl-card[data-tpl='crm'] .bl-tpl-art { --h: 250; }
.bl-tpl-card[data-tpl='inventory'] .bl-tpl-art { --h: 215; }
.bl-tpl-card[data-tpl='booking'] .bl-tpl-art { --h: 300; }
.bl-tpl-card[data-tpl='salon'] .bl-tpl-art { --h: 320; }
.bl-tpl-card[data-tpl='delivery'] .bl-tpl-art { --h: 20; }
.bl-tpl-card[data-tpl='fitness'] .bl-tpl-art { --h: 140; }
.bl-tpl-body { display: grid; align-content: start; gap: 6px; padding: 14px 14px 6px; }
.bl-tpl-body b { font-size: 15px; }
.bl-tpl-body small { color: var(--nzc-muted); font-size: 12.5px; line-height: 1.55; }
.bl-tpl-use { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px 14px; color: var(--nzc-orange-text); font-size: 13px; font-weight: 650; }
html[dir='rtl'] .bl-tpl-use .nzc-icon { transform: scaleX(-1); }
@media (max-width: 760px) { .bl-tpl-btn > span { display: none; } .bl-tpl { padding: 16px; } }
.bl-go { display: inline-flex; align-items: center; gap: 8px; min-inline-size: 120px; justify-content: center; padding: 12px 22px; border: 0; border-radius: 14px; background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); font: inherit; font-weight: 700; cursor: pointer; transition: transform 0.15s ease, opacity 0.15s ease; }
.bl-go:hover:not(:disabled) { transform: translateY(-1px); }
.bl-go:disabled { opacity: 0.55; cursor: not-allowed; }
.bl-err { margin: 0; text-align: center; }
.bl-label { margin: 0 0 10px; color: var(--nzc-muted); font-size: 12.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; text-align: center; }
html[lang='ar'] .bl-label { letter-spacing: 0; text-transform: none; font-size: 13.5px; }
.bl-types-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.bl-type { position: relative; display: flex; align-items: center; gap: 14px; padding: 16px 18px; border: 1px solid var(--nzc-border); border-radius: 18px; background: color-mix(in srgb, var(--nzc-card) 78%, transparent); cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease; }
.bl-type:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--nzc-accent) 45%, var(--nzc-border)); }
.bl-type input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.bl-type:has(input:focus-visible) { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }
.bl-type:has(input:checked) { border-color: var(--nzc-accent); background: color-mix(in srgb, var(--nzc-accent) 12%, var(--nzc-card)); box-shadow: 0 10px 30px color-mix(in srgb, var(--nzc-accent) 16%, transparent); }
.bl-type[data-soon='true'] { border-style: dashed; } /* the soon badge says it; a faded tile fell below the AA text contrast */
.bl-type-icon { display: grid; place-items: center; flex: none; inline-size: 44px; block-size: 44px; border-radius: 14px; background: color-mix(in srgb, var(--nzc-accent) 16%, var(--nzc-field)); color: var(--nzc-accent); }
.bl-type-text { display: grid; gap: 3px; min-inline-size: 0; flex: 1; }
.bl-type-text strong { font-size: 16px; }
.bl-type-text small { color: var(--nzc-muted); font-size: 12.5px; line-height: 1.4; }
.bl-type:has(input:checked) .bl-type-text small { color: var(--nzc-fg); } /* the checked tile is tinted with the accent: muted text on it was 4.43:1, below AA */
.bl-type-dot { flex: none; inline-size: 18px; block-size: 18px; border: 2px solid var(--nzc-border); border-radius: 50%; transition: border-color 0.15s ease, background 0.15s ease; }
.bl-type:has(input:checked) .bl-type-dot { border-color: var(--nzc-accent); background: radial-gradient(circle, var(--nzc-accent) 0 45%, transparent 50%); }
.bl-note { margin: 0; text-align: center; color: var(--nzc-muted); font-size: 13px; }
.bl-opts { justify-self: center; inline-size: 100%; text-align: start; }
.bl-opts summary { cursor: pointer; text-align: center; color: var(--nzc-muted); font-size: 13.5px; }
.bl-opts[open] summary { margin-block-end: 12px; }
.bl-opts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 16px; padding: 16px; border: 1px solid var(--nzc-border); border-radius: 16px; background: color-mix(in srgb, var(--nzc-card) 70%, transparent); }
.bl-opts-grid fieldset { margin: 0; padding: 0; border: 0; }
.bl-opts-grid legend, .bl-field > span { font-size: 13px; font-weight: 600; margin-block-end: 6px; }
.bl-field { display: grid; gap: 6px; }
.bl-check { display: block; padding-block: 3px; }
.bl-cue { position: absolute; inset-block-end: 26px; inset-inline: 0; margin-inline: auto; inline-size: max-content; display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; color: var(--nzc-muted); font-size: 13px; text-decoration: none; }
.bl-cue .nzc-icon { transform: rotate(90deg); animation: bl-bob 1.8s ease-in-out infinite; }
.bl-cue:hover { color: var(--nzc-fg); }
@keyframes bl-bob { 0%, 100% { translate: 0 0; } 50% { translate: 0 4px; } }
.bl-more { box-sizing: border-box; min-block-size: 100vh; min-block-size: 100dvh; padding: 72px 24px 120px; background: color-mix(in srgb, var(--nzc-card) 55%, var(--nzc-bg)); border-block-start: 1px solid var(--nzc-border); }
.bl-more > * { max-inline-size: 1120px; margin-inline: auto; }
.bl-tabs { display: flex; gap: 6px; inline-size: max-content; max-inline-size: 100%; padding: 5px; margin-block-end: 32px !important; border: 1px solid var(--nzc-border); border-radius: 16px; background: var(--nzc-card); }
.bl-tabs button { display: inline-flex; align-items: center; gap: 8px; padding: 11px 20px; border: 0; border-radius: 12px; background: transparent; color: var(--nzc-muted); font: inherit; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.15s ease, color 0.15s ease; }
.bl-tabs button:hover { color: var(--nzc-fg); }
.bl-tabs button[aria-selected='true'] { background: var(--nzc-accent); color: var(--nzc-on-accent); }
.bl-count-badge { min-inline-size: 22px; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, currentColor 18%, transparent); font-size: 12px; text-align: center; }
.bl-ex-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr)); gap: 18px; }
.bl-ex { display: grid; grid-template-rows: auto 1fr auto; inline-size: 100%; block-size: 100%; padding: 0; overflow: hidden; border: 1px solid var(--nzc-border); border-radius: 20px; background: var(--nzc-card); color: var(--nzc-fg); font: inherit; text-align: start; cursor: pointer; transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease; }
.bl-ex:hover { transform: translateY(-4px); border-color: color-mix(in srgb, var(--nzc-accent) 55%, var(--nzc-border)); box-shadow: 0 18px 44px #00000030; }
.bl-ex:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }
.bl-ex-art, .bl-pcover { --h: 160; position: relative; display: grid; align-content: end; gap: 7px; block-size: 124px; padding: 16px; box-sizing: border-box; background: linear-gradient(150deg, hsl(var(--h) 55% 46% / 0.34), hsl(calc(var(--h) + 40) 55% 40% / 0.1) 70%), var(--nzc-field); border-block-end: 1px solid var(--nzc-border); }
.bl-ex-art i, .bl-pcover i { display: block; block-size: 9px; border-radius: 6px; background: hsl(var(--h) 40% 80% / 0.35); }
.bl-ex-art i:nth-of-type(1), .bl-pcover i:nth-of-type(1) { inline-size: 62%; block-size: 12px; background: hsl(var(--h) 40% 85% / 0.55); }
.bl-ex-art i:nth-of-type(2), .bl-pcover i:nth-of-type(2) { inline-size: 88%; }
.bl-ex-art i:nth-of-type(3), .bl-pcover i:nth-of-type(3) { inline-size: 46%; }
.bl-ex-icon, .bl-pcover-icon { position: absolute; inset-block-start: 14px; inset-inline-end: 14px; display: grid; place-items: center; inline-size: 40px; block-size: 40px; border-radius: 12px; background: var(--nzc-card); color: hsl(var(--h) 60% 62%); box-shadow: 0 4px 14px #0000002a; }
.bl-ex[data-example='restaurant'] .bl-ex-art { --h: 28; }
.bl-ex[data-example='portfolio'] .bl-ex-art { --h: 170; }
.bl-ex[data-example='clinic'] .bl-ex-art { --h: 195; }
.bl-ex[data-example='shop'] .bl-ex-art { --h: 340; }
.bl-ex[data-example='crm'] .bl-ex-art { --h: 250; }
.bl-ex[data-example='inventory'] .bl-ex-art { --h: 215; }
.bl-ex[data-example='booking'] .bl-ex-art { --h: 300; }
.bl-ex-body { display: grid; align-content: start; gap: 8px; padding: 18px 18px 8px; }
.bl-ex-body strong { font-size: 17px; }
.bl-ex-text { color: var(--nzc-muted); font-size: 13.5px; line-height: 1.55; }
.bl-ex-use { display: inline-flex; align-items: center; justify-content: space-between; padding: 12px 18px 16px; color: var(--nzc-accent); font-size: 14px; font-weight: 650; }
.bl-ex:hover .bl-ex-use .nzc-icon { transform: translateX(3px); }
html[dir='rtl'] .bl-ex:hover .bl-ex-use .nzc-icon { transform: translateX(-3px); }
.bl-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-block-end: 24px; }
.bl-chip { padding: 8px 16px; border: 1px solid var(--nzc-border); border-radius: 999px; background: var(--nzc-card); color: var(--nzc-muted); font-size: 14px; text-decoration: none; }
.bl-chip:hover { color: var(--nzc-fg); }
.bl-chip[aria-current='page'] { border-color: var(--nzc-accent); background: color-mix(in srgb, var(--nzc-accent) 16%, var(--nzc-card)); color: var(--nzc-fg); font-weight: 600; }
.bl-pgrid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 20px; }
.bl-pgrid > li { min-inline-size: 0; }
.bl-pcard { display: grid; grid-template-rows: auto 1fr; block-size: 100%; overflow: hidden; border: 1px solid var(--nzc-border); border-radius: 20px; background: var(--nzc-card); transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease; }
.bl-pcard:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--nzc-accent) 50%, var(--nzc-border)); box-shadow: 0 16px 40px #0000002c; }
.bl-pcard[data-type='webapp'] .bl-pcover { --h: 250; }
.bl-pcard[data-type='mobile'] .bl-pcover { --h: 300; }
.bl-pcard[data-type='website'] .bl-pcover { --h: 160; }
.bl-pcover { block-size: 108px; text-decoration: none; }
.bl-pbody { display: grid; align-content: start; gap: 14px; padding: 18px; }
.bl-ptop { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.bl-ptop h2 { margin: 0; font-size: 17px; line-height: 1.4; overflow-wrap: anywhere; }
.bl-ptop h2 a { color: var(--nzc-fg); text-decoration: none; }
.bl-ptop h2 a:hover { color: var(--nzc-accent); }
.bl-pmeta { display: grid; gap: 8px; margin: 0; font-size: 12.5px; }
.bl-pmeta > div { display: flex; justify-content: space-between; gap: 12px; }
.bl-pmeta dt { color: var(--nzc-muted); }
.bl-pmeta dd { margin: 0; text-align: end; overflow-wrap: anywhere; }
.bl-pactions { display: flex; align-items: center; gap: 8px; }
.bl-pactions .bl-popen { flex: 1; }
.bl-popen { display: inline-flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 12px; background: var(--nzc-field); color: var(--nzc-fg); font-size: 14px; font-weight: 600; text-decoration: none; }
.bl-popen:hover { background: color-mix(in srgb, var(--nzc-accent) 18%, var(--nzc-field)); }
.bl-readonly { padding: 48px 24px; max-inline-size: 1120px; margin-inline: auto; }
@media (max-width: 760px) { .bl-hero { padding: 40px 16px 88px; } .bl-types-grid { grid-template-columns: 1fr; } .bl-more { padding: 48px 16px 110px; } .bl-tabs { inline-size: 100%; } .bl-tabs button { flex: 1; justify-content: center; padding-inline: 12px; } .bl-prompt-foot { flex-wrap: wrap; } }
@media (max-height: 860px) and (min-width: 761px) { .bl-hero { padding-block: 28px 76px; } .bl-form { gap: 14px; } .bl-intro { gap: 10px; } .bl-title { font-size: clamp(30px, 4.6vw, 52px); } .bl-input { min-block-size: 104px; padding-block-start: 18px; } .bl-type { padding: 12px 16px; } .bl-label { margin-block-end: 6px; } .bl-cue { inset-block-end: 16px; } }
@media (prefers-reduced-motion: reduce) { .bl-cue .nzc-icon { animation: none; } .bl-type, .bl-ex, .bl-pcard, .nzc a.bfs-float { transition: none; } }
/* Mobile app workspace (the mobile mode of the builder workspace): phone preview, panels, run details */
button.bws-publish { border: 0; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
.mws .bws-top { row-gap: 8px; }
.mws .mws-tabs-seg { flex-wrap: wrap; }
.mws-preview { flex: 1; min-block-size: 0; display: flex; flex-direction: column; gap: 10px; padding: 12px; overflow: auto; }
.mws-stage { flex: 1; min-block-size: 0; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 20px 12px 28px; border-radius: 14px; background: var(--nzc-field); overflow: auto; }
.mws-proposed { margin: 0; display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px; background: var(--nzc-accent-soft); color: var(--nzc-accent); font-size: 13px; }
.mws-panel { flex: 1; min-block-size: 0; overflow: auto; padding: 18px; }
.mws-load-error { display: grid; gap: 10px; justify-items: start; }
.mws-dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 18px; margin: 0 0 18px; }
.mws-dl dt { color: var(--nzc-muted); }
.mws-dl dd { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.mws-swatch { display: inline-block; inline-size: 16px; block-size: 16px; border-radius: 5px; border: 1px solid rgba(127, 127, 127, 0.4); vertical-align: middle; }
.mws-code { min-block-size: 0; }
.mws-code-count { font-size: 12px; padding-block: 8px 0; }
.mws-run .mws-failed { display: grid; gap: 8px; }
.mws-reasons { padding: 10px 12px; border-radius: 12px; background: var(--nzc-danger-soft); }
.mws-reasons-h { margin: 0 0 4px; font-size: 12px; font-weight: 650; color: var(--nzc-danger); }
.mws-reasons ul { margin: 0; padding-inline-start: 18px; display: grid; gap: 4px; font-size: 13px; }
.mws-design { display: grid; gap: 6px; font-size: 13px; }
.mws-design p { margin: 0; }
.mws-design .bld-list { margin-block: 2px; }

/* the phone / tablet frame: plain HTML and CSS, scoped to .mws-device; the screen's own colours come from the design's theme */
.mws-device { --mws-w: 336px; --mws-h: clamp(560px, calc(100vh - 250px), 700px); flex: none; box-sizing: border-box; block-size: var(--mws-h); aspect-ratio: 336 / 690; padding: 11px; border-radius: 46px; background: #0b0e13; box-shadow: 0 0 0 2px #2b323c, 0 24px 60px rgba(0, 0, 0, 0.45); position: relative; }
.mws-device[data-device='tablet'] { --mws-h: clamp(520px, calc(100vh - 250px), 720px); aspect-ratio: 560 / 720; border-radius: 30px; padding: 14px; }
.mws-device[data-device='phone']::before { content: ''; position: absolute; inset-block-start: 20px; inset-inline: 0; margin-inline: auto; inline-size: 74px; block-size: 20px; border-radius: 12px; background: #0b0e13; z-index: 2; }
.mws-screen { --m-bg: #f6f7f9; --m-surface: #ffffff; --m-text: #14181f; --m-muted: #5c6877; --m-border: #cfd5dc; --m-container: color-mix(in srgb, var(--m-primary) 20%, #ffffff); --m-field: #ffffff; box-sizing: border-box; block-size: 100%; display: flex; flex-direction: column; overflow: hidden; border-radius: 36px; background: var(--m-bg); color: var(--m-text); font-family: var(--nuzm-font-sans, system-ui, sans-serif); font-size: 14px; line-height: 1.45; text-align: start; }
.mws-device[data-device='tablet'] .mws-screen { border-radius: 20px; }
.mws-screen[data-dark='true'] { --m-bg: #0f1318; --m-surface: #1a2029; --m-text: #eef1f5; --m-muted: #a2adbb; --m-border: #3a4350; --m-container: color-mix(in srgb, var(--m-primary) 34%, #1a2029); --m-field: #161b22; }
.mws-status { flex: none; display: flex; justify-content: space-between; align-items: center; padding: 14px 24px 4px; font-size: 12px; font-weight: 600; color: var(--m-text); }
.mws-status-icons { inline-size: 40px; block-size: 9px; border-radius: 3px; background: linear-gradient(90deg, var(--m-muted) 0 22%, transparent 22% 30%, var(--m-muted) 30% 56%, transparent 56% 64%, var(--m-text) 64%); opacity: 0.8; }
.mws-appbar { flex: none; padding: 12px 20px 14px; background: var(--m-bg); font-size: 20px; font-weight: 600; color: var(--m-text); }
.mws-content { flex: 1; min-block-size: 0; overflow: auto; padding: 4px 16px 16px; }
.mws-h2 { margin: 6px 0 10px; font-size: 22px; font-weight: 500; }
.mws-h3 { margin: 14px 0 8px; font-size: 15px; font-weight: 600; }
.mws-body { margin: 0; font-size: 16px; color: var(--m-text); }
.mws-info { padding-block-start: 4px; }
.mws-empty { margin: 40px 0; text-align: center; color: var(--m-muted); }
.mws-list { list-style: none; margin: 0; padding: 0; }
.mws-list li { display: flex; align-items: center; gap: 14px; padding: 10px 4px; }
.mws-avatar { flex: none; display: grid; place-items: center; inline-size: 40px; block-size: 40px; border-radius: 50%; background: var(--m-container); color: var(--m-text); font-weight: 600; }
.mws-li-text { flex: 1; min-inline-size: 0; display: grid; }
.mws-li-text strong { font-size: 16px; font-weight: 400; }
.mws-li-text span { font-size: 13px; color: var(--m-muted); }
.mws-chev { flex: none; inline-size: 8px; block-size: 8px; border-block-start: 2px solid var(--m-muted); border-inline-end: 2px solid var(--m-muted); transform: rotate(45deg); }
.mws-screen[dir='rtl'] .mws-chev { transform: rotate(-45deg); }
.mws-form { display: grid; gap: 14px; padding-block-start: 8px; }
.mws-field { position: relative; }
.mws-flabel { position: absolute; inset-block-start: -8px; inset-inline-start: 10px; padding-inline: 4px; background: var(--m-bg); font-size: 12px; color: var(--m-muted); }
.mws-input { display: flex; align-items: center; justify-content: space-between; min-block-size: 46px; padding: 0 14px; border: 1px solid var(--m-border); border-radius: 4px; background: transparent; color: var(--m-muted); }
.mws-input[data-multiline='true'] { min-block-size: 92px; align-items: flex-start; }
.mws-caret { inline-size: 8px; block-size: 8px; border-block-end: 2px solid var(--m-muted); border-inline-end: 2px solid var(--m-muted); transform: rotate(45deg); margin-block-end: 3px; }
.mws-screen[dir='rtl'] .mws-caret { transform: rotate(-45deg); }
.mws-switch { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 16px; }
.mws-toggle { position: relative; inline-size: 48px; block-size: 28px; border-radius: 14px; border: 2px solid var(--m-border); background: transparent; }
.mws-toggle::after { content: ''; position: absolute; inset-block-start: 6px; inset-inline-start: 6px; inline-size: 12px; block-size: 12px; border-radius: 50%; background: var(--m-muted); }
.mws-btn { display: grid; place-items: center; min-block-size: 44px; margin-block-start: 6px; border-radius: 22px; background: var(--m-primary); color: var(--m-on-primary); font-weight: 600; font-size: 15px; }
.mws-btn-outline { background: transparent; border: 1px solid var(--m-border); color: var(--m-primary); }
.mws-screen[data-dark='true'] .mws-btn-outline { color: var(--m-text); }
.mws-seg { display: flex; border: 1px solid var(--m-border); border-radius: 20px; overflow: hidden; }
.mws-seg span { flex: 1; text-align: center; padding: 9px 6px; font-size: 14px; color: var(--m-text); }
.mws-seg span + span { border-inline-start: 1px solid var(--m-border); }
.mws-seg span[data-on='true'] { background: var(--m-container); font-weight: 600; }
.mws-tabs { flex: none; display: flex; padding: 8px 4px 14px; background: var(--m-surface); border-block-start: 1px solid var(--m-border); }
.mws-tab { flex: 1; min-inline-size: 0; display: grid; justify-items: center; gap: 4px; padding: 0; border: 0; background: transparent; color: var(--m-muted); font: inherit; font-size: 11px; cursor: pointer; }
.mws-tab span:last-child { max-inline-size: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mws-tab-pill { display: grid; place-items: center; inline-size: 56px; block-size: 30px; border-radius: 15px; }
.mws-tab[aria-current='page'] { color: var(--m-text); font-weight: 600; }
.mws-tab[aria-current='page'] .mws-tab-pill { background: var(--m-container); }
.mws-tab:focus-visible { outline: 2px solid var(--m-primary); outline-offset: 2px; border-radius: 8px; }
/* Web app mode of the workspace */
.mws-meters { display: grid; gap: 2px; margin: 0; font-size: 12px; }
.mws-meters div { display: flex; justify-content: space-between; gap: 8px; }
.mws-meters dt { color: var(--nzc-muted); }
.mws-meters dd { margin: 0; }
.mws-app-preview { display: grid; gap: 14px; align-content: start; }
.mws-live-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.mws-live-head h2 { margin: 0; font-size: 16px; font-weight: 700; }
.mws-panel[data-panel='preview'] { padding: 0; overflow: hidden; display: flex; flex-direction: column; }
.mws-live { flex: 1; min-block-size: 0; display: flex; flex-direction: column; gap: 0; }
.mws-live > :not(.mws-live-frame, .mws-live-wait, .nz-sr) { margin: 12px; }
.mws-live-frame { position: relative; flex: 1; min-block-size: 0; overflow: hidden; background: var(--nzc-card); }
.mws-live-frame[data-loaded='true'] { background: #fff; }
.mws-live-frame iframe { position: absolute; inset: 0; display: block; inline-size: 100%; block-size: 100%; border: 0; opacity: 0; transition: opacity 0.25s ease; }
.mws-live-frame[data-loaded='true'] iframe { opacity: 1; }
.mws-live-wait { display: flex; align-items: center; justify-content: center; gap: 10px; margin: auto; color: var(--nzc-muted); font-size: 14px; }
.mws-live-frame .mws-live-wait { position: absolute; inset: 0; margin: 0; }
.mws-built p { margin: 0 0 10px; }
.bld-run .bld-steps .bld-st-detail { display: inline-flex; align-items: center; gap: 4px; }
.mws-ico { display: block; }
/* Web app studio: Code (type glyphs, version selector, change markers), Data (tables, migrations, API) and the run activity timeline */
.bwc-glyph { display: inline-grid; place-items: center; flex: none; min-inline-size: 28px; block-size: 18px; padding-inline: 4px; border-radius: 5px; background: var(--nzc-field); color: var(--nzc-muted); font: 600 9.5px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.02em; }
.bwc-glyph[data-tone='code'] { color: var(--nzc-accent); background: var(--nzc-accent-soft); }
.bwc-glyph[data-tone='data'] { color: var(--nzc-warn); background: var(--nzc-warn-soft); }
.bwc-glyph[data-tone='style'] { color: var(--nzc-accent-strong, var(--nzc-accent)); }
.bwc-glyph[data-tone='markup'] { color: var(--nzc-success); background: var(--nzc-success-soft); }
.bwc-file > span[dir] { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bwc-fsize { margin-inline-start: auto; flex: none; color: var(--nzc-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.bwc-mark { flex: none; inline-size: 7px; block-size: 7px; border-radius: 50%; background: var(--nzc-accent); }
.bwc-mark[data-change='added'] { background: var(--nzc-success); }
.bwc-mark[data-change='modified'] { background: var(--nzc-warn); }
.bwc-file[data-change] > span[dir] { font-weight: 600; }
.bwc-fsize + .bwc-mark { margin-inline-start: 0; }
.bwc-mark { order: 3; }
.bwc-ver { display: grid; gap: 6px; padding: 10px 14px; border-block-end: 1px solid var(--nzc-line, rgba(127,127,127,0.18)); font-size: 12px; }
.bwc-ver label { color: var(--nzc-muted); }
.bwc-ver select { inline-size: 100%; padding: 7px 10px; border: 0; border-radius: 9px; background: var(--nzc-card-hi); color: var(--nzc-fg); font: inherit; font-size: 13px; }
.bwc-ver select:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 1px; }
.bwc-ver-note { color: var(--nzc-muted); }
.bwc-copy-next { margin-inline-start: 0; }
.bwc-bar .bwc-path { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bwc-changes { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.bwc-changes li { display: flex; align-items: center; gap: 10px; }
.bwc-changes button { padding: 0; border: 0; background: transparent; color: var(--nzc-accent); font: inherit; cursor: pointer; text-align: start; }
.bwc-changes button:hover { text-decoration: underline; }
.bwc-chg { flex: none; padding: 1px 8px; border-radius: 999px; background: var(--nzc-field); color: var(--nzc-muted); font: 11px system-ui, sans-serif; }
.bwc-chg[data-change='added'] { background: var(--nzc-success-soft); color: var(--nzc-success); }
.bwc-chg[data-change='modified'] { background: var(--nzc-warn-soft); color: var(--nzc-warn); }
.bwc-chg[data-change='removed'] { background: var(--nzc-danger-soft); color: var(--nzc-danger); }

.wsp-pane { flex: 1; min-block-size: 0; display: flex; flex-direction: column; background: var(--nzc-card); }
.wsp-pane > .bwc { flex: 1; min-block-size: 0; }
.wsp-subbar { flex: none; display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 14px; border-block-end: 1px solid var(--nzc-line, rgba(127,127,127,0.18)); background: var(--nzc-card); }
.wsp-subbar button { display: inline-flex; align-items: center; gap: 7px; padding: 7px 13px; border: 0; border-radius: 10px; background: transparent; color: var(--nzc-muted); font: inherit; font-size: 13px; cursor: pointer; }
.wsp-subbar button:hover { color: var(--nzc-fg); }
.wsp-subbar button[aria-selected='true'] { background: var(--nzc-accent-soft); color: var(--nzc-accent); font-weight: 600; }
.wsp-subbar button:focus-visible, .wsp-list button:focus-visible, .wsp-link:focus-visible, .wsp-seg button:focus-visible, .wsp-ev-open:focus-visible, .wsp-prod button:focus-visible, .wsp-act-h button:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }
.wsp-scroll { flex: 1; min-block-size: 0; overflow: auto; padding: 16px 18px 28px; }
.wsp-sec { display: grid; gap: 14px; align-content: start; }
.wsp-summary { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; color: var(--nzc-muted); font-size: 13px; }
.wsp-link { padding: 0; border: 0; background: transparent; color: var(--nzc-accent); font: inherit; cursor: pointer; text-align: start; }
.wsp-link:hover { text-decoration: underline; }
.wsp-split { display: grid; grid-template-columns: minmax(200px, 270px) minmax(0, 1fr); gap: 14px; align-items: start; }
.wsp-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.wsp-list button { display: flex; align-items: center; gap: 10px; inline-size: 100%; padding: 10px 12px; border: 0; border-radius: 12px; background: var(--nzc-field); color: var(--nzc-fg); font: inherit; font-size: 13px; text-align: start; cursor: pointer; }
.wsp-list button:hover { background: var(--nzc-card-hi); }
.wsp-list button[aria-pressed='true'] { background: var(--nzc-card-hi); box-shadow: inset 0 0 0 1px var(--nzc-accent); }
.wsp-list .nzc-icon { flex: none; opacity: 0.7; }
.wsp-list-name { display: grid; flex: 1; min-inline-size: 0; font-weight: 550; overflow-wrap: anywhere; }
.wsp-list-name small { color: var(--nzc-muted); font-weight: 400; font-size: 11px; }
.wsp-list-count { color: var(--nzc-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.wsp-detail { display: grid; gap: 16px; align-content: start; min-inline-size: 0; padding: 16px; border-radius: 16px; background: var(--nzc-field); }
.wsp-detail-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.wsp-detail-head h3 { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.wsp-badges { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.wsp-tablewrap { overflow: auto; border-radius: 12px; background: var(--nzc-card); }
.wsp-tablewrap:focus-visible { outline: 2px solid var(--nzc-accent); }
.wsp-table { inline-size: 100%; border-collapse: collapse; font-size: 13px; }
.wsp-table th, .wsp-table td { padding: 9px 12px; text-align: start; vertical-align: top; border-block-start: 1px solid var(--nzc-border); }
.wsp-table thead th { border-block-start: 0; color: var(--nzc-muted); font-size: 12px; font-weight: 600; white-space: nowrap; }
.wsp-table tbody th { font-weight: 550; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.wsp-table th small { display: block; font-family: system-ui, sans-serif; font-weight: 400; color: var(--nzc-muted); }
.wsp-table td { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.wsp-table tr[data-system='true'] > * { opacity: 0.62; }
.wsp-rules { display: inline-flex; flex-wrap: wrap; gap: 5px; align-items: center; font-family: system-ui, sans-serif; }
.wsp-rules .nz-badge { white-space: nowrap; }
.wsp-enum { color: var(--nzc-muted); font-size: 11px; overflow-wrap: anywhere; }
.wsp-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.wsp-h4 { margin: 0 0 6px; font-size: 13px; font-weight: 650; }
.wsp-plain { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 13px; }
.wsp-plain li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.wsp-chips { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.wsp-chips code { padding: 2px 8px; border-radius: 6px; background: var(--nzc-card); color: var(--nzc-muted); font-size: 11px; }
.wsp-endpoints { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 13px; }
.wsp-endpoints li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.wsp-endpoints li > :nth-child(2) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
.wsp-card { display: grid; gap: 8px; padding: 14px 16px; border-radius: 14px; background: var(--nzc-field); }
.wsp-card .wsp-h4 { margin: 0; }
.wsp-viewer { padding: 0; gap: 0; overflow: hidden; background: var(--nzc-card); box-shadow: inset 0 0 0 1px var(--nzc-border); }
.wsp-viewer-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 10px 14px; border-block-end: 1px solid var(--nzc-line, rgba(127,127,127,0.18)); font-size: 13px; }
.wsp-viewer-bar .bwc-path { flex: 1 1 160px; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsp-viewer-bar .bwc-copy { margin-inline-start: 0; }
.wsp-danger { color: var(--nzc-danger); }
.wsp-viewer .bwc-code { max-block-size: 60vh; min-block-size: 160px; }
.wsp-seg { display: inline-flex; padding: 3px; border-radius: 10px; background: var(--nzc-field); }
.wsp-seg button { padding: 5px 12px; border: 0; border-radius: 8px; background: transparent; color: var(--nzc-muted); font: inherit; font-size: 12px; cursor: pointer; }
.wsp-seg button[aria-pressed='true'] { background: var(--nzc-card-hi); color: var(--nzc-fg); font-weight: 600; }
.wsp-destructive { list-style: none; margin: 0; padding: 8px 14px; display: grid; gap: 4px; background: var(--nzc-danger-soft); color: var(--nzc-danger); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }

.wsp-prod { display: grid; gap: 6px; }
.wsp-prod-h { margin: 0; font-size: 12px; font-weight: 650; color: var(--nzc-muted); }
.wsp-prod ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.wsp-prod button { display: inline-flex; align-items: center; gap: 7px; padding: 5px 10px; border: 0; border-radius: 999px; background: var(--nzc-card-hi); color: var(--nzc-fg); font: inherit; font-size: 12px; cursor: pointer; }
.wsp-prod button:hover:not(:disabled) { background: var(--nzc-elev); }
.wsp-prod button[data-warn='true'] { box-shadow: inset 0 0 0 1px var(--nzc-warn); }
.wsp-prod button b { color: var(--nzc-accent); font-variant-numeric: tabular-nums; }
.wsp-prod button .nzc-icon { opacity: 0.55; }
.wsp-prod-warn { color: var(--nzc-warn); font-size: 11px; }
.wsp-act { display: grid; gap: 8px; }
.wsp-act-h { margin: 0; font-size: 12px; font-weight: 650; }
.wsp-act-h button { display: inline-flex; align-items: center; gap: 6px; padding: 2px 0; border: 0; background: transparent; color: var(--nzc-muted); font: inherit; cursor: pointer; }
.wsp-act-h button:hover { color: var(--nzc-fg); }
.wsp-act-h .nzc-icon { transition: transform 0.15s; }
.wsp-act-h button[aria-expanded='true'] .nzc-icon { transform: rotate(90deg); }
.wsp-act-count { padding: 0 7px; border-radius: 999px; background: var(--nzc-card-hi); font-size: 11px; font-variant-numeric: tabular-nums; }
.wsp-act-count:empty { display: none; }
.wsp-ev { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; position: relative; max-block-size: 340px; overflow: auto; }
.wsp-ev li { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 10px; padding: 6px 0; font-size: 12.5px; position: relative; }
.wsp-ev li:not(:last-child)::before { content: ''; position: absolute; inset-inline-start: 10px; inset-block: 28px -6px; inline-size: 1px; background: var(--nzc-border); }
.wsp-ev-ico { display: grid; place-items: center; inline-size: 22px; block-size: 22px; border-radius: 50%; background: var(--nzc-card-hi); color: var(--nzc-muted); }
.wsp-ev li[data-tone='ok'] .wsp-ev-ico { background: var(--nzc-success-soft); color: var(--nzc-success); }
.wsp-ev li[data-tone='warn'] .wsp-ev-ico, .wsp-ev li[data-tone='wait'] .wsp-ev-ico { background: var(--nzc-warn-soft); color: var(--nzc-warn); }
.wsp-ev li[data-tone='danger'] .wsp-ev-ico { background: var(--nzc-danger-soft); color: var(--nzc-danger); }
.wsp-ev li[data-tone='info'] .wsp-ev-ico { background: var(--nzc-accent-soft); color: var(--nzc-accent); }
.wsp-ev-main { min-inline-size: 0; display: grid; gap: 2px; justify-items: start; }
.wsp-ev-main p { margin: 0; color: var(--nzc-fg); overflow-wrap: anywhere; }
.wsp-ev li[data-tone='danger'] .wsp-ev-main p { color: var(--nzc-danger); font-weight: 600; }
.wsp-ev-detail { color: var(--nzc-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.wsp-ev-reasons { margin: 2px 0 0; padding: 8px 10px; padding-inline-start: 24px; border-radius: 10px; background: var(--nzc-danger-soft); display: grid; gap: 3px; font-size: 12px; overflow-wrap: anywhere; }
.wsp-ev-open { display: inline-flex; align-items: center; gap: 5px; padding: 0; border: 0; background: transparent; color: var(--nzc-accent); font: inherit; font-size: 11.5px; cursor: pointer; }
.wsp-ev-open:hover { text-decoration: underline; }
.wsp-ev time { color: var(--nzc-muted); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; padding-block-start: 3px; }
.wsp-ev-empty { margin: 0; font-size: 12px; }
.bld-hist { list-style: none; }
.wsp-past { background: var(--nzc-field); }
.wsp-past .bld-run-head strong { font-size: 13px; }
.wsp-past-body { display: grid; gap: 12px; }
@media (max-width: 900px) { .wsp-split, .wsp-grid2 { grid-template-columns: minmax(0, 1fr); } .wsp-scroll { padding-inline: 12px; } }
@media (max-width: 720px) { .mws-device, .mws-device[data-device='tablet'] { max-inline-size: 100%; } .mws-dl { grid-template-columns: minmax(0, 1fr); } }

/* Content never hides behind the floating AI builder card or the basket: the page body leaves room at its end. */
.nzc-body { padding-block-end: 84px; }
.nzc-body:has(> .bl), .nzc-app:has(.bws) .nzc-body { padding-block-end: 0; }

/* Hosting plans: hero, hosting-type cards, plan cards. */
.hs { display: grid; gap: 28px; }
.hs-hero { position: relative; overflow: hidden; display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.6fr); align-items: center; gap: 24px; padding: 44px 44px 40px; border: 1px solid var(--nzc-border); border-radius: 28px; background: var(--nzc-card); }
.hs-glow { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse 55% 90% at 8% 0%, color-mix(in srgb, var(--nzc-accent) 22%, transparent), transparent 70%), radial-gradient(ellipse 45% 70% at 100% 100%, color-mix(in srgb, var(--nzc-accent) 14%, transparent), transparent 70%); }
.hs-hero-copy { position: relative; display: grid; gap: 14px; justify-items: start; }
.hs-pill { padding: 6px 14px; border-radius: 999px; background: color-mix(in srgb, var(--nzc-accent) 16%, transparent); color: var(--nzc-accent); font-size: 13px; font-weight: 650; }
.hs-hero h2 { margin: 0; max-inline-size: 18ch; font-size: clamp(30px, 4vw, 52px); line-height: 1.1; letter-spacing: -0.025em; font-weight: 780; text-wrap: balance; }
html[lang='ar'] .hs-hero h2 { letter-spacing: 0; line-height: 1.3; }
.hs-hero p { margin: 0; max-inline-size: 48ch; color: var(--nzc-muted); font-size: 16px; line-height: 1.65; }
.hs-hero-art { position: relative; display: grid; place-items: center; }
.hs-hero-art .nzc-art-render { max-inline-size: 230px; filter: drop-shadow(0 24px 40px #00000040); }
.hs-body { display: grid; gap: 22px; scroll-margin-block-start: 20px; }
.hs-types { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.hs-type { display: flex; align-items: center; gap: 12px; padding: 16px 18px; border: 1px solid var(--nzc-border); border-radius: 18px; background: var(--nzc-card); color: var(--nzc-muted); font: inherit; font-size: 16px; font-weight: 650; text-align: start; cursor: pointer; transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease, color 0.15s ease; }
.hs-type:hover { transform: translateY(-2px); color: var(--nzc-fg); border-color: color-mix(in srgb, var(--nzc-accent) 40%, var(--nzc-border)); }
.hs-type:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }
.hs-type[aria-selected='true'] { border-color: var(--nzc-accent); background: color-mix(in srgb, var(--nzc-accent) 13%, var(--nzc-card)); color: var(--nzc-fg); box-shadow: 0 12px 32px color-mix(in srgb, var(--nzc-accent) 14%, transparent); }
.hs-type-icon { display: grid; place-items: center; flex: none; inline-size: 40px; block-size: 40px; border-radius: 12px; background: color-mix(in srgb, var(--nzc-accent) 14%, var(--nzc-field)); color: var(--nzc-accent); }
.hs-type[aria-selected='true'] .hs-type-icon { background: var(--nzc-accent); color: var(--nzc-on-accent); }
.hs-tag { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; margin: 0 0 18px; }
.hs-tag strong { font-size: 22px; letter-spacing: -0.01em; }
.hs-tag span { color: var(--nzc-muted); font-size: 15px; }
.hs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 18px; align-items: stretch; }
.hs-plan { position: relative; display: grid; grid-template-rows: auto auto 1fr auto auto; gap: 16px; padding: 24px; border: 1px solid var(--nzc-border); border-radius: 22px; background: var(--nzc-card); transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease; }
.hs-plan:hover { transform: translateY(-4px); border-color: color-mix(in srgb, var(--nzc-accent) 55%, var(--nzc-border)); box-shadow: 0 20px 50px #00000034; }
.hs-plan-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.hs-plan h3 { margin: 0; font-size: 20px; font-weight: 750; }
.hs-plan-mark { display: grid; place-items: center; inline-size: 40px; block-size: 40px; border-radius: 12px; background: color-mix(in srgb, var(--nzc-accent) 14%, var(--nzc-field)); color: var(--nzc-accent); }
.hs-price { margin: 0; min-block-size: 46px; display: flex; align-items: center; padding-block-end: 16px; border-block-end: 1px solid var(--nzc-border); }
.hs-price strong { font-size: 34px; line-height: 1.05; letter-spacing: -0.02em; }
.hs-specs { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; align-content: start; font-size: 14.5px; }
.hs-specs li { display: flex; gap: 10px; align-items: flex-start; }
.hs-specs .nzc-icon { color: var(--nzc-accent); flex: none; margin-block-start: 3px; }
.hs-runtimes { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12.5px; }
.hs-chip { padding: 3px 10px; border-radius: 999px; background: var(--nzc-field); border: 1px solid var(--nzc-border); font-size: 12px; }
.hs-choose .nz-btn { inline-size: 100%; min-block-size: 46px; border-radius: 14px; font-weight: 700; }
@media (max-width: 860px) { .hs-hero { grid-template-columns: minmax(0, 1fr); padding: 30px 22px; } .hs-hero-art { display: none; } }
@media (prefers-reduced-motion: reduce) { .hs-type, .hs-plan { transition: none; } .hs-type:hover, .hs-plan:hover { transform: none; } }

/* "Being built" scenes of the other project types (the website's is the page wireframe above): a web app's three layers with data packets between them, and a Flutter phone assembled beside its widget tree. */
.ascene { background: radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--nzc-accent) 14%, transparent), transparent 62%), radial-gradient(circle, color-mix(in srgb, var(--nzc-accent) 22%, transparent) 1px, transparent 1.6px) 0 0 / 22px 22px, var(--nzc-field); }
.ascene-board { inline-size: min(640px, 100%); display: grid; }
.ascene-layer { padding: 14px 16px 16px; border: 1px solid var(--nzc-border); border-radius: 16px; background: var(--nzc-card); box-shadow: 0 14px 40px #00000030; }
.ascene-layer h4 { margin: 0 0 10px; color: var(--nzc-accent); font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase; }
html[lang='ar'] .ascene-layer h4 { letter-spacing: 0; text-transform: none; font-size: 13px; }
.ascene-ui-body { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 12px; }
.ascene-ui .side { block-size: 104px; border-radius: 10px; }
.ascene-ui .main { display: grid; gap: 10px; align-content: start; }
.ascene-ui .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.ascene-ui .kpis i { block-size: 40px; border-radius: 10px; }
.ascene-ui .rows { display: grid; gap: 7px; }
.ascene-ui .rows i { block-size: 10px; }
.ascene-ui .rows i:nth-child(2) { inline-size: 86%; }
.ascene-ui .rows i:nth-child(3) { inline-size: 64%; }
.ascene-api ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 14px; }
.ascene-api li { display: flex; align-items: center; gap: 8px; }
.ascene-api em { font-style: normal; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 6px; background: color-mix(in srgb, var(--nzc-accent) 18%, transparent); color: var(--nzc-accent); }
.ascene-api li i { flex: 1; block-size: 9px; }
.ascene-db .tables { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.ascene-db .table { display: grid; gap: 7px; padding: 10px; border-radius: 10px; border: 1px solid var(--nzc-border); background: var(--nzc-field); }
.ascene-db .table b { display: block; block-size: 9px; inline-size: 55%; border-radius: 5px; background: var(--nzc-accent); opacity: 0.75; }
.ascene-db .table i { block-size: 7px; }
.ascene-db .table i:nth-child(3) { inline-size: 80%; }
.ascene-link { position: relative; block-size: 38px; display: flex; justify-content: center; gap: 22%; }
.ascene-link b { position: relative; inline-size: 2px; block-size: 100%; border-radius: 2px; background: color-mix(in srgb, var(--nzc-accent) 35%, transparent); }
.ascene-link b::after { content: ''; position: absolute; inset-inline-start: 50%; translate: -50% 0; inline-size: 8px; block-size: 8px; border-radius: 50%; background: var(--nzc-accent); box-shadow: 0 0 12px var(--nzc-accent); animation: ascene-packet 1.7s linear infinite; }
.ascene-link b:nth-child(2)::after { animation-delay: 0.55s; }
.ascene-link b:nth-child(3)::after { animation-delay: 1.1s; }
@keyframes ascene-packet { 0% { inset-block-start: 100%; opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { inset-block-start: -4px; opacity: 0; } }
.mscene-stage { display: flex; align-items: center; justify-content: center; gap: clamp(24px, 6vw, 72px); max-block-size: 100%; }
.mscene-tree { display: grid; gap: 10px; min-inline-size: 190px; }
.mscene-chip { justify-self: start; padding: 4px 12px; border-radius: 999px; background: color-mix(in srgb, var(--nzc-accent) 16%, transparent); color: var(--nzc-accent); font-size: 12px; font-weight: 700; }
.mscene-tree ul { list-style: none; margin: 0; padding: 14px 16px; display: grid; gap: 9px; border: 1px solid var(--nzc-border); border-radius: 16px; background: var(--nzc-card); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.mscene-tree li { padding-inline-start: calc(var(--d, 0) * 18px); }
.mscene-tree code { font: inherit; }
.mscene-tree code::before { content: ''; display: inline-block; inline-size: 6px; block-size: 6px; margin-inline-end: 8px; border-radius: 50%; background: var(--nzc-accent); }
.mscene-phone { position: relative; block-size: min(470px, calc(100vh - 250px)); min-block-size: 300px; aspect-ratio: 9 / 19; border: 8px solid var(--nzc-card-hi); border-radius: 34px; background: var(--nzc-card); box-shadow: 0 30px 80px #0000004d, 0 0 0 1px var(--nzc-border); overflow: hidden; }
.mscene-phone .notch { position: absolute; inset-block-start: 0; inset-inline: 0; margin-inline: auto; inline-size: 72px; block-size: 18px; border-radius: 0 0 14px 14px; background: var(--nzc-card-hi); }
.mscene-phone .screen { box-sizing: border-box; block-size: 100%; padding: 24px 12px 12px; display: grid; gap: 10px; align-content: start; }
.mscene-phone .status { display: flex; justify-content: space-between; }
.mscene-phone .status i { inline-size: 26px; block-size: 6px; border-radius: 3px; }
.mscene-phone .appbar { display: flex; align-items: center; gap: 8px; padding: 4px 2px; }
.mscene-phone .appbar i { inline-size: 18px; block-size: 18px; border-radius: 6px; }
.mscene-phone .appbar b { display: block; flex: 1; block-size: 10px; border-radius: 5px; background: var(--nzc-accent); opacity: 0.75; }
.mscene-phone .banner { block-size: 96px; }
.mscene-phone .banner i { block-size: 100%; border-radius: 16px; }
.mscene-phone .list { display: grid; gap: 8px; }
.mscene-phone .row { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 12px; background: var(--nzc-card-hi); }
.mscene-phone .avatar { flex: none; inline-size: 32px; block-size: 32px; border-radius: 50%; background: var(--nzc-border); }
.mscene-phone .lines { display: grid; gap: 6px; flex: 1; }
.mscene-phone .lines i { block-size: 8px; }
.mscene-phone .lines i:last-child { inline-size: 60%; }
.mscene-phone .tabbar { position: absolute; inset-inline: 10px; inset-block-end: 12px; display: flex; justify-content: space-around; padding: 10px; border-radius: 16px; background: var(--nzc-card-hi); }
.mscene-phone .tabbar i { inline-size: 22px; block-size: 22px; border-radius: 7px; }
.mscene-phone .tabbar i.on { background: var(--nzc-accent); }
@media (max-width: 900px) { .mscene-tree { display: none; } }
@media (prefers-reduced-motion: reduce) { .ascene-link b::after { animation: none; opacity: 1; inset-block-start: 40%; } }

/* Landing-style heroes (domain search, mailbox creation): the same look as the AI builder landing, inside the console. */
.ld-hero { position: relative; overflow: hidden; box-sizing: border-box; display: grid; place-items: center; min-block-size: min(640px, calc(100vh - 220px)); padding: clamp(28px, 5vw, 64px) clamp(18px, 4vw, 48px); border: 1px solid var(--nzc-border); border-radius: 28px; background: var(--nzc-card); margin-block-end: 24px; }
.ld-hero[data-compact='true'] { min-block-size: 0; padding-block: 34px; }
.ld-hero[data-size='md'] { min-block-size: 0; padding-block: clamp(34px, 4vw, 52px); }
.ld-purposes { grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
.ld-purposes .ld-tld-name { font-size: 17px; }
.ld-go { text-decoration: none; }
.nzc a.ld-go, .nzc a.ld-go:hover { color: var(--nzc-orange-ink); }
.ld-glow { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse 60% 50% at 12% 0%, color-mix(in srgb, var(--nzc-accent) 22%, transparent), transparent 70%), radial-gradient(ellipse 50% 45% at 92% 30%, color-mix(in srgb, var(--nzc-accent) 13%, transparent), transparent 70%), radial-gradient(ellipse 70% 50% at 50% 115%, color-mix(in srgb, var(--nzc-accent) 11%, transparent), transparent 70%); }
.ld-art { position: absolute; inset-inline-end: 4%; inset-block-end: 6%; inline-size: 190px; opacity: 0.9; pointer-events: none; filter: drop-shadow(0 22px 36px #00000040); }
.ld-hero[data-compact='true'] .ld-art { display: none; }
.ld-inner { position: relative; inline-size: min(100%, 820px); display: grid; gap: 18px; justify-items: center; text-align: center; }
.ld-brand { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border: 1px solid var(--nzc-border); border-radius: 999px; background: color-mix(in srgb, var(--nzc-card) 80%, transparent); color: var(--nzc-muted); font-size: 13px; font-weight: 600; }
.ld-title { margin: 0; max-inline-size: 18ch; font-size: clamp(30px, 4.6vw, 56px); line-height: 1.08; letter-spacing: -0.025em; font-weight: 800; text-wrap: balance; }
html[lang='ar'] .ld-title { letter-spacing: 0; line-height: 1.3; max-inline-size: 22ch; }
.ld-hero[data-compact='true'] .ld-title { font-size: clamp(26px, 3.4vw, 38px); }
.ld-sub { margin: 0; max-inline-size: 56ch; color: var(--nzc-muted); font-size: clamp(15px, 1.5vw, 17px); line-height: 1.65; }
.ld-hero[data-compact='true'] .ld-sub { display: none; }
.ld-card { inline-size: 100%; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--nzc-accent) 34%, var(--nzc-border)); border-radius: 26px; background: var(--nzc-field); box-shadow: 0 24px 70px color-mix(in srgb, var(--nzc-accent) 14%, transparent), 0 2px 6px #0000001f; transition: box-shadow 0.2s ease, border-color 0.2s ease; }
.ld-card:focus-within { border-color: var(--nzc-accent); box-shadow: 0 24px 80px color-mix(in srgb, var(--nzc-accent) 24%, transparent), 0 0 0 3px color-mix(in srgb, var(--nzc-accent) 22%, transparent); }
.ld-search { display: flex; align-items: center; gap: 12px; padding-block: 10px; padding-inline: 22px 10px; color: var(--nzc-muted); }
.ld-search-input { flex: 1; min-inline-size: 0; border: 0; background: transparent; color: var(--nzc-fg); font: inherit; font-size: clamp(17px, 2vw, 22px); padding-block: 14px; outline: none; }
.ld-search-input::placeholder { color: var(--nzc-muted); }
.nzc .ld-search-input, .nzc .ld-search-input:focus, .nzc .ld-search-input:hover { border: 0 !important; background: transparent !important; box-shadow: none !important; min-block-size: 0 !important; font-size: clamp(17px, 2vw, 22px) !important; padding-inline: 0 !important; }
.nzc .ld-local, .nzc .ld-domain { font-size: 18px !important; min-block-size: 56px !important; border-radius: 16px !important; background-color: var(--nzc-card) !important; }
.nzc .ld-custom input { min-block-size: 0 !important; font-size: 14px !important; padding-inline: 12px !important; border-radius: 12px !important; }
.ld-go { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-inline-size: 124px; padding: 14px 24px; border: 0; border-radius: 18px; background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); font: inherit; font-weight: 700; cursor: pointer; transition: transform 0.15s ease, opacity 0.15s ease; }
.ld-go:hover:not(:disabled) { transform: translateY(-1px); }
.ld-go:disabled { opacity: 0.55; cursor: not-allowed; }
.ld-label { margin: 0 0 10px; color: var(--nzc-muted); font-size: 12.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
html[lang='ar'] .ld-label { letter-spacing: 0; text-transform: none; font-size: 13.5px; }
.ld-tlds { inline-size: 100%; }
.ld-tlds .ld-label { text-align: center; }
.ld-tlds-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.ld-tld { position: relative; display: grid; gap: 3px; padding: 14px 16px; border: 1px solid var(--nzc-border); border-radius: 18px; background: color-mix(in srgb, var(--nzc-card) 78%, transparent); text-align: start; cursor: pointer; transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease; }
.ld-tld:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--nzc-accent) 45%, var(--nzc-border)); }
.ld-tld input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.ld-tld:has(input:focus-visible) { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }
.ld-tld:has(input:checked) { border-color: var(--nzc-accent); background: color-mix(in srgb, var(--nzc-accent) 13%, var(--nzc-card)); box-shadow: 0 10px 28px color-mix(in srgb, var(--nzc-accent) 15%, transparent); }
.ld-tld-name { font-size: 20px; font-weight: 750; }
.ld-tld-hint { color: var(--nzc-muted); font-size: 12px; }
.ld-note { margin: 0; color: var(--nzc-muted); font-size: 13px; line-height: 1.6; max-inline-size: 60ch; }
.ld-results .nzc-dres-best { border-radius: 24px; border-color: color-mix(in srgb, var(--nzc-accent) 40%, var(--nzc-border)); box-shadow: 0 18px 50px color-mix(in srgb, var(--nzc-accent) 12%, transparent); }
.ld-results .nzc-dres-list { border-radius: 22px; }
.ld-results .nzc-dres-list li { transition: background 0.15s ease; }
.ld-results .nzc-dres-list li:hover { background: color-mix(in srgb, var(--nzc-accent) 7%, transparent); }
.ld-mail { display: grid; gap: 16px; padding: 22px; text-align: start; }
.ld-addr { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.ld-fieldwrap { display: grid; gap: 6px; flex: 1 1 200px; min-inline-size: 0; }
.ld-fieldwrap label { color: var(--nzc-muted); font-size: 12.5px; font-weight: 600; }
.ld-local, .ld-domain { inline-size: 100%; box-sizing: border-box; padding: 15px 18px; border: 1px solid var(--nzc-border); border-radius: 16px; background: var(--nzc-card); color: var(--nzc-fg); font: inherit; font-size: 18px; outline: none; }
.ld-local:focus, .ld-domain:focus { border-color: var(--nzc-accent); }
.ld-at { padding-block-end: 14px; color: var(--nzc-accent); font-size: 26px; font-weight: 700; line-height: 1; }
.ld-preview { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0; padding: 10px 14px; border-radius: 14px; background: color-mix(in srgb, var(--nzc-accent) 11%, transparent); color: var(--nzc-accent); }
.ld-preview bdi { color: var(--nzc-fg); font-weight: 700; font-size: 16px; overflow-wrap: anywhere; }
.ld-quota .ld-label { margin-block-end: 8px; }
.ld-presets { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ld-preset { padding: 10px 18px; border: 1px solid var(--nzc-border); border-radius: 999px; background: var(--nzc-card); color: var(--nzc-muted); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease; }
.ld-preset:hover { color: var(--nzc-fg); border-color: color-mix(in srgb, var(--nzc-accent) 45%, var(--nzc-border)); }
.ld-preset[aria-pressed='true'] { border-color: var(--nzc-accent); background: var(--nzc-accent); color: var(--nzc-on-accent); }
.ld-custom { display: inline-flex; align-items: center; gap: 8px; margin-inline-start: auto; color: var(--nzc-muted); font-size: 13px; }
.ld-custom input { inline-size: 110px; padding: 9px 12px; border: 1px solid var(--nzc-border); border-radius: 12px; background: var(--nzc-card); color: var(--nzc-fg); font: inherit; }
.ld-mail .ld-go { justify-self: stretch; padding-block: 16px; font-size: 16px; }
.ld-mail .ld-note { max-inline-size: none; }
@media (max-width: 760px) { .ld-art { display: none; } .ld-search { flex-wrap: wrap; padding: 12px; } .ld-search .nzc-icon { display: none; } .ld-search-input { flex-basis: 100%; padding-inline: 8px; } .ld-go { inline-size: 100%; } .ld-at { display: none; } .ld-custom { margin-inline-start: 0; inline-size: 100%; justify-content: space-between; } }
@media (prefers-reduced-motion: reduce) { .ld-tld, .ld-go, .ld-preset, .ld-card { transition: none; } .ld-tld:hover { transform: none; } }

/* Support: a chat-style panel docked beside the dashboard, on the system background (not inside the dashboard's own frame). Opening it narrows the dashboard (the frame keeps its small side margin as the gap) instead of covering it. */
.nzc-main { flex: 1; min-block-size: 0; display: flex; }
.nzc-main > .nzc-frame { flex: 1; min-inline-size: 0; }
.nzc-support { flex: none; inline-size: min(360px, 34vw); display: flex; flex-direction: column; min-block-size: 0; margin-inline: 0 6px; border: 1px solid var(--nzc-border); border-block-end: 0; border-radius: 22px 22px 0 0; background: var(--nzc-card); box-shadow: none; overflow: hidden; animation: nzc-support-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both; }
.nzc-support[hidden] { display: none; }
@keyframes nzc-support-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
html[dir='rtl'] .nzc-support { animation-name: nzc-support-in-rtl; }
@keyframes nzc-support-in-rtl { from { opacity: 0; transform: translateX(-16px); } to { opacity: 1; transform: none; } }
.nzc-support-btn[aria-expanded='true'] { background: var(--nzc-elev); color: var(--nzc-accent); }
.sup { display: flex; flex-direction: column; min-block-size: 0; block-size: 100%; }
.sup-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-block-end: 1px solid var(--nzc-border); background: color-mix(in srgb, var(--nzc-accent) 7%, var(--nzc-card)); }
.sup-avatar, .sup-msg-avatar { display: grid; place-items: center; flex: none; inline-size: 38px; block-size: 38px; border-radius: 12px; background: var(--nzc-field); border: 1px solid var(--nzc-border); }
.sup-avatar .nzc-logo, .sup-msg-avatar .nzc-logo { block-size: 16px; inline-size: auto; }
.sup-msg-avatar { inline-size: 30px; block-size: 30px; border-radius: 10px; }
.sup-title { display: grid; flex: 1; min-inline-size: 0; }
.sup-title strong { font-size: 15px; }
.sup-title small { color: var(--nzc-muted); font-size: 12.5px; }
.sup-close { display: grid; place-items: center; inline-size: 34px; block-size: 34px; border: 0; border-radius: 10px; background: transparent; color: var(--nzc-muted); cursor: pointer; }
.sup-close:hover { background: var(--nzc-elev); color: var(--nzc-fg); }
.sup-thread { flex: 1; min-block-size: 0; overflow-y: auto; display: grid; align-content: start; gap: 16px; padding: 16px; }
.sup-msg { display: flex; align-items: flex-start; gap: 10px; }
.sup-msg p { margin: 0; max-inline-size: 85%; padding: 11px 14px; border-radius: 4px 16px 16px 16px; background: var(--nzc-field); border: 1px solid var(--nzc-border); font-size: 14px; line-height: 1.6; }
html[dir='rtl'] .sup-msg p { border-radius: 16px 4px 16px 16px; }
.sup-label { margin: 0 0 8px; color: var(--nzc-muted); font-size: 12px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
html[lang='ar'] .sup-label { letter-spacing: 0; text-transform: none; font-size: 13px; }
.sup-topics ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.sup-topics a { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--nzc-border); border-radius: 12px; background: var(--nzc-card); color: var(--nzc-fg); font-size: 14px; font-weight: 550; text-decoration: none; transition: border-color 0.15s ease, background 0.15s ease; }
.sup-topics a > .nzc-icon:last-child { margin-inline-start: auto; color: var(--nzc-muted); }
.sup-topics a:hover { border-color: color-mix(in srgb, var(--nzc-accent) 50%, var(--nzc-border)); background: color-mix(in srgb, var(--nzc-accent) 8%, var(--nzc-card)); }
html[dir='rtl'] .sup-topics a > .nzc-icon:last-child { transform: scaleX(-1); }
.sup-topic-icon { display: grid; place-items: center; inline-size: 30px; block-size: 30px; border-radius: 9px; background: color-mix(in srgb, var(--nzc-accent) 14%, var(--nzc-field)); color: var(--nzc-accent); }
.sup-composer { padding: 12px 14px 14px; border-block-start: 1px solid var(--nzc-border); display: grid; gap: 8px; }
.sup-composer-box { display: flex; align-items: flex-end; gap: 8px; padding: 8px; border: 1px solid var(--nzc-border); border-radius: 14px; background: var(--nzc-field); }
.sup-composer-box:focus-within { border-color: var(--nzc-accent); }
.nzc .sup-composer textarea { flex: 1; min-inline-size: 0; min-block-size: 0 !important; border: 0 !important; background: transparent !important; box-shadow: none !important; resize: none; padding: 6px 8px !important; font-size: 14px !important; color: var(--nzc-fg); }
.sup-composer button { display: grid; place-items: center; flex: none; inline-size: 36px; block-size: 36px; border: 0; border-radius: 10px; background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); cursor: pointer; }
.sup-composer button:disabled { opacity: 0.45; cursor: not-allowed; }
.sup-mine { justify-self: end; display: grid; gap: 4px; max-inline-size: 88%; }
.sup-mine p { margin: 0; padding: 10px 14px; border-radius: 16px 4px 16px 16px; background: color-mix(in srgb, var(--nzc-accent) 18%, var(--nzc-card)); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; white-space: pre-wrap; }
html[dir='rtl'] .sup-mine p { border-radius: 4px 16px 16px 16px; }
.sup-mine small { color: var(--nzc-muted); font-size: 12px; justify-self: end; }
.nzc-support, .nzc-support * { box-shadow: none !important; }
.sup-note { margin: 0; color: var(--nzc-muted); font-size: 12.5px; line-height: 1.5; }
@media (max-width: 900px) { .nzc-support { position: fixed; inset-block: var(--top-h) 0; inset-inline-end: 0; inline-size: min(380px, 100vw); margin: 0; border-radius: 0; border-inline-end: 0; z-index: 70; box-shadow: var(--nzc-shadow); } }
.nzc-app:has(:is(.bws, .bfs-float)) .nzc-support { display: none; }
@media (prefers-reduced-motion: reduce) { .nzc-support { animation: none; } }

/* Compact dashboard carousel and staggered service shortcuts. */
.nzc-dashboard { gap:16px; }
.nzc-home-welcome { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.nzc-home-welcome h1 { margin:0; font-size:18px; font-weight:600; }
.nzc-home-welcome > span { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--nzc-muted); }
.nzc-home-slider { position:relative; display:grid; grid-template-columns:1.1fr 1fr; align-items:center; min-block-size:210px; overflow:hidden; border:1px solid var(--nzc-border); border-radius:16px; background:linear-gradient(110deg,var(--nzc-card),var(--nzc-accent-soft)); }
.nzc-slide-copy { padding:24px 28px 40px; }
.nzc-slide-kicker { color:var(--nzc-accent); font-size:9px; letter-spacing:.12em; font-weight:600; }
.nzc-slide-copy h2 { margin:9px 0 8px; font-size:clamp(20px,2vw,27px); line-height:1.3; letter-spacing:-.02em; }
.nzc-slide-copy p { color:var(--nzc-muted); font-size:12px; margin:0 0 14px; line-height:1.6; }
.nzc-slide-link { display:inline-flex; gap:12px; align-items:center; color:var(--nzc-accent) !important; font-size:12px; font-weight:600; text-decoration:none !important; }
.nzc-slide-art { inline-size:100%; block-size:190px; object-fit:contain; padding-inline:12px; }
.nzc-slide-controls { position:absolute; inset-inline-start:24px; inset-block-end:10px; display:flex; align-items:center; gap:10px; }
.nzc-slide-controls > button { display:grid; place-items:center; inline-size:28px; block-size:28px; padding:0; border:1px solid var(--nzc-border); border-radius:7px; background:var(--nzc-card); color:var(--nzc-fg); cursor:pointer; font-size:19px; }
.nzc-slide-tabs { display:flex; gap:3px; }
.nzc-slide-tabs button { position:relative; padding:0; inline-size:24px; block-size:24px; border:0; background:transparent; cursor:pointer; }
.nzc-slide-tabs button::after { content:''; position:absolute; inset-inline:3px; inset-block-start:10px; block-size:3px; border-radius:2px; background:var(--nzc-border); }
.nzc-slide-tabs button[aria-pressed='true']::after { background:var(--nzc-accent); }
.nzc-home-products { display:grid; grid-template-columns:1.15fr .85fr 1fr; align-items:start; gap:14px; list-style:none; padding:0; margin:0; }
.nzc-home-products > li:nth-child(2) { margin-block-start:12px; }
.nzc-home-products > li:nth-child(3) { margin-block-start:5px; }
.nzc-home-product { display:block; border:1px solid var(--nzc-border); border-radius:13px; background:var(--nzc-card); color:var(--nzc-fg) !important; text-decoration:none !important; transition:border-color .2s; }
.nzc-home-products > li[data-service='compute'] .nzc-home-product { background:color-mix(in srgb,var(--nzc-accent-soft) 45%,var(--nzc-card)); }
.nzc-home-products > li[data-service='domains'] .nzc-home-product { border-style:dashed; }
.nzc-home-product:hover { border-color:var(--nzc-accent); }
.nzc-home-product-body { padding:16px 18px; }
.nzc-home-product-heading { display:flex; align-items:center; gap:9px; }
.nzc-home-product-heading strong { font-size:14px; font-weight:600; }
.nzc-home-product-heading > .nzc-icon { color:var(--nzc-accent); inline-size:17px; }
.nzc-home-product-heading > .nzc-icon:last-child { margin-inline-start:auto; inline-size:14px; }
.nzc-home-product-body p { color:var(--nzc-muted); margin:9px 0; font-size:11px; line-height:1.5; }
.nzc-home-product-link { color:var(--nzc-accent); font-size:10px; font-weight:600; }
.nzc-dashboard .nzc-stat { padding:14px 16px; gap:8px; border-radius:13px; }
.nzc-dashboard .nzc-stat-value { font-size:24px; }
.nzc-dashboard .nzc-stat-label { font-size:12px; }
.nzc-dashboard .nzc-stat-sub { font-size:11px; }
.nzc-dashboard .nzc-split > .nz-card { padding:16px; border-radius:13px; }
.nzc-dashboard .nzc-cardhead { margin-block-end:10px; }
.nzc-dashboard .nzc-cardhead h2 { font-size:14px; }
.nzc-dashboard-empty { min-block-size:150px; gap:10px; }
.nzc-dashboard .nzc-list li { padding-block:9px; }
.nzc-slide-controls button:focus-visible,.nzc-slide-link:focus-visible,.nzc-home-product:focus-visible { outline:2px solid var(--nzc-accent); outline-offset:3px; }
@media(max-width:700px) { .nzc-home-slider { grid-template-columns:1fr; } .nzc-slide-copy { padding:20px 20px 48px; } .nzc-slide-art { display:none; } .nzc-home-products { grid-template-columns:1fr; gap:10px; } .nzc-home-products > li:nth-child(n) { margin:0; } .nzc-home-welcome { flex-wrap:wrap; } }
@media(prefers-reduced-motion:reduce) { .nzc-home-product { transition:none; } }

/* Brand-colour bento workspace: rounded controls and contrasting service surfaces. */
.nzc-home-slider { min-block-size:160px; border-radius:20px; }
.nzc-slide-copy { padding:18px 24px 38px; }
.nzc-slide-copy h2 { font-size:23px; margin-block:7px; }
.nzc-slide-copy p { margin-block-end:10px; }
.nzc-slide-art { block-size:150px; }
.nzc-home-bento { display:grid; grid-template-columns:1.1fr 1fr 1fr; grid-auto-rows:minmax(145px,auto); gap:14px; }
.nzc-home-overview { grid-row:span 2; display:flex; flex-direction:column; justify-content:space-between; min-inline-size:0; padding:22px; border-radius:24px; background:linear-gradient(155deg,#202d33,#34434d 60%,#587079); color:#f1f7f3; }
.nzc-home-overview-head { display:flex; justify-content:space-between; align-items:center; gap:12px; }
.nzc-home-overview-head h2 { margin:0; font-size:14px; font-weight:500; }
.nzc-home-overview-head > .nzc-icon { padding:9px; box-sizing:content-box; border-radius:50%; background:#ffffff12; }
.nzc-home-orbit { position:relative; display:grid; place-items:center; inline-size:188px; block-size:188px; margin:16px auto; border-radius:50%; background:conic-gradient(from -70deg,#bcdccb 0deg 95deg,transparent 95deg 104deg,#93b6b3 104deg 195deg,transparent 195deg 204deg,#cfe8da 204deg 275deg,transparent 275deg 284deg,#658e90 284deg 350deg,transparent 350deg); }
.nzc-home-orbit::before { content:''; position:absolute; inset:19px; border-radius:50%; background:#30414a; }
.nzc-home-orbit > div { position:relative; display:grid; gap:5px; text-align:center; }
.nzc-home-orbit span { font-size:11px; color:#bfd0cf; }
.nzc-home-orbit strong { font-size:44px; line-height:1.1; font-weight:500; }
.nzc-home-overview-foot { display:flex; flex-wrap:wrap; gap:10px; justify-content:space-between; font-size:10px; color:#d2e4dc; }
.nzc-home-overview-foot span { display:flex; align-items:center; gap:6px; }
.nzc-home-overview-foot i { inline-size:6px; block-size:6px; background:#bcdccb; border-radius:50%; }
.nzc-home-service { display:flex; flex-direction:column; justify-content:space-between; gap:12px; min-inline-size:0; padding:17px 19px; border-radius:24px; background:var(--nzc-card); color:var(--nzc-fg) !important; text-decoration:none !important; border:1px solid var(--nzc-border); transition:box-shadow .2s; }
.nzc-home-service[data-service='hosting'] { background:#d9e9e0; color:#203f35 !important; border-color:#ccdfd2; }
.nzc-home-service[data-service='compute'] { background:#587079; color:#fff !important; border-color:#587079; }
.nzc-home-service[data-service='domains'] { background:#edf2ed; color:#203f35 !important; border-color:#dce6df; }
.nzc-home-service-top { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.nzc-home-service-symbol { display:grid; place-items:center; inline-size:33px; block-size:33px; border-radius:50%; background:#ffffff50; }
.nzc-home-service[data-service='compute'] .nzc-home-service-symbol { background:#ffffff18; }
.nzc-home-service h2 { margin:0 0 4px; font-size:16px; font-weight:600; }
.nzc-home-service p { margin:0; opacity:.78; font-size:11px; line-height:1.5; max-inline-size:32ch; }
.nzc-home-service-bottom { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:10px; }
.nzc-home-service-open { display:grid; place-items:center; inline-size:29px; block-size:29px; border-radius:50%; background:#ffffff65; color:#285348; }
.nzc-home-service[data-service='domains'] .nzc-home-service-bottom > span:first-child { font-size:19px; letter-spacing:-.04em; font-weight:500; }
.nzc-home-build { display:flex; align-items:center; justify-content:space-between; gap:15px; padding:19px; border-radius:24px; background:var(--nzc-card); border:1px solid var(--nzc-border); color:var(--nzc-fg) !important; text-decoration:none !important; }
.nzc-home-build > div > span { color:var(--nzc-muted); font-size:9px; letter-spacing:.06em; }
.nzc-home-build h2 { margin:9px 0 0; font-size:19px; font-weight:500; line-height:1.3; max-inline-size:16ch; }
.nzc-home-build .nzc-home-service-open { inline-size:42px; block-size:42px; flex-shrink:0; background:var(--nzc-accent-soft); color:var(--nzc-accent); }
.nzc-home-service:hover,.nzc-home-build:hover { box-shadow:0 6px 18px #00000012; }
.nzc-home-service:focus-visible,.nzc-home-build:focus-visible { outline:2px solid var(--nzc-accent); outline-offset:3px; }
.nzc-home-bento .nzc-icon { flex-shrink:0; }
.nzc-dashboard .nzc-stat { border-radius:20px; }
.nzc-dashboard .nzc-split > .nz-card { border-radius:20px; }
@media(max-width:900px) { .nzc-home-bento { grid-template-columns:1fr 1fr; } .nzc-home-overview { grid-row:span 2; } }
@media(max-width:560px) { .nzc-home-bento { grid-template-columns:1fr; grid-auto-rows:auto; } .nzc-home-overview { grid-row:auto; } .nzc-home-orbit { inline-size:150px; block-size:150px; } .nzc-home-service { gap:14px; } .nzc-slide-copy h2 { font-size:20px; } }
@media(prefers-reduced-motion:reduce) { .nzc-home-service { transition:none; } }

/* Translucent brand layers: keep text opaque while tinting the surfaces. */
.nzc-home-slider { isolation:isolate; background:linear-gradient(115deg,var(--nzc-card) 15%,color-mix(in srgb,var(--nzc-card) 70%,#93b6b3) 100%); border-color:color-mix(in srgb,var(--nzc-accent) 24%,var(--nzc-border)); box-shadow:inset 0 1px 0 #ffffff14; }
.nzc-home-slider::before { content:''; position:absolute; z-index:-1; inset:0; background:radial-gradient(ellipse at 75% 25%,#bcdccb30,transparent 55%),radial-gradient(ellipse at 100% 100%,#58707924,transparent 60%); pointer-events:none; }
.nzc-slide-link { padding:7px 11px; border-radius:9px; background:color-mix(in srgb,var(--nzc-accent) 10%,transparent); border:1px solid color-mix(in srgb,var(--nzc-accent) 16%,transparent); transition:background .2s; }
.nzc-slide-link:hover { background:color-mix(in srgb,var(--nzc-accent) 18%,transparent); }
.nzc-slide-scene { position:relative; display:grid; place-items:center; block-size:166px; inline-size:min(100%,330px); justify-self:center; color:var(--nzc-accent); }
.nzc-slide-orbit { position:absolute; border:1px solid color-mix(in srgb,var(--nzc-accent) 17%,transparent); border-radius:50%; inline-size:228px; block-size:132px; transform:rotate(-18deg); }
.nzc-slide-orbit-inner { inline-size:174px; block-size:102px; transform:rotate(24deg); border-color:color-mix(in srgb,var(--nzc-accent) 12%,transparent); }
.nzc-slide-icon-main { position:relative; display:grid; place-items:center; inline-size:96px; block-size:96px; border-radius:27px; background:linear-gradient(145deg,color-mix(in srgb,var(--nzc-card) 82%,#cfe8da),color-mix(in srgb,var(--nzc-card) 48%,#93b6b3)); border:1px solid color-mix(in srgb,var(--nzc-accent) 32%,transparent); box-shadow:inset 0 1px 0 #ffffff65,0 12px 30px #34434d16; transform:rotate(-8deg); animation:nzc-slide-reveal .3s ease-out; }
.nzc-slide-icon-main > .nzc-icon { transform:rotate(8deg); }
.nzc-slide-icon-satellite { position:absolute; display:grid; place-items:center; inline-size:44px; block-size:44px; border-radius:15px; border:1px solid color-mix(in srgb,var(--nzc-accent) 22%,transparent); background:color-mix(in srgb,var(--nzc-card) 78%,transparent); box-shadow:0 5px 16px #34434d0b,inset 0 1px 0 #ffffff28; backdrop-filter:blur(8px); }
.nzc-slide-satellite-one { inset-inline-start:46px; inset-block-start:20px; transform:rotate(9deg); }
.nzc-slide-satellite-two { inset-inline-end:40px; inset-block-end:20px; transform:rotate(-9deg); }
.nzc-slide-satellite-three { inset-inline-end:62px; inset-block-start:15px; inline-size:32px; block-size:32px; border-radius:11px; opacity:.7; }
.nzc-slide-controls { gap:8px; }
.nzc-slide-controls > button { inline-size:28px; block-size:28px; border-radius:50%; background:color-mix(in srgb,var(--nzc-card) 55%,transparent); border-color:color-mix(in srgb,var(--nzc-accent) 20%,transparent); color:var(--nzc-accent); transition:background .2s; }
.nzc-slide-controls > button:hover { background:var(--nzc-accent-soft); }
.nzc-slide-controls > button:first-child .nzc-icon { transform:rotate(180deg); }
.nzc-slide-tabs button::after { inset-inline:8px; block-size:5px; border-radius:5px; background:color-mix(in srgb,var(--nzc-accent) 25%,transparent); transition:inset .2s,background .2s; }
.nzc-slide-tabs button[aria-pressed='true']::after { inset-inline:3px; }
.nzc-home-service[data-service] { position:relative; isolation:isolate; overflow:hidden; color:var(--nzc-fg) !important; border-color:color-mix(in srgb,var(--nzc-accent) 18%,var(--nzc-border)); background:linear-gradient(135deg,color-mix(in srgb,var(--nzc-card) 68%,#bcdccb),color-mix(in srgb,var(--nzc-card) 92%,#bcdccb)); box-shadow:inset 0 1px 0 #ffffff30; }
.nzc-home-service[data-service='compute'] { background:linear-gradient(130deg,color-mix(in srgb,var(--nzc-card) 75%,#587079),color-mix(in srgb,var(--nzc-card) 94%,#93b6b3)); }
.nzc-home-service[data-service='domains'] { background:linear-gradient(135deg,color-mix(in srgb,var(--nzc-card) 78%,#cfe8da),var(--nzc-card)); }
.nzc-home-service::before { content:''; position:absolute; z-index:-1; inline-size:155px; block-size:155px; inset-inline-end:-65px; inset-block-start:-75px; border-radius:50%; border:22px solid color-mix(in srgb,var(--nzc-accent) 6%,transparent); pointer-events:none; }
.nzc-home-service[data-service] .nzc-home-service-symbol { color:var(--nzc-accent); border:1px solid color-mix(in srgb,var(--nzc-accent) 15%,transparent); background:color-mix(in srgb,var(--nzc-card) 58%,transparent); box-shadow:inset 0 1px 0 #ffffff30; }
.nzc-home-service p { opacity:1; color:var(--nzc-muted); }
.nzc-home-service-open { background:color-mix(in srgb,var(--nzc-card) 62%,transparent); color:var(--nzc-accent); }
.nzc-home-build { background:linear-gradient(115deg,var(--nzc-card),color-mix(in srgb,var(--nzc-card) 93%,#93b6b3)); }
@keyframes nzc-slide-reveal { from { opacity:0; transform:translateY(5px) rotate(-8deg); } to { opacity:1; transform:translateY(0) rotate(-8deg); } }
@media(max-width:700px) { .nzc-slide-scene { display:none; } }
@media(prefers-reduced-motion:reduce) { .nzc-slide-icon-main { animation:none; } .nzc-slide-link,.nzc-slide-controls > button,.nzc-slide-tabs button::after { transition:none; } }

/* Art-directed photographic banners with a protected text area. */
.nzc-home-slider { display:block; min-block-size:205px; background:var(--nzc-card); }
.nzc-home-slider::before { display:none; }
.nzc-slide-copy { position:relative; z-index:1; inline-size:53%; min-block-size:205px; box-sizing:border-box; padding:22px 26px 48px; }
.nzc-slide-copy h2 { max-inline-size:25ch; text-wrap:balance; }
.nzc-slide-copy p { max-inline-size:38ch; }
.nzc-slide-photograph { position:absolute; inset-block:0; inset-inline-end:0; inline-size:66%; overflow:hidden; mask-image:linear-gradient(90deg,transparent,black 32%); }
.nzc-slide-photograph img { inline-size:100%; block-size:100%; object-fit:cover; object-position:65% 55%; animation:nzc-photo-enter .35s ease-out; }
.nzc-slide-photograph:dir(rtl) { mask-image:linear-gradient(270deg,transparent,black 32%); }
.nzc-slide-controls { z-index:2; inset-inline-start:26px; inset-block-end:12px; }
@keyframes nzc-photo-enter { from { opacity:.35; } to { opacity:1; } }
@media(max-width:700px) { .nzc-slide-copy { inline-size:70%; padding-inline:20px; } .nzc-slide-photograph { inline-size:72%; opacity:.55; mask-image:linear-gradient(90deg,transparent 10%,black 90%); } .nzc-slide-photograph:dir(rtl) { mask-image:linear-gradient(270deg,transparent 10%,black 90%); } }
@media(max-width:460px) { .nzc-slide-copy { inline-size:90%; } .nzc-slide-photograph { opacity:.22; } }
@media(prefers-reduced-motion:reduce) { .nzc-slide-photograph img { animation:none; } }

/* Service-led editorial graphics, built from crisp interface elements. */
.nzc-home-slider { display:grid; grid-template-columns:1fr 1fr; min-block-size:220px; background:linear-gradient(110deg,var(--nzc-card) 35%,color-mix(in srgb,var(--nzc-card) 90%,#93b6b3)); }
.nzc-slide-copy { inline-size:100%; min-block-size:220px; padding:24px 26px 48px; }
.nzc-slide-copy h2 { font-size:25px; letter-spacing:-.035em; }
.nzc-service-art { position:relative; block-size:220px; inline-size:100%; max-inline-size:430px; justify-self:center; color:var(--nzc-accent); isolation:isolate; font-family:inherit; direction:ltr; }
.nzc-service-art-grid { position:absolute; inset:12px 4px; z-index:-1; border-radius:50%; background:radial-gradient(ellipse,#93b6b320,transparent 67%); }
.nzc-art-window { position:absolute; inset-block-start:28px; inset-inline-start:48px; inline-size:270px; block-size:160px; border:1px solid color-mix(in srgb,var(--nzc-accent) 25%,transparent); border-radius:12px; background:var(--nzc-card); box-shadow:0 14px 35px #34434d14; transform:rotate(-4deg); overflow:hidden; }
.nzc-art-browser { display:flex; gap:26px; align-items:center; padding:8px 10px; border-block-end:1px solid var(--nzc-border); background:var(--nzc-accent-soft); font-size:8px; color:var(--nzc-muted); }
.nzc-art-browser > span { display:flex; align-items:center; gap:4px; }
.nzc-art-browser i { inline-size:4px; block-size:4px; background:var(--nzc-accent); opacity:.35; border-radius:50%; }
.nzc-art-webnav { display:flex; align-items:center; gap:10px; padding:11px 13px 0; }
.nzc-art-webnav > span { inline-size:17px; block-size:3px; border-radius:2px; background:var(--nzc-border); }
.nzc-art-webnav .nzc-art-wordmark { inline-size:25px; block-size:7px; background:var(--nzc-accent); margin-inline-end:auto; }
.nzc-art-webhero { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding:15px 13px 10px; }
.nzc-art-webhero > div:first-child { display:flex; flex-direction:column; gap:5px; padding-block:4px; }
.nzc-art-line { inline-size:90%; block-size:5px; border-radius:3px; background:var(--nzc-accent); opacity:.65; }
.nzc-art-line:nth-child(2) { inline-size:65%; }
.nzc-art-line-short { inline-size:80%; block-size:3px; margin-block-start:5px; background:var(--nzc-border); }
.nzc-art-webbutton { inline-size:35px; block-size:11px; border-radius:4px; margin-block-start:6px; background:var(--nzc-accent-soft); border:1px solid color-mix(in srgb,var(--nzc-accent) 25%,transparent); }
.nzc-art-webimage { display:flex; align-items:end; justify-content:center; gap:5px; block-size:64px; padding:9px; background:linear-gradient(140deg,#cfe8da70,#58707935); border-radius:8px; overflow:hidden; }
.nzc-art-webimage span { inline-size:20px; block-size:25px; border-radius:15px 15px 3px 3px; background:#93b6b3; }
.nzc-art-webimage span:nth-child(2) { block-size:48px; background:#587079; }
.nzc-art-webimage span:nth-child(3) { block-size:35px; background:#bcdccb; }
.nzc-art-webtiles { display:flex; gap:7px; padding-inline:13px; }
.nzc-art-webtiles span { block-size:15px; flex:1; border-radius:4px; background:var(--nzc-accent-soft); }
.nzc-art-chip { position:absolute; display:flex; align-items:center; gap:7px; padding:9px 12px; border-radius:11px; background:color-mix(in srgb,var(--nzc-card) 90%,#93b6b3); border:1px solid color-mix(in srgb,var(--nzc-accent) 23%,transparent); box-shadow:0 6px 20px #34434d0c; font-size:10px; white-space:nowrap; }
.nzc-art-chip-top { inset-block-start:18px; inset-inline-end:22px; transform:rotate(3deg); }
.nzc-art-chip-bottom { inset-block-end:14px; inset-inline-start:80px; }
.nzc-art-cloud-core { position:absolute; inset-inline-start:143px; inset-block-start:60px; inline-size:96px; block-size:96px; display:grid; place-content:center; justify-items:center; gap:6px; border-radius:26px; border:1px solid #93b6b34d; background:linear-gradient(135deg,var(--nzc-card),color-mix(in srgb,var(--nzc-card) 60%,#93b6b3)); box-shadow:0 0 0 8px #93b6b309,0 0 0 25px #93b6b308; }
.nzc-art-cloud-core > span { font-size:7px; letter-spacing:.12em; }
.nzc-art-network { position:absolute; inset:40px 60px; }
.nzc-art-network span { position:absolute; inline-size:110px; block-size:1px; background:linear-gradient(90deg,#93b6b310,#93b6b3aa); transform:rotate(24deg); inset-block-start:50px; }
.nzc-art-network span:nth-child(2) { inset-inline-end:0; transform:rotate(-28deg); inset-block-start:85px; }
.nzc-art-node { position:absolute; display:grid; justify-items:start; gap:7px; inline-size:86px; padding:12px; border:1px solid var(--nzc-border); border-radius:14px; background:var(--nzc-card); box-shadow:0 7px 18px #34434d0e; font-size:9px; }
.nzc-art-node-one { inset-inline-start:25px; inset-block-start:24px; transform:rotate(-6deg); }
.nzc-art-node-two { inset-inline-end:24px; inset-block-start:93px; transform:rotate(5deg); }
.nzc-art-node-bars { display:flex; gap:3px; }
.nzc-art-node-bars i { inline-size:8px; block-size:6px; border-radius:2px; background:var(--nzc-accent); opacity:.45; }
.nzc-art-node-bars i:nth-child(2n) { opacity:.2; }
.nzc-art-storage-lines { display:grid; gap:3px; }
.nzc-art-storage-lines i { inline-size:48px; block-size:3px; border-radius:2px; background:var(--nzc-accent-soft); }
.nzc-art-domain-card { position:absolute; inset-inline-start:24px; inset-block-start:52px; inline-size:285px; padding:18px; border:1px solid var(--nzc-border); border-radius:17px; background:var(--nzc-card); box-shadow:0 12px 30px #34434d12; transform:rotate(-3deg); }
.nzc-art-domain-label { display:block; font-size:9px; color:var(--nzc-muted); margin-block-end:12px; }
.nzc-art-domain-search { display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:10px; border:1px solid #93b6b34d; background:var(--nzc-accent-soft); }
.nzc-art-domain-search > span { font-size:21px; color:var(--nzc-fg); font-weight:500; letter-spacing:-.04em; }
.nzc-art-domain-search > span > span { color:var(--nzc-accent); }
.nzc-art-domain-search .nzc-art-search-arrow { display:grid; place-items:center; inline-size:24px; block-size:24px; border-radius:50%; background:var(--nzc-accent); color:var(--nzc-on-accent); margin-inline-start:auto; }
.nzc-art-tlds { display:flex; gap:6px; margin-block-start:10px; }
.nzc-art-tlds span { font-size:9px; padding:3px 8px; border:1px solid var(--nzc-border); border-radius:6px; color:var(--nzc-muted); }
.nzc-art-dns { position:absolute; inset-inline-end:18px; inset-block-end:16px; display:grid; gap:8px; inline-size:106px; padding:12px; border-radius:13px; border:1px solid #93b6b34d; background:color-mix(in srgb,var(--nzc-card) 84%,#bcdccb); transform:rotate(5deg); box-shadow:0 8px 20px #34434d12; font-size:10px; }
.nzc-art-dns > span { display:flex; align-items:center; gap:7px; }
.nzc-art-dns b { font-size:7px; font-weight:500; inline-size:29px; }
.nzc-art-dns i { block-size:3px; background:var(--nzc-accent); opacity:.3; flex:1; }
@media(max-width:700px) { .nzc-home-slider { grid-template-columns:1fr; } .nzc-slide-copy { min-block-size:190px; padding-block-end:18px; } .nzc-service-art { block-size:205px; margin-block-end:35px; } .nzc-slide-controls { inset-block-end:10px; } }
@media(max-width:380px) { .nzc-service-art { transform:scale(.87); transform-origin:center; } }

/* Borderless card surfaces across customer and admin consoles. */
.nzc :is(.nz-card,.nz-table-wrap,.nz-state,.nzc-stat,.nzc-tile,.nzc-navcard,.nzc-service-tile,.nzc-panel,.nzc-quota,.nzc-action,.nzc-callout,.nzc-hero,.nzc-home-slider,.nzc-home-service,.nzc-home-build,.nzc-home-product,.nzc-shop-card,.nzc-shop-plan,.nzc-co-card,.nzc-cart-panel,.nzc-split-card,.nzc-split-panel,.nzc-host-planner,.nzc-host-planner-panel,.nzc-dsearch,.nzc-dres-best,.nzc-dres-list,.nzc-rhead,.nzc-facts,.hs-plan,.hs-hero,.ld-card,.ld-tld,.bl-pcard,.bl-hero,.mws-panel,.nzc-plan,.nzc-tld) { border:0 !important; }
.nzc-home-service::before { border:0; background:color-mix(in srgb,var(--nzc-accent) 5%,transparent); }
.nzc :is(.nzc-art-window,.nzc-art-chip,.nzc-art-node,.nzc-art-domain-card,.nzc-art-dns,.nzc-art-cloud-core) { border:0; }
.nzc-slide-motion { position:absolute; z-index:2; inset-inline-end:18px; inset-block-end:12px; border:0; padding:5px 8px; border-radius:7px; background:var(--nzc-accent-soft); color:var(--nzc-accent); font:inherit; font-size:10px; cursor:pointer; }
.nzc-service-art { animation:nzc-art-enter .45s ease-out both; }
.nzc-art-window { animation:nzc-art-window-drift 6s ease-in-out infinite; }
.nzc-art-chip-top { animation:nzc-art-chip-drift 5s ease-in-out infinite; }
.nzc-art-chip-bottom { animation:nzc-art-chip-drift 5.8s ease-in-out -.8s infinite; }
.nzc-art-webimage span { transform-origin:center bottom; animation:nzc-art-bar 3s ease-in-out infinite; }
.nzc-art-webimage span:nth-child(2) { animation-delay:-1s; }
.nzc-art-webimage span:nth-child(3) { animation-delay:-2s; }
.nzc-art-cloud-core { animation:nzc-art-core 4s ease-in-out infinite; }
.nzc-art-network span { background:linear-gradient(90deg,transparent,#93b6b3,transparent); background-size:220% 100%; animation:nzc-art-signal 3s linear infinite; }
.nzc-art-network span:nth-child(2) { animation-delay:-1.5s; }
.nzc-art-node-bars i { animation:nzc-art-spark 2.8s ease-in-out infinite; }
.nzc-art-node-bars i:nth-child(2n) { animation-delay:-1.4s; }
.nzc-art-domain-card { animation:nzc-art-domain-drift 6s ease-in-out infinite; }
.nzc-art-dns { animation:nzc-art-dns-drift 5s ease-in-out -.6s infinite; }
.nzc-art-tlds span { animation:nzc-art-spark 4s ease-in-out infinite; }
.nzc-art-tlds span:nth-child(2) { animation-delay:-1.3s; }
.nzc-art-tlds span:nth-child(3) { animation-delay:-2.6s; }
.nzc-home-slider[data-motion='paused'] .nzc-service-art,.nzc-home-slider[data-motion='paused'] .nzc-service-art * { animation-play-state:paused !important; }
@keyframes nzc-art-enter { from { opacity:0; translate:0 6px; } to { opacity:1; translate:0 0; } }
@keyframes nzc-art-window-drift { 0%,100% { transform:translateY(0) rotate(-4deg); } 50% { transform:translateY(-5px) rotate(-3deg); } }
@keyframes nzc-art-chip-drift { 0%,100% { translate:0 0; } 50% { translate:0 -5px; } }
@keyframes nzc-art-bar { 0%,100% { scale:1 1; } 50% { scale:1 .78; } }
@keyframes nzc-art-core { 0%,100% { box-shadow:0 0 0 8px #93b6b309,0 0 0 25px #93b6b308; } 50% { box-shadow:0 0 0 12px #93b6b318,0 0 0 31px #93b6b303; } }
@keyframes nzc-art-signal { from { background-position:200% 0; } to { background-position:-20% 0; } }
@keyframes nzc-art-spark { 0%,100% { opacity:.4; } 50% { opacity:1; } }
@keyframes nzc-art-domain-drift { 0%,100% { transform:translateY(0) rotate(-3deg); } 50% { transform:translateY(-4px) rotate(-2deg); } }
@keyframes nzc-art-dns-drift { 0%,100% { transform:translateY(0) rotate(5deg); } 50% { transform:translateY(-5px) rotate(3deg); } }
@media(prefers-reduced-motion:reduce) { .nzc-service-art,.nzc-service-art * { animation:none !important; } .nzc-slide-motion { display:none; } }

/* Plain borderless surfaces, without decorative card patterns. */
.nzc :is(.nz-card,.nzc-stat,.nzc-tile,.nzc-navcard,.nzc-service-tile,.nzc-panel,.nzc-shop-card,.nzc-shop-plan,.nzc-co-card,.nzc-cart-panel,.nzc-home-service,.nzc-home-build,.nzc-home-product,.nzc-hero,.hs-plan,.hs-hero,.ld-card,.bl-pcard,.bl-hero,.mws-panel,.nzc-plan,.nzc-quota,.nzc-action,.nzc-callout,.nzc-host-planner-panel) { background-image:none !important; background-color:var(--nzc-card); }
.nzc-home-service::before { display:none; }
.nzc .nzc-home-service[data-service='hosting'] { background-color:color-mix(in srgb,var(--nzc-card) 90%,#bcdccb); }
.nzc .nzc-home-service[data-service='compute'] { background-color:color-mix(in srgb,var(--nzc-card) 90%,#93b6b3); }
.nzc .nzc-home-service[data-service='domains'] { background-color:color-mix(in srgb,var(--nzc-card) 95%,#cfe8da); }
.nzc-home-overview { background:#34434d; }

/* Dashboard status column: what needs attention, then the current servers, domains and websites. Sits at the start edge (left in English, right in Arabic) beside the dashboard. */
.nzc-dash-layout { display: grid; grid-template-columns: minmax(250px, 300px) minmax(0, 1fr); gap: 20px; align-items: start; }
.nzc-dash-layout > .nzc-dashboard { min-inline-size: 0; }
.nzc-status { display: grid; gap: 14px; align-content: start; min-inline-size: 0; overflow: visible; }
/* No scroll bar of its own, anywhere in the column: it grows to its content and the page scrolls it. */
.nzc-status, .nzc-status * { scrollbar-width: none; -ms-overflow-style: none; }
.nzc-status::-webkit-scrollbar, .nzc-status *::-webkit-scrollbar { display: none; inline-size: 0; block-size: 0; }
.nzc-status-card { min-inline-size: 0; overflow: hidden; }
/* Flat cards: no shadow, no glow, in any state. */
.nzc-status, .nzc-status * { box-shadow: none !important; text-shadow: none !important; filter: none !important; }
.nzc-status-card { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--nzc-border); border-radius: 20px; background: var(--nzc-card); }
.nzc-status-card > header { display: flex; align-items: center; gap: 10px; }
.nzc-status-card h2 { margin: 0; flex: 1; font-size: 15px; font-weight: 700; }
.nzc-status-icon { display: grid; place-items: center; inline-size: 32px; block-size: 32px; border-radius: 10px; background: color-mix(in srgb, var(--nzc-accent) 14%, var(--nzc-field)); color: var(--nzc-accent); flex: none; }
.nzc-status-count { min-inline-size: 26px; padding: 2px 9px; border-radius: 999px; background: var(--nzc-field); border: 1px solid var(--nzc-border); font-size: 13px; font-weight: 700; text-align: center; }
.nzc-status-count[data-alert='true'] { background: var(--nzc-warn-soft); border-color: transparent; color: var(--nzc-warn); }
.nzc-status-card ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.nzc-status-card li a { display: flex; align-items: center; gap: 10px; padding: 9px 8px; border-radius: 12px; color: var(--nzc-fg); text-decoration: none; font-size: 14px; transition: background 0.15s ease; }
.nzc-status-card li a:hover { background: color-mix(in srgb, var(--nzc-accent) 9%, transparent); }
.nzc-status-name { display: block; flex: 1; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.nzc-status-card li small { color: var(--nzc-muted); font-size: 12px; white-space: nowrap; }
.nzc-status-text { flex: 1; line-height: 1.5; }
.nzc-status-dot { flex: none; inline-size: 9px; block-size: 9px; border-radius: 50%; background: var(--nzc-muted); }
.nzc-status-dot[data-tone='ok'] { background: var(--nzc-success); }
.nzc-status-dot[data-tone='warn'] { background: var(--nzc-warn); }
.nzc-status-dot[data-tone='bad'] { background: var(--nzc-danger); }
.nzc-status-empty { margin: 0; color: var(--nzc-muted); font-size: 13.5px; }
.nzc-status-ok { display: flex; align-items: center; gap: 8px; color: var(--nzc-success); }
.nzc-status-all { display: inline-flex; align-items: center; gap: 6px; justify-self: start; padding: 4px 8px; border-radius: 10px; color: var(--nzc-accent); font-size: 13px; font-weight: 650; text-decoration: none; }
.nzc-status-all:hover { background: color-mix(in srgb, var(--nzc-accent) 10%, transparent); }
html[dir='rtl'] .nzc-status-all .nzc-icon { transform: scaleX(-1); }
@media (max-width: 1100px) { .nzc-dash-layout { grid-template-columns: minmax(0, 1fr); } .nzc-status { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); } }

/* Status column, second pass: a calmer surface for the resource cards and a dark "needs attention" card that stands out on both themes. */
.nzc-status { gap: 12px; }
.nzc-status-title { margin: 2px 6px 0; color: var(--nzc-muted); font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
html[lang='ar'] .nzc-status-title { letter-spacing: 0; text-transform: none; font-size: 13px; }
.nzc-status-card { gap: 8px; padding: 14px; border-radius: 22px; background: color-mix(in srgb, var(--nzc-accent) 5%, var(--nzc-card)); }
.nzc-status-card > header { margin-block-end: 2px; }
.nzc-status-card h2 { font-size: 15px; letter-spacing: -0.01em; }
.nzc-status-icon { border-radius: 50%; background: color-mix(in srgb, var(--nzc-accent) 18%, var(--nzc-field)); }
.nzc-status-count { min-inline-size: 30px; padding: 3px 10px; font-size: 14px; font-weight: 750; font-variant-numeric: tabular-nums; background: color-mix(in srgb, var(--nzc-fg) 6%, transparent); border-color: transparent; }
.nzc-status-card li a { padding: 10px 12px; border-radius: 14px; background: color-mix(in srgb, var(--nzc-fg) 4%, transparent); }
.nzc-status-card li a:hover { background: color-mix(in srgb, var(--nzc-accent) 14%, transparent); }
.nzc-status-all { margin-block-start: 2px; padding: 6px 10px; border-radius: 999px; background: color-mix(in srgb, var(--nzc-accent) 10%, transparent); }
.nzc-status-attention { --nzc-att-fg: #f4f4f1; --nzc-att-muted: #a9b4b6; border-color: #3f4d55; background: linear-gradient(160deg, #3a4a53 0%, #1f2a30 100%); color: var(--nzc-att-fg); }
.nzc-status-attention h2 { color: var(--nzc-att-fg); }
.nzc-status-attention .nzc-status-icon { background: rgba(255, 255, 255, 0.12); color: #cfe8da; }
.nzc-status-attention .nzc-status-count { background: rgba(255, 255, 255, 0.12); color: var(--nzc-att-fg); }
.nzc-status-attention .nzc-status-count[data-alert='true'] { background: #d9534f; color: #fff; }
.nzc-status-attention li a { background: rgba(255, 255, 255, 0.08); color: var(--nzc-att-fg); }
.nzc-status-attention li a:hover { background: rgba(255, 255, 255, 0.16); }
.nzc-status-attention .nzc-status-empty { color: var(--nzc-att-muted); }
.nzc-status-attention .nzc-status-ok { color: #8fe0b8; }
.nzc-status-attention .nzc-status-dot[data-tone='warn'] { background: #f0b34a; }
.nzc-status-attention .nzc-status-dot[data-tone='bad'] { background: #f2766f; }

/* Editable bento artwork adapted from the user-supplied Nuzm component pack. */
.nb-art { --nb-paper:#f6f8f4; --nb-ink:#273c42; --nb-muted:#628d88; --nb-well:#e8eeea; --nb-back:#b6d8cb; display:grid; place-items:center; block-size:220px; min-inline-size:0; direction:ltr; }
.nb-process-stack,.nb-cluster-stack { position:relative; inline-size:245px; transform:rotate(-7deg); }
.nb-stack-sheet { position:absolute; inset:0; border-radius:17px; background:var(--nb-back); }
.nb-sheet-back { transform:translate(20px,16px) rotate(8deg); opacity:.35; }
.nb-sheet-middle { transform:translate(10px,8px) rotate(3deg); opacity:.65; }
.nb-process-sheet,.nb-cluster-sheet { position:relative; background:var(--nb-paper); color:var(--nb-ink); padding:17px; border-radius:17px; box-shadow:0 12px 25px #10252c1c; }
.nb-process-step > span:first-child { display:flex; align-items:center; justify-content:center; gap:18px; padding:9px; background:var(--nb-well); border-radius:9px; font-size:13px; }
.nb-process-step .nzc-icon { color:var(--nb-muted); }
.nb-down { display:block; text-align:center; color:var(--nb-muted); font-size:15px; line-height:20px; }
.nb-cluster-stack { inline-size:285px; transform:rotate(-3deg); }
.nb-widget-heading { display:flex; align-items:center; justify-content:space-between; font-size:9px; letter-spacing:.07em; font-weight:600; color:var(--nb-ink); }
.nb-resource-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; margin-block-start:13px; }
.nb-resource-grid > span { display:grid; gap:6px; place-items:center; padding:10px 3px; background:var(--nb-well); color:var(--nb-muted); border-radius:10px; font-size:8px; }
.nb-wave { display:block; inline-size:100%; block-size:40px; margin-block-start:9px; color:#6bada1; }
.nb-wave-line { stroke-dasharray:320; stroke-dashoffset:0; animation:nb-draw 5s ease-in-out infinite; }
.nb-domain-scene { position:relative; inline-size:295px; block-size:190px; }
.nb-globe { position:absolute; inset-inline-end:8px; inset-block-start:0; color:#93b6b3; opacity:.45; transform:rotate(-12deg); }
.nb-globe .nzc-icon { stroke-width:.65; }
.nb-domain-sheet { position:absolute; inset-inline-start:10px; inset-block-start:45px; inline-size:225px; padding:20px; background:var(--nb-paper); color:var(--nb-ink); border-radius:17px; box-shadow:10px 10px 0 #b6d8cb44,0 12px 25px #10252c12; transform:rotate(-6deg); }
.nb-domain-sheet strong { display:block; font-size:27px; font-weight:500; letter-spacing:-.06em; margin-block:12px; }
.nb-domain-sheet strong span { color:var(--nb-muted); }
.nb-domain-tags { display:flex; gap:6px; }
.nb-domain-tags span { padding:4px 10px; border-radius:20px; background:var(--nb-well); font-size:10px; }
.nb-dns-tag { position:absolute; inset-inline-end:5px; inset-block-end:5px; display:flex; align-items:center; gap:6px; padding:8px 13px; background:#bedfd1; color:#315c52; border-radius:11px; font-size:10px; box-shadow:0 5px 16px #10252c14; }
.nb-editor { inline-size:100%; max-inline-size:300px; border-radius:13px; padding:14px; background:#23353b; color:#e4eeeb; box-shadow:7px 9px 0 #93b6b324; transform:rotate(-3deg); }
.nb-editor-top { display:flex; justify-content:space-between; gap:10px; font-size:8px; color:#a9c2bc; }
.nb-editor-top > span:first-child { display:flex; gap:4px; }
.nb-editor-top i { inline-size:5px; block-size:5px; background:#bcdccb; border-radius:50%; }
.nb-editor-top i:nth-child(2) { background:#ecd698; }
.nb-editor-top i:nth-child(3) { background:#a7c8db; }
.nb-editor pre { margin:12px 0 0; font-size:9px; line-height:1.8; white-space:pre-wrap; text-align:start; }
.nb-editor pre > span { color:#97d8d3; }
.nb-editor pre b { color:#d9dfac; font-weight:400; }
.nzc .nzc-home-slider { background:linear-gradient(110deg,#263840,#466b6b 70%,#769e94); color:#f4f7f3; --nzc-accent:#c4e8da; --nzc-muted:#d2dfd9; --nzc-fg:#f4f7f3; }
.nzc-home-slider .nzc-slide-link { background:#f5f6f1; color:#273c42 !important; border:0; border-radius:20px; padding:9px 15px; }
.nzc-home-slider .nzc-slide-controls > button { background:#ffffff0d; border:0; }
.nzc-home-slider .nzc-slide-motion { color:#d2e8de; background:#ffffff12; }
.nzc .nzc-home-service { gap:9px; overflow:hidden; }
.nzc-home-service .nb-art-compact { block-size:125px; inline-size:100%; margin-block:0; max-inline-size:none; animation:none; }
.nb-art-compact .nb-process-stack { inline-size:174px; transform:rotate(-6deg) scale(.85); }
.nb-art-compact .nb-process-sheet { padding:10px; }
.nb-art-compact .nb-process-step > span:first-child { padding:6px; font-size:10px; gap:12px; }
.nb-art-compact .nb-down { line-height:13px; font-size:11px; }
.nb-art-compact .nb-process-step .nzc-icon { inline-size:14px; block-size:14px; }
.nb-art-compact .nb-cluster-stack { inline-size:215px; transform:rotate(-3deg) scale(.88); }
.nb-art-compact .nb-cluster-sheet { padding:12px; }
.nb-art-compact .nb-resource-grid { margin-block-start:9px; }
.nb-art-compact .nb-resource-grid > span { padding:8px 3px; gap:4px; }
.nb-art-compact .nb-wave { block-size:27px; margin-block-start:5px; }
.nb-art-compact .nb-domain-scene { transform:scale(.72); transform-origin:center; }
.nzc .nzc-home-build { display:flex; flex-direction:column; align-items:stretch; gap:14px; justify-content:space-between; overflow:hidden; }
.nzc-home-build .nb-art-compact { block-size:125px; inline-size:100%; max-inline-size:none; animation:none; }
.nzc-home-build h2 { max-inline-size:none; font-size:17px; }
.nb-art > .nb-process-stack { animation:nb-stack-float 6s ease-in-out infinite; }
.nb-art > .nb-cluster-stack { animation:nb-cluster-float 6s ease-in-out infinite; }
.nb-art-compact > .nb-process-stack { animation:none; }
.nb-art-compact > .nb-cluster-stack { animation:none; }
@keyframes nb-stack-float { 0%,100% { transform:translateY(0) rotate(-7deg); } 50% { transform:translateY(-5px) rotate(-5deg); } }
@keyframes nb-cluster-float { 0%,100% { transform:translateY(0) rotate(-3deg); } 50% { transform:translateY(-5px) rotate(-1deg); } }
@keyframes nb-draw { 0%,100% { stroke-dashoffset:0; opacity:1; } 50% { stroke-dashoffset:35; opacity:.65; } }
@media(max-width:700px) { .nzc .nzc-home-slider { grid-template-columns:1fr; } .nzc-home-slider .nb-art { block-size:195px; margin-block:0 35px; } }
@media(prefers-reduced-motion:reduce) { .nb-art,.nb-art * { animation:none !important; } }

/* Dashboard cards have no stroke: they are told apart by their fill, not an outline. */
.nzc-dash-layout :is(.nz-card, .nzc-stat, .nzc-status-card, .nzc-home-overview, .nzc-home-service, .nzc-home-build, .nzc-split > *, .nzc-dashboard-empty) { border: 0 !important; }
.nzc-status-attention { border: 0 !important; }
/* Smaller service cards: one clear heading, compact artwork, no description. */
.nzc-home-bento { grid-auto-rows:200px; }
.nzc .nzc-home-service { padding:14px 17px; gap:7px; justify-content:space-between; }
.nzc-home-service-top { gap:10px; }
.nzc .nzc-home-service h2 { margin:0; font-size:22px; line-height:1.2; font-weight:600; letter-spacing:-.025em; }
.nzc-home-service-top > .nzc-icon:last-child { margin-inline-start:auto; }
.nzc .nzc-home-service .nb-art-compact,.nzc .nzc-home-build .nb-art-compact { block-size:90px; min-block-size:0; }
.nb-art-compact .nb-cluster-stack { transform:rotate(-3deg) scale(.67); }
.nb-art-compact .nb-domain-scene { transform:scale(.53); }
.nb-art-compact .nb-editor { max-inline-size:245px; padding:10px; transform:rotate(-2deg) scale(.85); }
.nb-art-compact .nb-editor pre { font-size:8px; line-height:1.6; margin-block-start:8px; }
.nzc .nzc-home-build { padding:14px 17px; gap:10px; }
.nzc .nzc-home-build h2 { font-size:22px; line-height:1.2; margin-block-start:6px; }
.nzc-home-overview { padding:19px; }
.nzc-home-orbit { inline-size:155px; block-size:155px; margin-block:10px; }
.nzc-home-overview-head h2 { font-size:17px; }
.nb-host-scene { position:relative; inline-size:290px; block-size:175px; }
.nb-host-browser { position:absolute; inset-inline-start:10px; inset-block-start:12px; inline-size:230px; padding:12px; border-radius:15px; background:var(--nb-paper); color:var(--nb-ink); transform:rotate(-5deg); box-shadow:9px 10px 0 #b6d8cb55,0 12px 25px #10252c15; }
.nb-host-address { display:flex; align-items:center; gap:6px; font-size:8px; color:var(--nb-muted); }
.nb-host-dots { margin-inline-start:auto; letter-spacing:2px; }
.nb-host-preview { display:grid; grid-template-columns:1fr 1fr; gap:15px; margin-block:15px 10px; }
.nb-host-preview > div { display:grid; align-content:center; gap:5px; }
.nb-host-preview i { display:block; block-size:4px; border-radius:4px; background:#7ba69a; }
.nb-host-preview i:nth-child(2) { inline-size:70%; }
.nb-host-preview i:nth-child(3) { inline-size:85%; block-size:2px; opacity:.4; }
.nb-host-preview b { inline-size:35px; block-size:10px; border-radius:4px; background:#bdded0; margin-block-start:4px; }
.nb-host-preview > span { display:grid; place-items:center; block-size:62px; border-radius:9px; background:linear-gradient(140deg,#d4e8dc,#98bfb7); color:#57817b; }
.nb-host-tiles { display:flex; gap:5px; }
.nb-host-tiles i { flex:1; block-size:13px; background:var(--nb-well); border-radius:4px; }
.nb-host-server { position:absolute; inset-inline-end:0; inset-block-end:0; display:grid; place-items:center; gap:6px; inline-size:90px; padding:13px 8px; border-radius:13px; background:#2d454b; color:#c4e8d7; box-shadow:0 8px 20px #10252c22; transform:rotate(5deg); animation:nb-host-drift 5s ease-in-out infinite; }
.nb-host-server > span { font-size:6px; letter-spacing:.06em; }
.nb-host-server > div { display:flex; gap:4px; }
.nb-host-server i { inline-size:12px; block-size:3px; border-radius:2px; background:#a5d4c3; opacity:.65; }
.nb-art-compact .nb-host-scene { transform:scale(.57); }
@keyframes nb-host-drift { 0%,100% { translate:0 0; } 50% { translate:0 -4px; } }
@media(max-width:560px) { .nzc-home-bento { grid-auto-rows:auto; } .nzc .nzc-home-service,.nzc .nzc-home-build { min-block-size:190px; } .nzc-home-overview { min-block-size:270px; } }
@media(prefers-reduced-motion:reduce) { .nb-host-server { animation:none; } }
/* Dashboard panels size to their content, rather than the auth split-screen layout. */
.nzc-dashboard { align-content:start; }
.nzc-dashboard .nzc-split { min-block-size:0; padding:0; background:transparent; }
.nzc-body:has(.nzc-dash-layout) { padding-block-end:24px; }

/* Status column resource cards: white background in light mode only (dark mode keeps the dark card; the "needs attention" card keeps its own). */
.nzc[data-theme="light"] .nzc-status-card:not(.nzc-status-attention) { background: #ffffff; color: #17181a; --nzc-fg: #17181a; --nzc-muted: #5b5f63; }

/* AI Studio panel (ADR-064): the workspace's own cards, lists and controls; no new colours. */
.ais-body { display: block; }
.ais-stack { display: grid; gap: 14px; align-content: start; max-inline-size: 960px; }
.ais-card { display: grid; gap: 10px; padding: 16px 18px; border-radius: 16px; background: var(--nzc-field); }
.ais-card-h { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ais-card-h .nz-h2 { margin: 0; font-size: 15px; }
.ais-card p { margin: 0; }
.ais-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ais-list li { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 9px 12px; border-radius: 12px; background: var(--nzc-card); font-size: 13px; }
.ais-list li > span { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; min-inline-size: 0; overflow-wrap: anywhere; }
.ais-section { display: grid; gap: 8px; margin: 0; padding: 12px; border: 0; border-radius: 12px; background: var(--nzc-card); }
.ais-section-title { font-weight: 600; }
.ais-rule { display: grid; grid-template-columns: minmax(96px, 120px) minmax(0, 1fr) auto; gap: 8px; align-items: center; }
.ais-textarea { inline-size: 100%; min-block-size: 110px; resize: vertical; font: inherit; }
.ais-actions { gap: 8px; flex-wrap: wrap; }
.ais-md { margin: 0; max-block-size: 420px; overflow: auto; padding: 14px; border-radius: 12px; background: var(--nzc-card); font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
.ais-baseline summary { cursor: pointer; color: var(--nzc-muted); font-size: 13px; }
.ais-baseline ul { margin: 6px 0 10px; padding-inline-start: 18px; font-size: 13px; display: grid; gap: 4px; }
.ais-dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 0; font-size: 13px; }
.ais-dl dt { color: var(--nzc-muted); }
.ais-dl dd { margin: 0; }
.ais-facts { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 13px; }
.ais-facts li { display: flex; align-items: center; gap: 8px; }
.ais-link { padding: 0; border: 0; background: transparent; color: var(--nzc-accent); font: inherit; cursor: pointer; text-align: start; display: inline-flex; align-items: center; gap: 6px; }
.ais-link:hover { text-decoration: underline; }
.ais-link:focus-visible, .ais-card button:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }
.ais-preview { flex-basis: 100%; color: var(--nzc-muted); font-size: 12px; overflow-wrap: anywhere; }
.ais-confirm { display: grid; gap: 10px; padding: 14px 16px; border-radius: 14px; background: var(--nzc-danger-soft); }
@media (max-width: 640px) { .ais-rule { grid-template-columns: 1fr auto; } .ais-rule select { grid-column: 1 / -1; } }

/* Workspace panels (Spec, Data, Tests, Versions, Exports, Deployments, Builds, Signing, Releases): one centred column with one rhythm, cards that stand out from the
   canvas, label/value rows that stay together, stat tiles for totals, and forms in a compact grid instead of fields stretched across the whole canvas. */
.nzc .mws-panel { padding: 28px clamp(16px, 3.5vw, 44px) 44px; }
.nzc .mws-panel > * { box-sizing: border-box; inline-size: 100%; max-inline-size: 1040px; margin-inline: auto; }
.nzc .mws-panel > * + * { margin-block-start: 24px; }
.nzc .mws-panel section { display: grid; gap: 14px; align-content: start; min-inline-size: 0; }
.nzc .mws-panel[data-panel='preview'] { padding: 0; }
.nzc .mws-panel[data-panel='preview'] > * { max-inline-size: none; margin: 0; }
.nzc .mws-panel .mws-live { display: flex; flex-direction: column; flex: 1; min-block-size: 0; gap: 0; }
.nzc .mws-panel :is(h2, .nz-h2) { margin: 0; font-size: 18px; font-weight: 700; line-height: 1.4; }
.nzc .mws-panel :is(h3, .nz-h3) { margin: 0; font-size: 15px; font-weight: 650; line-height: 1.5; }
.nzc .mws-panel p { margin: 0; line-height: 1.7; }
.nzc .mws-panel :is(.nz-card, .nzc-panel) { display: grid; gap: 14px; align-content: start; min-inline-size: 0; padding: 20px 22px; border-radius: 16px; background-color: var(--nzc-field); box-shadow: inset 0 0 0 1px var(--nzc-border); }
.nzc .mws-panel dl { display: grid; grid-template-columns: minmax(110px, max-content) minmax(0, 1fr); gap: 10px 28px; margin: 0; font-size: 14px; align-items: start; }
.nzc .mws-panel dt { color: var(--nzc-muted); }
.nzc .mws-panel dd { margin: 0; min-inline-size: 0; overflow-wrap: anywhere; text-align: start; }
.nzc .mws-panel dl.mws-stats { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; }
.nzc .mws-panel .mws-stats > div { display: grid; gap: 4px; padding: 14px 16px; border-radius: 12px; background: var(--nzc-card); }
.nzc .mws-panel .mws-stats dt { font-size: 12px; }
.nzc .mws-panel .mws-stats dd { font-size: 24px; font-weight: 700; color: var(--nzc-fg); }
.nzc .mws-panel .mws-note { padding: 12px 14px; border-radius: 12px; background: var(--nzc-card); color: var(--nzc-muted); font: 12.5px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.nzc .mws-panel .bld-list { grid-template-columns: minmax(0, 1fr); gap: 12px; margin: 0; }
.nzc .mws-panel .bld-list .nz-card { block-size: auto; overflow: visible; }
.nzc .mws-panel .bld-list dd { text-align: start; }
.nzc .mws-panel .nz-grid { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; margin: 0; }
.nzc .mws-panel .nz-grid > .nz-card { block-size: 100%; }
.nzc .mws-panel .nz-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
.nzc .mws-panel .nz-row > .nz-field { inline-size: auto; flex: 0 1 280px; min-inline-size: 200px; }
.nzc .mws-panel .nz-table-wrap { border-radius: 14px; overflow: auto; background: var(--nzc-field); box-shadow: inset 0 0 0 1px var(--nzc-border); }
/* tables inside studio panels: a table keeps its surface, cards sit on the panel with their own surface and room, the caption never touches an edge */
.nzc .mws-panel .nz-table-wrap:not([data-view="cards"]) .nz-table caption { padding: 16px 20px 10px; text-align: start; font-weight: 640; }
.nzc .mws-panel .nz-table-wrap:not([data-view="cards"]) :is(th, td) { padding-inline: 20px; }
.nzc .mws-panel .nz-table-wrap[data-view="cards"] { background: transparent; box-shadow: none; overflow: visible; }
.nzc .mws-panel .nz-table-wrap[data-view="cards"] .nz-table caption { padding: 0 100px 14px 2px; font-weight: 640; }
[dir="rtl"] .nzc .mws-panel .nz-table-wrap[data-view="cards"] .nz-table caption { padding: 0 2px 14px 100px; }
.nzc .mws-panel .nz-table-wrap[data-view="cards"] tbody { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
.nzc .mws-panel .nz-table-wrap[data-view="cards"] tbody tr { padding: 22px 24px 20px; border-radius: 16px; border: 0; background: var(--nzc-field); box-shadow: inset 0 0 0 1px var(--nzc-border); }
.nzc .mws-panel .nz-table-wrap[data-view="cards"] td { flex-wrap: wrap; row-gap: 4px; padding: 9px 0; }
.nzc .mws-panel .nz-table-wrap[data-view="cards"] .nz-cell-value { flex: 1 1 55%; text-align: end; overflow-wrap: anywhere; }
.nzc .mws-panel .nz-table-wrap[data-view="cards"] td:first-child { padding: 0 0 12px; }
.nzc .mws-panel .nz-state { display: grid; justify-items: center; gap: 8px; padding: 40px 20px; border-radius: 16px; background-color: var(--nzc-field); text-align: center; }
.nzc .mws-panel dialog:not([open]) { display: none; }
.nzc .mws-panel form.nz-card { max-inline-size: none; }
.nzc .mws-panel form { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 330px), 1fr)); gap: 16px 18px; align-items: start; justify-self: start; inline-size: 100%; max-inline-size: 780px; }
.nzc .mws-panel form > :not(.nz-field) { grid-column: 1 / -1; }
.nzc .mws-panel .nz-field { display: grid; gap: 6px; margin: 0; min-inline-size: 0; }
.nzc .mws-panel .nz-field label { font-size: 13px; font-weight: 600; }
.nzc .mws-panel :is(.nz-input, select, textarea) { box-sizing: border-box; inline-size: 100%; }
.nzc .mws-panel form > .nz-btn, .nzc .mws-panel form > button { justify-self: start; }
@media (max-width: 760px) { .nzc .mws-panel { padding: 18px 14px 32px; } .nzc .mws-panel dl { grid-template-columns: minmax(0, 1fr); gap: 2px 0; } .nzc .mws-panel dl.mws-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

/* AI Studio (Instructions, Skills, GitHub, File search, Claude Code): the same centred column, padding and card as the other workspace panels. */
.wsp-subbar { padding: 10px clamp(16px, 3.5vw, 44px); gap: 6px; }
.wsp-scroll.ais-body { padding: 24px clamp(16px, 3.5vw, 44px) 44px; }
.ais-stack { gap: 18px; inline-size: 100%; max-inline-size: 1040px; margin-inline: auto; box-sizing: border-box; }
.ais-card { gap: 14px; padding: 20px 22px; box-shadow: inset 0 0 0 1px var(--nzc-border); }
.ais-card-h .nz-h2 { font-size: 16px; font-weight: 700; }
.ais-card p { line-height: 1.7; }
.ais-list li { padding: 11px 14px; }
.ais-dl { gap: 10px 28px; font-size: 14px; }
.ais-card .nz-field { display: grid; gap: 6px; margin: 0; }
.ais-card .nz-field label { font-size: 13px; font-weight: 600; }
.ais-card :is(.nz-input, select, textarea) { box-sizing: border-box; inline-size: 100%; }
.ais-card .nz-row, .ais-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.ais-card > .nz-btn, .ais-card > button { justify-self: start; }
.ais-card .nz-row .nz-input, .ais-actions .nz-input { flex: 1 1 240px; inline-size: auto; min-inline-size: 180px; }
.ais-foot { display: flex; padding-block-start: 14px; border-block-start: 1px solid var(--nzc-border); }

/* AI Intelligence Center admin (ADR-065): upload panel, filters, resource detail */
.knu { display: grid; gap: 12px; margin-block-end: 16px; justify-items: start; }
.knu > .knu-panel { justify-self: stretch; }
.knu-panel { display: grid; gap: 16px; }
.knu-drop { display: grid; gap: 8px; justify-items: center; text-align: center; padding: 24px 16px; border: 2px dashed var(--nzc-border); border-radius: 16px; background: var(--nzc-field); transition: border-color 0.15s, background 0.15s; }
.knu-drop[data-over] { border-color: var(--nzc-accent); background: var(--nzc-accent-soft); }
.knu-drop p { margin: 0; }
.knu-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 14px 18px; align-items: start; }
.knu-progress { display: grid; gap: 6px; }
.knu-progress .nz-meter { inline-size: 100%; }
.kn-filters { display: grid; gap: 14px; margin-block: 16px; }
.kn-filter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: 12px 16px; align-items: end; }
.knd { display: grid; gap: 18px; }
.knd-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; }
.knd-head .nz-h1 { margin: 0 0 4px; }
.knd-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 16px; align-items: start; }
.knd dl { display: grid; grid-template-columns: minmax(120px, max-content) minmax(0, 1fr); gap: 8px 20px; margin: 0; }
.knd dt { color: var(--nzc-muted); }
.knd dd { margin: 0; overflow-wrap: anywhere; }
.knd-q { display: contents; }
.knd-checks { display: grid; gap: 8px; margin: 14px 0; padding: 0; border: 0; }
.knd-check { display: flex; align-items: center; gap: 8px; }
.knd .nz-card { display: grid; gap: 12px; align-content: start; }
.knd .nz-h2, .knd .nz-h3 { margin: 0; }

/* Orange touches (the website's second brand colour): small and few, one per card or less. Teal stays the main colour, focus rings stay teal, cards stay flat. */
/* the slider's main button is the website's orange pill; its active dot is orange */
.nzc-home-slider .nzc-slide-link { background: var(--nzc-orange-grad); color: var(--nzc-orange-ink) !important; font-weight: 700; }
.nzc-home-slider .nzc-slide-link:hover { background: linear-gradient(165deg, #f5c39b 0%, #eda977 100%); }
.nzc-home-slider .nzc-slide-tabs button[aria-pressed='true']::after { background: var(--nzc-orange); }
/* the arrow button of the dark service card is orange; the others turn orange on hover or focus */
.nzc .nzc-home-service[data-service='compute'] .nzc-home-service-open, .nzc .nzc-home-service:is(:hover, :focus-visible) .nzc-home-service-open { background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); }
/* one peach card: the "what will you build" card, with the website's orange on the string values of its code artwork */
.nzc-home-build .nb-editor pre b { color: #f2b98c; }
.nzc .nzc-home-build { background-color: color-mix(in srgb, var(--nzc-card) 86%, #e9a16d); }
.nzc[data-theme="light"] .nzc-home-build > div > span { color: var(--nzc-orange-text); }
/* the overview card: the dot in its footer and a short bar under the number */
.nzc-home-overview-foot i { background: var(--nzc-orange); }
.nzc-home-orbit strong::after { content: ""; display: block; inline-size: 26px; block-size: 3px; margin: 6px auto 0; border-radius: 3px; background: var(--nzc-orange); }
/* key figures: the icon sits in a soft orange chip (the first figure of every row, and any figure marked accent="orange"); no edge lines on cards */
.nzc-stat[data-accent="orange"] .nzc-stat-label .nzc-icon, .nzc-stats > .nzc-stat:first-child .nzc-stat-label .nzc-icon { box-sizing: content-box; padding: 5px; border-radius: 50%; background: var(--nzc-orange-soft); color: var(--nzc-orange-text); }
/* needs attention: the count is the orange pill, warning dots are orange */
.nzc-status-attention .nzc-status-count[data-alert='true'] { background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); }
.nzc-status-dot[data-tone='warn'] { background: var(--nzc-orange-strong); }
.nzc-status-attention .nzc-status-dot[data-tone='warn'], .nzc[data-theme="dark"] .nzc-status-dot[data-tone='warn'] { background: var(--nzc-orange); }

/* Orange across every console page, through the shared classes: one accent per section, teal stays the main colour. Primary buttons are orange above (.nz-btn). */
/* the active tab's underline (page titles have no underline) */
.nzc-tab[aria-current="page"]::after, .nzc-tab[data-current]::after { background: var(--nzc-orange); }
/* attention chips and strips: the warn tone is the website's orange */
.nzc .nz-badge[data-tone="warn"], .nzc .nz-banner[data-tone="warn"], .nzc-method-soon { background: var(--nzc-orange-soft); color: var(--nzc-orange-text); border-color: transparent; }
/* progress: meters are orange, and the largest row of a bar list */
.nzc .nz-meter { accent-color: var(--nzc-orange-strong); }
.nzc .nz-bars li:first-child .nz-bar > span { background: var(--nzc-orange-grad); }


/* ==========================================================================================================================================================
 * NUZM SIGNATURE — one identity for every "start" screen of the console: the AI builder start, domain search and email (and any page built on
 * .ld-hero / .bl-hero). The Blog / Community / Documentation field (mint light + dotted texture), the home page's light-weight headline, one pill with a beige tag, one glass prompt box, one
 * orange send button, one sage chip. Values are the home page's own (landing.css), in dark and light. Screens keep their layout; only the identity is shared.
 * ======================================================================================================================================================== */
.nzc {
  /* the Blog / Community / Documentation field: a soft mint light from the top and a dotted texture that fades out */
  --sig-glow: radial-gradient(60% 80% at 50% -10%, color-mix(in srgb, #bcdccb 22%, transparent), transparent 70%);
  --sig-dot: rgba(188, 220, 203, 0.12);
  --sig-ink: #ffffff;
  --sig-sub: #cbd7d2;
  --sig-pill: rgba(255, 255, 255, 0.06);
  --sig-pill-ink: #efebe4;
  --sig-tag: linear-gradient(135deg, #f5e9d6, #d9c7a6);
  --sig-tag-ink: #34434d;
  --sig-box: rgba(32, 37, 41, 0.93);
  --sig-box-edge: rgba(255, 255, 255, 0.07);
  --sig-box-shadow: 0 15px 45px rgba(0, 0, 0, 0.13);
  --sig-send: linear-gradient(145deg, #f8ccaa, #e9a16d);
  --sig-send-ink: #352a23;
  --sig-chip: #22282a;
  --sig-chip-ink: #c5d8ce;
  --sig-chip-on: color-mix(in srgb, #bcdccb 16%, #22282a);
  --sig-weight: 450;
}
.nzc[data-theme="light"] {
  --sig-glow: radial-gradient(60% 80% at 50% -10%, color-mix(in srgb, #93b6b3 26%, transparent), transparent 70%);
  --sig-dot: rgba(88, 112, 121, 0.16);
  --sig-ink: #203e37;
  --sig-sub: #475d54;
  --sig-pill: rgba(255, 255, 255, 0.6);
  --sig-pill-ink: #365249;
  --sig-box: rgba(255, 255, 255, 0.95);
  --sig-box-edge: rgba(56, 91, 73, 0.1);
  --sig-box-shadow: 0 16px 50px rgba(56, 91, 73, 0.13);
  --sig-chip: #e2ebe1;
  --sig-chip-ink: #35594c;
  --sig-chip-on: #d3e4d8;
}
/* the shared field replaces each screen's own glow */
.nzc :is(.ld-hero, .bl-hero) { isolation: isolate; background: var(--sig-glow), var(--nzc-bg); border-color: transparent; }
.nzc .ld-hero { background: var(--sig-glow), var(--nzc-card); }
.nzc :is(.ld-glow, .bl-glow) { display: none; }
.nzc :is(.ld-hero, .bl-hero)::before { content: ''; position: absolute; inset: 0; z-index: -1; background: radial-gradient(circle, var(--sig-dot) 1.3px, transparent 1.8px) 0 0 / 22px 22px; -webkit-mask-image: radial-gradient(70% 80% at 50% 20%, #000 20%, transparent 75%); mask-image: radial-gradient(70% 80% at 50% 20%, #000 20%, transparent 75%); pointer-events: none; }
/* headline and subtitle */
.nzc :is(.ld-title, .bl-title) { color: var(--sig-ink); font-weight: var(--sig-weight); letter-spacing: -0.01em; line-height: 1.2; }
html[lang='ar'] .nzc :is(.ld-title, .bl-title) { letter-spacing: 0; line-height: 1.3; }
.nzc :is(.ld-sub, .bl-sub) { color: var(--sig-sub); }
/* the pill: like the home page's announcement, its first item (the icon) is the beige tag */
.nzc :is(.ld-brand, .bl-brand) { gap: 8px; padding-block: 4px; padding-inline: 4px 12px; border: 0; border-radius: 99px; background: var(--sig-pill); color: var(--sig-pill-ink); font-size: 12.5px; font-weight: 600; }
.nzc :is(.ld-brand, .bl-brand) > :first-child { display: inline-grid; place-items: center; box-sizing: content-box; inline-size: 14px; block-size: 14px; padding: 4px 8px; border-radius: 99px; background: var(--sig-tag); color: var(--sig-tag-ink); }
/* the glass prompt box */
.nzc :is(.ld-card, .bl-prompt) { border: 1px solid var(--sig-box-edge); border-radius: 18px; background: var(--sig-box); backdrop-filter: blur(20px); box-shadow: var(--sig-box-shadow); }
.nzc :is(.ld-card, .bl-prompt):focus-within { border-color: color-mix(in srgb, var(--nzc-accent) 55%, transparent); box-shadow: var(--sig-box-shadow), 0 0 0 3px color-mix(in srgb, var(--nzc-accent) 18%, transparent); }
.nzc .bl-input { background: transparent; }
/* the send button */
.nzc :is(.ld-go, .bl-go) { border-radius: 12px; background: var(--sig-send); color: var(--sig-send-ink); box-shadow: none; }
.nzc a.ld-go, .nzc a.ld-go:hover { color: var(--sig-send-ink); }
/* choices (extensions, project types) are the home page's chips, a little larger */
.nzc :is(.ld-tld, .bl-type) { border-color: transparent; border-radius: 14px; background: var(--sig-chip); }
.nzc :is(.ld-tld, .bl-type):hover { border-color: color-mix(in srgb, var(--nzc-accent) 35%, transparent); }
.nzc :is(.ld-tld, .bl-type):has(input:checked) { border-color: color-mix(in srgb, var(--nzc-accent) 60%, transparent); background: var(--sig-chip-on); box-shadow: none; }
.nzc :is(.ld-tld-hint, .bl-type-text small) { color: var(--sig-chip-ink); }
.nzc :is(.ld-label, .bl-label) { color: var(--sig-sub); }
.nzc .bl-type-icon { background: color-mix(in srgb, var(--nzc-accent) 14%, transparent); }

/* ---------- the workspace chat, in the signature: glass composer, quiet tools, orange send, sage chips ---------- */
.nzc .bld-chat-title { display: flex; align-items: center; gap: 8px; padding: 16px 18px 6px; color: var(--sig-sub, var(--nzc-muted)); font-size: 12.5px; font-weight: 650; letter-spacing: 0.02em; }
.nzc .bld-chat-scroll { gap: 16px; padding-inline: 16px; }
.nzc .bld-msg[data-role='user'] { padding: 10px 14px; border-radius: 18px 18px 6px 18px; background: var(--sig-chip, var(--nzc-elev)); }
html[dir='rtl'] .nzc .bld-msg[data-role='user'] { border-radius: 18px 18px 18px 6px; }
.nzc .bld-msg-body { font-size: 14px; line-height: 1.7; }
.nzc .bld-msg-head strong { font-size: 13.5px; font-weight: 700; letter-spacing: 0; }
.bld-msg-atts { display: flex; flex-wrap: wrap; gap: 6px; }
.bld-msg-att { display: inline-flex; align-items: center; gap: 5px; max-inline-size: 100%; padding: 3px 9px; border-radius: 999px; background: color-mix(in srgb, var(--nzc-fg) 7%, transparent); color: var(--nzc-muted); font-size: 11.5px; }
.bld-msg-att bdi { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-inline-size: 220px; }
.nzc .bld-composer { padding: 0 14px 14px; }
.nzc .bld-composer-box { display: grid; gap: 6px; padding: 10px 10px 8px; border: 1px solid var(--sig-box-edge, var(--nzc-border)); border-radius: 18px; background: var(--sig-box, var(--nzc-card-hi)); box-shadow: var(--sig-box-shadow, none); backdrop-filter: blur(20px); }
.nzc .bld-composer-box:focus-within { border-color: color-mix(in srgb, var(--nzc-accent) 55%, transparent); box-shadow: var(--sig-box-shadow, none), 0 0 0 3px color-mix(in srgb, var(--nzc-accent) 16%, transparent); }
.nzc .bld-composer-input { min-block-size: 56px; max-block-size: 40vh; padding: 4px 6px; font-size: 14.5px; line-height: 1.6; }
.nzc .bld-composer-foot { justify-content: flex-start; gap: 4px; }
.bcx-spacer { flex: 1; }
.bcx-icon-btn { display: grid; place-items: center; flex: none; inline-size: 34px; block-size: 34px; border: 0; border-radius: 10px; background: transparent; color: var(--nzc-muted); cursor: pointer; transition: background 0.12s ease, color 0.12s ease; }
.bcx-icon-btn:hover:not(:disabled), .bcx-icon-btn[aria-expanded='true'] { background: var(--sig-chip, var(--nzc-elev)); color: var(--nzc-fg); }
.bcx-icon-btn:disabled { opacity: 0.4; cursor: default; }
.bcx-mic[aria-pressed='true'] { background: color-mix(in srgb, var(--nzc-orange) 22%, transparent); color: var(--nzc-orange-text); }
.bcx-engine { display: inline-flex; align-items: center; gap: 6px; block-size: 30px; margin-inline-start: 2px; padding-inline: 8px 10px; border: 0; border-radius: 999px; background: var(--sig-chip, var(--nzc-elev)); color: var(--sig-chip-ink, var(--nzc-fg)); font: inherit; font-size: 12.5px; font-weight: 650; cursor: pointer; }
.bcx-engine:hover, .bcx-engine[aria-expanded='true'] { background: var(--sig-chip-on, var(--nzc-card-hi)); color: var(--nzc-fg); }
.bcx-engine img { block-size: 12px; inline-size: auto; }
.nzc[data-theme='light'] .bcx-engine img { filter: brightness(0.62) saturate(1.3); }
.bcx-engine > .nzc-icon { transform: rotate(90deg); opacity: 0.7; }
.nzc .bld-send { inline-size: 36px; block-size: 36px; border-radius: 12px; background: var(--sig-send, var(--nzc-orange-grad)); color: var(--sig-send-ink, var(--nzc-orange-ink)); transition: transform 0.12s ease, opacity 0.12s ease; }
.nzc .bld-send:hover:not(:disabled) { transform: translateY(-1px); }
.bcx-icon-btn:focus-visible, .bcx-engine:focus-visible, .bcx-chip-x:focus-visible, .bcx-item:focus-visible, .nzc .bld-send:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 2px; }
/* attachments waiting to be sent */
.bcx-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 2px 2px 4px; list-style: none; }
.bcx-chip { display: inline-flex; align-items: center; gap: 8px; max-inline-size: 100%; padding-block: 5px; padding-inline: 6px 4px; border-radius: 12px; background: var(--sig-chip, var(--nzc-field)); animation: bl-pop 0.14s ease-out; }
.bcx-chip-icon { display: grid; place-items: center; flex: none; inline-size: 26px; block-size: 26px; border-radius: 8px; background: color-mix(in srgb, var(--nzc-accent) 18%, transparent); color: var(--nzc-accent); }
.bcx-chip[data-kind='url'] .bcx-chip-icon { background: var(--nzc-orange-soft); color: var(--nzc-orange-text); }
.bcx-chip-text { display: grid; min-inline-size: 0; }
.bcx-chip-text b { overflow: hidden; max-inline-size: 180px; font-size: 12.5px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.bcx-chip-text small { color: var(--nzc-muted); font-size: 11px; }
.bcx-chip-x { display: grid; place-items: center; flex: none; inline-size: 22px; block-size: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--nzc-muted); cursor: pointer; }
.bcx-chip-x:hover { background: color-mix(in srgb, var(--nzc-fg) 8%, transparent); color: var(--nzc-fg); }
/* dictation state */
.bcx-live { display: inline-flex; align-items: center; gap: 6px; padding-inline: 6px; color: var(--nzc-orange-text); font-size: 12px; font-weight: 650; }
.bcx-live i { inline-size: 8px; block-size: 8px; border-radius: 50%; background: var(--nzc-orange); animation: bcx-pulse 1.1s ease-in-out infinite; }
.bcx-live-err { color: var(--nzc-danger); }
@keyframes bcx-pulse { 0%, 100% { opacity: 0.35; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.15); } }
@media (prefers-reduced-motion: reduce) { .bcx-live i { animation: none; } }
/* the composer's menus (attach, assistant), drawn on the page above the button */
.bcx-pop { position: fixed; z-index: 90; display: grid; gap: 2px; inline-size: min(300px, 86vw); padding: 8px; border: 1px solid var(--nzc-border); border-radius: 16px; background: var(--nzc-card); box-shadow: var(--nzc-shadow); animation: bl-pop 0.14s ease-out; }
.bcx-pop-title { margin: 4px 8px 6px; color: var(--nzc-muted); font-size: 11.5px; font-weight: 650; }
.bcx-pop-note { margin: 6px 8px 2px; color: var(--nzc-muted); font-size: 11.5px; line-height: 1.5; }
.bcx-item { display: flex; align-items: center; gap: 10px; inline-size: 100%; padding: 8px; border: 0; border-radius: 10px; background: transparent; color: var(--nzc-fg); font: inherit; text-align: start; cursor: pointer; }
.bcx-item:hover:not(:disabled) { background: var(--nzc-card-hi); }
.bcx-item:disabled { opacity: 0.55; cursor: not-allowed; }
.bcx-item > .nzc-icon { flex: none; color: var(--nzc-accent); }
.bcx-item-icon { display: grid; place-items: center; flex: none; inline-size: 32px; block-size: 32px; border-radius: 10px; background: color-mix(in srgb, var(--nzc-accent) 14%, var(--nzc-field)); color: var(--nzc-accent); }
.bcx-item[data-tone='warm'] .bcx-item-icon { background: var(--nzc-orange-soft); color: var(--nzc-orange-text); }
.bcx-item-text { display: grid; flex: 1; gap: 2px; min-inline-size: 0; }
.bcx-item-text b { font-size: 13.5px; font-weight: 650; }
.bcx-item-text small { color: var(--nzc-muted); font-size: 11.5px; line-height: 1.4; }
.bcx-link-form { display: flex; gap: 6px; padding: 4px; }
.nzc .bcx-link-form input { flex: 1; min-inline-size: 0; min-block-size: 36px !important; padding-inline: 10px !important; border-radius: 10px !important; font-size: 13px !important; }
.bcx-link-form button { flex: none; padding: 0 14px; border: 0; border-radius: 10px; background: var(--sig-send, var(--nzc-orange-grad)); color: var(--sig-send-ink, var(--nzc-orange-ink)); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
.bcx-link-form button:disabled { opacity: 0.5; cursor: default; }
.bld-composer-note { margin: 6px 6px 0; color: var(--nzc-warn); font-size: 12px; line-height: 1.5; }
/* the keyboard hint stays at full strength: at opacity .8 its muted text fell to 4.04:1 (axe color-contrast, WCAG AA needs 4.5) */
.bcx-keys { opacity: 1; }

/* the composer as one compact row (attach · words · send · microphone), with a quiet status line under it */
.nzc .bld-composer-box { padding: 6px; border-radius: 18px; }
.bcx-line { display: flex; align-items: flex-end; gap: 4px; }
.nzc .bcx-line .bld-composer-input { flex: 1; min-inline-size: 0; min-block-size: 36px !important; max-block-size: 30vh; padding: 7px 6px !important; border: 0 !important; background: transparent !important; box-shadow: none !important; resize: none; overflow-wrap: anywhere; word-break: break-word; overflow-x: hidden; font-size: 14.5px !important; line-height: 1.5; }
/* the chat column never scrolls sideways: long words wrap inside the box and the bubbles */
.nzc .bws-chat, .nzc .bld-chat, .nzc .bld-composer, .nzc .bld-composer-box, .bcx-line { min-inline-size: 0; }
.nzc .bws-chat { overflow-x: hidden; }
.nzc .bcx-line .bld-send, .bcx-line .bcx-icon-btn { inline-size: 36px; block-size: 36px; }
.bcx-meta { display: flex; align-items: center; justify-content: flex-end; gap: 14px; padding: 8px 6px 0; color: var(--nzc-muted); font-size: 12.5px; }
.bcx-meta-type { color: var(--nzc-muted); }
.nzc .bcx-engine { block-size: auto; margin: 0; padding: 2px 0; border-radius: 6px; background: transparent; color: var(--nzc-fg); font-size: 12.5px; font-weight: 600; }
.nzc .bcx-engine:hover, .nzc .bcx-engine[aria-expanded='true'] { background: transparent; color: var(--nzc-accent); }
.bcx-ring { flex: none; inline-size: 14px; block-size: 14px; box-sizing: border-box; border: 2px solid color-mix(in srgb, var(--nzc-orange) 70%, transparent); border-radius: 50%; }
.bcx-ring[data-active] { border-color: var(--nzc-orange); border-block-start-color: transparent; animation: bcx-spin 0.9s linear infinite; }
@keyframes bcx-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .bcx-ring[data-active] { animation: none; border-block-start-color: var(--nzc-orange); } }
.nzc .bld-composer-help { margin: 6px 6px 0; font-size: 11px; opacity: 0.85; }

/* ---------- the dashboard, simple: one column (welcome, build invitation, attention and resources, services, activity) ---------- */
.nzc-home { display: grid; gap: 22px; inline-size: min(100%, 1180px); margin-inline: auto; padding-block-end: 32px; }
.nzc-home > .nzc-home-welcome { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 10px; margin: 0; }
.nzc-home > .nzc-home-welcome h1 { margin: 0; color: var(--sig-ink, var(--nzc-fg)); font-size: clamp(24px, 2.4vw, 32px); font-weight: var(--sig-weight, 500); }
.nzc-home > .nzc-home-welcome > span { display: inline-flex; align-items: center; gap: 8px; color: var(--nzc-muted); font-size: 13px; }
.nzc a.nzc-home-start { position: relative; isolation: isolate; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 18px; padding: clamp(20px, 3vw, 30px); overflow: hidden; border: 1px solid var(--sig-box-edge, var(--nzc-border)); border-radius: 22px; background: var(--sig-glow, none), var(--nzc-card); color: var(--nzc-fg); text-decoration: none; transition: border-color 0.15s ease; }
.nzc a.nzc-home-start::before { content: ''; position: absolute; inset: 0; z-index: -1; background: radial-gradient(circle, var(--sig-dot, transparent) 1.3px, transparent 1.8px) 0 0 / 22px 22px; -webkit-mask-image: radial-gradient(70% 90% at 50% 0%, #000 20%, transparent 75%); mask-image: radial-gradient(70% 90% at 50% 0%, #000 20%, transparent 75%); pointer-events: none; }
.nzc a.nzc-home-start:hover { border-color: color-mix(in srgb, var(--nzc-accent) 45%, transparent); }
.nzc-home-start-text { display: grid; gap: 6px; max-inline-size: 60ch; }
.nzc-home-start-text small { color: var(--nzc-orange-text); font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
html[lang='ar'] .nzc-home-start-text small { letter-spacing: 0; text-transform: none; font-size: 12.5px; }
.nzc-home-start-text strong { color: var(--sig-ink, var(--nzc-fg)); font-size: clamp(22px, 2.3vw, 30px); font-weight: var(--sig-weight, 500); }
.nzc-home-start-text span { color: var(--sig-sub, var(--nzc-muted)); font-size: 14px; line-height: 1.6; }
.nzc-home-start-go { display: inline-flex; align-items: center; gap: 12px; padding: 7px; padding-inline-end: 8px; border-radius: 16px; background: linear-gradient(145deg, #cfe8da, #93b6b3); color: #1b2c29; box-shadow: 0 6px 18px rgba(20, 40, 36, 0.22); transition: filter 0.15s ease, transform 0.15s ease; }
.nzc a.nzc-home-start:hover .nzc-home-start-go { filter: brightness(1.04); transform: translateY(-1px); }
.nzc-home-start-go > strong { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
.nzc-home-start-mark, .nzc-home-start-arrow { display: grid; place-items: center; flex: none; inline-size: 44px; block-size: 44px; border-radius: 12px; background: rgba(20, 40, 36, 0.1); }
.nzc-home-start-arrow { inline-size: 36px; block-size: 36px; border-radius: 10px; }
.nzc-home-start-mark img { block-size: 22px; inline-size: auto; filter: brightness(0); opacity: 0.85; }
@media (prefers-reduced-motion: reduce) { .nzc-home-start-go { transition: none; } .nzc a.nzc-home-start:hover .nzc-home-start-go { transform: none; } }
html[dir='rtl'] .nzc-home-start-arrow .nzc-icon { transform: scaleX(-1); }
/* attention (only when something needs it) and the resources, side by side */
.nzc-status[data-layout='row'] { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; align-items: stretch; }
.nzc-status[data-layout='row']:has(> .nzc-status-attention) { grid-template-columns: minmax(0, 1fr) minmax(0, 1.55fr); }
/* bento: attention is the tall card on the start side; the resources stack beside it as compact rows (count and "View all" at the end) */
.nzc-status[data-layout='row'] > .nzc-status-attention { grid-row: span 3; align-content: start; gap: 14px; padding: 20px; }
.nzc-status[data-layout='row'] > .nzc-status-attention ul { display: grid; gap: 8px; }
.nzc-status[data-layout='row']:has(> .nzc-status-attention) > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) { grid-column: 2; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 14px; row-gap: 4px; padding: 14px 16px; }
.nzc-status[data-layout='row']:has(> .nzc-status-attention) > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) > header { grid-column: 1; }
.nzc-status[data-layout='row']:has(> .nzc-status-attention) > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) > :is(p, ul) { grid-column: 1; margin: 0; padding-inline-start: 46px; }
.nzc-status[data-layout='row']:has(> .nzc-status-attention) > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) > .nzc-status-all { grid-column: 2; grid-row: 1 / span 2; align-self: center; }
@media (max-width: 1100px) { .nzc-status[data-layout='row'] { grid-template-columns: repeat(2, minmax(0, 1fr)); } .nzc-status[data-layout='row']:has(> .nzc-status-attention) { grid-template-columns: minmax(0, 1fr); } .nzc-status[data-layout='row'] > .nzc-status-attention { grid-row: auto; } .nzc-status[data-layout='row']:has(> .nzc-status-attention) > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) { grid-column: 1; } }
@media (max-width: 600px) { .nzc-status[data-layout='row'], .nzc-status[data-layout='row']:has(> .nzc-status-attention) { grid-template-columns: minmax(0, 1fr); } }
.nzc-status[data-layout='row'] > .nzc-status-title { grid-column: 1 / -1; margin: 0; }
/* attention is one card among the others (not a full-width band) */
.nzc-status[data-layout='row'] > .nzc-status-card { align-content: start; }
.nzc-home-section { display: grid; gap: 12px; }
.nzc-home-section h2, .nzc-status[data-layout='row'] > .nzc-status-title { color: var(--nzc-muted); font-size: 12.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
html[lang='ar'] :is(.nzc-home-section h2, .nzc-status[data-layout='row'] > .nzc-status-title) { letter-spacing: 0; text-transform: none; font-size: 13.5px; }
.nzc-home-section h2 { margin: 0; }
.nzc-home-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.nzc-home-section-head a { color: var(--nzc-accent); font-size: 13px; text-decoration: none; }
/* recent activity: a tall card at the end of the top row (attention | resources | activity) */
.nzc-status[data-layout='row']:has(> .nzc-status-activity) { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); grid-auto-flow: row dense; }
.nzc-status[data-layout='row']:has(> .nzc-status-attention):has(> .nzc-status-activity) { grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1fr); }
.nzc-status[data-layout='row'] > :is(.nzc-status-attention, .nzc-status-activity) { grid-row: 2 / span 3; align-content: start; gap: 14px; padding: 20px; }
.nzc-status[data-layout='row'] > .nzc-status-attention { grid-column: 1; }
.nzc-status[data-layout='row'] > .nzc-status-activity { grid-column: -2 / -1; grid-template-rows: auto 1fr auto; }
.nzc-status[data-layout='row']:has(> .nzc-status-activity):not(:has(> .nzc-status-attention)) > .nzc-status-card:not(.nzc-status-activity) { grid-column: 1; }
.nzc-status[data-layout='row']:has(> .nzc-status-attention):has(> .nzc-status-activity) > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) { grid-column: 2; }
/* the resources sit compact (one line each) whenever a tall card is beside them */
.nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) { grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 14px; row-gap: 4px; padding: 14px 16px; }
.nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) > header { grid-column: 1; }
.nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) > :is(p, ul) { grid-column: 1; margin: 0; padding-inline-start: 46px; }
.nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) > .nzc-status-all { grid-column: 2; grid-row: 1 / span 2; align-self: center; }
.nzc-status-activity ul { display: grid; align-content: start; gap: 0; margin: 0; padding: 0; list-style: none; }
.nzc-status-activity li { display: flex; align-items: flex-start; gap: 10px; padding-block: 9px; border-block-end: 1px solid var(--nzc-border); }
.nzc-status-activity li:last-child { border-block-end: 0; }
.nzc-status-activity li > .nzc-status-dot { margin-block-start: 6px; background: var(--nzc-accent); }
.nzc-status-activity .nzc-status-text { display: grid; gap: 2px; min-inline-size: 0; font-size: 13.5px; line-height: 1.45; }
.nzc-status-activity .nzc-status-text > :first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nzc-status-activity time { color: var(--nzc-muted); font-size: 11.5px; }
.nzc-status-activity > .nzc-status-all { align-self: end; }
@media (max-width: 1100px) {
  .nzc-status[data-layout='row']:has(> .nzc-status-activity), .nzc-status[data-layout='row']:has(> .nzc-status-attention):has(> .nzc-status-activity) { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .nzc-status[data-layout='row']:has(> .nzc-status-attention):has(> .nzc-status-activity) > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) { grid-column: 1 / -1; }
  .nzc-status[data-layout='row']:has(> .nzc-status-attention):has(> .nzc-status-activity) > :is(.nzc-status-attention, .nzc-status-activity) { grid-row: auto; grid-column: auto; }
}
@media (max-width: 700px) {
  .nzc-status[data-layout='row']:has(> .nzc-status-activity), .nzc-status[data-layout='row']:has(> .nzc-status-attention):has(> .nzc-status-activity) { grid-template-columns: minmax(0, 1fr); }
  .nzc-status[data-layout='row'] > :is(.nzc-status-attention, .nzc-status-activity), .nzc-status[data-layout='row'] > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) { grid-row: auto; grid-column: 1 !important; }
}
/* The home fits the screen: the page itself never scrolls; the cards fill the space left under the banner and each scrolls inside itself when its
   list grows. Only where there is room (wide and tall enough); smaller screens keep the normal page scroll. */
@media (min-width: 1101px) and (min-height: 600px) {
  .nzc-body:has(> .nzc-home) { display: flex; flex-direction: column; overflow: hidden; padding-block-end: 22px; }
  .nzc-home { flex: 1; min-block-size: 0; grid-template-rows: auto auto minmax(0, 1fr); padding-block-end: 0; }
  .nzc-home > .nzc-status[data-layout='row'] { min-block-size: 0; grid-template-rows: auto repeat(3, minmax(0, 1fr)); }
  .nzc-home > .nzc-status[data-layout='row'] > .nzc-status-card { min-block-size: 0; overflow: hidden; }
  .nzc-home > .nzc-status[data-layout='row'] > .nzc-status-card > ul { min-block-size: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--nzc-muted) 40%, transparent) transparent; }
  .nzc-home > .nzc-status[data-layout='row'] > .nzc-status-attention { grid-template-rows: auto minmax(0, 1fr); }
  .nzc-home > .nzc-status[data-layout='row'] > .nzc-status-activity { grid-template-rows: auto minmax(0, 1fr) auto; }
  .nzc-home > .nzc-status[data-layout='row'] > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) { grid-template-rows: auto minmax(0, 1fr); align-items: start; }
  .nzc-home > .nzc-status[data-layout='row'] > .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) > ul { max-block-size: 100%; }
}
/* Opening and closing AI Studio (StudioTransition keeps the animation for those two moments only). The dashboard's Nuzm AI button and the studio share one
   name, so the browser grows the button into the studio on the way in and shrinks the studio back into the button on the way out; from anywhere else the
   studio rises in and sinks away on its own. Never under "reduce motion". */
@media (prefers-reduced-motion: no-preference) {
  @view-transition { navigation: auto; }
  .nzc-home-start-go, .bl, .bws { view-transition-name: nuzm-studio; }
  ::view-transition-group(nuzm-studio) { animation-duration: 520ms; animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1); border-radius: 18px; overflow: hidden; }
  ::view-transition-old(nuzm-studio), ::view-transition-new(nuzm-studio) { block-size: 100%; inline-size: 100%; object-fit: cover; animation-duration: 520ms; animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1); }
  ::view-transition-new(nuzm-studio):only-child { animation: nzc-studio-in 460ms cubic-bezier(0.22, 1, 0.36, 1) both; }
  ::view-transition-old(nuzm-studio):only-child { animation: nzc-studio-out 300ms cubic-bezier(0.4, 0, 1, 1) both; }
  ::view-transition-old(root) { animation: nzc-studio-fade-out 260ms ease both; }
  ::view-transition-new(root) { animation: nzc-studio-fade-in 380ms ease 80ms both; }
}
@keyframes nzc-studio-in { from { opacity: 0; transform: translateY(18px) scale(0.97); } to { opacity: 1; transform: none; } }
@keyframes nzc-studio-out { to { opacity: 0; transform: translateY(12px) scale(0.98); } }
@keyframes nzc-studio-fade-out { to { opacity: 0; } }
@keyframes nzc-studio-fade-in { from { opacity: 0; } }

/* ---------- The organization page: a header, quick links, then its parts ---------- */
.nzc-orgp { display: grid; gap: 18px; inline-size: min(100%, 1180px); margin-inline: auto; }
.nzc-orgp-hero { position: relative; isolation: isolate; display: flex; flex-wrap: wrap; align-items: center; gap: 18px 22px; padding: clamp(20px, 3vw, 28px); overflow: hidden; border: 1px solid var(--sig-box-edge, var(--nzc-border)); border-radius: 22px; background: var(--sig-glow, none), var(--nzc-card); }
.nzc-orgp-hero::before { content: ''; position: absolute; inset: 0; z-index: -1; background: radial-gradient(circle, var(--sig-dot, transparent) 1.3px, transparent 1.8px) 0 0 / 22px 22px; -webkit-mask-image: radial-gradient(70% 90% at 50% 0%, #000 20%, transparent 75%); mask-image: radial-gradient(70% 90% at 50% 0%, #000 20%, transparent 75%); pointer-events: none; }
.nzc-orgp-avatar { display: grid; place-items: center; flex: none; inline-size: 58px; block-size: 58px; border-radius: 18px; background: linear-gradient(145deg, #cfe8da, #93b6b3); color: #1b2c29; font-size: 24px; font-weight: 700; }
.nzc-orgp-id { display: grid; flex: 1; gap: 6px; min-inline-size: 220px; }
.nzc-orgp-id h1 { margin: 0; color: var(--sig-ink, var(--nzc-fg)); font-size: clamp(22px, 2.2vw, 28px); font-weight: var(--sig-weight, 500); }
.nzc-orgp-id p { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0; color: var(--sig-sub, var(--nzc-muted)); font-size: 13.5px; }
.nzc-orgp-stats { display: flex; gap: 10px; margin: 0; }
.nzc-orgp-stats > div { display: grid; gap: 2px; min-inline-size: 96px; padding: 10px 14px; border-radius: 14px; background: color-mix(in srgb, var(--nzc-field) 80%, transparent); }
.nzc-orgp-stats dt { color: var(--nzc-muted); font-size: 11.5px; }
.nzc-orgp-stats dd { margin: 0; color: var(--nzc-fg); font-size: 18px; font-weight: 650; }
.nzc-orgp-nav { position: sticky; inset-block-start: -30px; z-index: 3; display: flex; gap: 6px; padding: 6px; overflow-x: auto; scrollbar-width: none; border-radius: 14px; background: color-mix(in srgb, var(--nzc-card) 92%, transparent); backdrop-filter: blur(10px); }
.nzc .nzc-orgp-nav a { display: inline-flex; flex: none; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 10px; color: var(--nzc-muted); font-size: 13.5px; font-weight: 600; text-decoration: none; }
.nzc .nzc-orgp-nav a:hover { background: var(--sig-chip-on, var(--nzc-card-hi)); color: var(--nzc-fg); }
.nzc .nzc-orgp-nav a:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 1px; }
.nzc-orgp .nzc-stack-section { scroll-margin-block-start: 64px; border-radius: 20px; padding: 22px; }
.nzc-orgp .nzc-stack-head .nz-h2, .nzc-team .nzc-stack-head .nz-h2 { font-size: 17px; font-weight: 650; }
@media (max-width: 760px) { .nzc-orgp-stats { inline-size: 100%; } .nzc-orgp-stats > div { flex: 1; min-inline-size: 0; } }

/* workspaces, each a card holding its projects */
.nzc-orgws { display: grid; gap: 14px; }
.nzc-orgws-new, .nzc-orgws-add, .nzc-audit-search { display: flex; align-items: center; gap: 8px; }
.nzc-orgws-new input, .nzc-orgws-add input, .nzc-audit-search input { flex: 1; min-inline-size: 0; block-size: 40px; padding-inline: 14px; border: 1px solid var(--nzc-border); border-radius: 12px; background: var(--nzc-field); color: var(--nzc-fg); font: inherit; font-size: 14px; }
.nzc-orgws-new { max-inline-size: 520px; }
.nzc-orgws-new input:focus-visible, .nzc-orgws-add input:focus-visible, .nzc-audit-search input:focus-visible { outline: 2px solid var(--nzc-accent); outline-offset: 1px; }
.nzc-orgws-new button, .nzc-orgws-add button, .nzc-audit-search button { display: inline-flex; flex: none; align-items: center; gap: 6px; block-size: 40px; padding-inline: 16px; border: 0; border-radius: 12px; background: linear-gradient(145deg, #cfe8da, #93b6b3); color: #1b2c29; font: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer; }
.nzc-orgws-new button:disabled, .nzc-orgws-add button:disabled { opacity: 0.6; cursor: default; }
.nzc-orgws-add input { block-size: 34px; font-size: 13px; }
.nzc-orgws-add button { block-size: 34px; padding-inline: 12px; background: var(--nzc-field); color: var(--nzc-fg); font-weight: 600; }
.nzc-orgws-add button:hover { background: var(--nzc-card-hi); }
.nzc-orgws-none, .nzc-orgws-empty { margin: 0; color: var(--nzc-muted); font-size: 13.5px; }
.nzc-orgws-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; }
.nzc-orgws-card { display: grid; grid-template-rows: auto 1fr auto; gap: 12px; min-inline-size: 0; padding: 16px; border-radius: 16px; background: var(--nzc-field); }
.nzc-orgws-card > header { display: flex; align-items: center; gap: 12px; }
.nzc-orgws-icon { display: grid; place-items: center; flex: none; inline-size: 36px; block-size: 36px; border-radius: 11px; background: color-mix(in srgb, var(--nzc-accent) 16%, transparent); color: var(--nzc-accent); }
.nzc-orgws-title { display: grid; flex: 1; gap: 2px; min-inline-size: 0; }
.nzc-orgws-title strong { overflow: hidden; font-size: 15px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.nzc-orgws-title small { color: var(--nzc-muted); font-size: 12px; }
.nzc-orgws-del { display: grid; place-items: center; flex: none; inline-size: 28px; block-size: 28px; border: 0; border-radius: 8px; background: transparent; color: var(--nzc-muted); cursor: pointer; }
.nzc-orgws-del:hover { background: var(--nzc-danger-soft); color: var(--nzc-danger); }
.nzc-orgws-del:focus-visible { outline: 2px solid var(--nzc-accent); }
.nzc-orgws-projects { display: grid; align-content: start; gap: 2px; margin: 0; padding: 0; list-style: none; }
.nzc-orgws-projects li { display: flex; align-items: center; gap: 4px; }
.nzc .nzc-orgws-projects a { display: flex; flex: 1; align-items: center; gap: 10px; min-inline-size: 0; padding: 8px 10px; border-radius: 10px; color: var(--nzc-fg); font-size: 13.5px; text-decoration: none; }
.nzc .nzc-orgws-projects a > span:nth-child(2) { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nzc .nzc-orgws-projects a > .nzc-icon { color: var(--nzc-muted); }
.nzc .nzc-orgws-projects a:hover { background: var(--nzc-card); }
html[dir='rtl'] .nzc-orgws-projects a > .nzc-icon { transform: scaleX(-1); }
.nzc-orgws-dot { flex: none; inline-size: 7px; block-size: 7px; border-radius: 50%; background: var(--nzc-orange); }

/* the audit log: a timeline grouped by day */
.nzc-audit-search { position: relative; max-inline-size: 560px; margin-block-end: 16px; }
.nzc-audit-search > .nzc-icon { position: absolute; inset-inline-start: 13px; color: var(--nzc-muted); pointer-events: none; }
.nzc-audit-search input { padding-inline-start: 38px; }
.nzc-audit { display: grid; gap: 18px; }
.nzc-audit-day h3 { display: flex; align-items: baseline; gap: 10px; margin: 0 0 8px; color: var(--nzc-fg); font-size: 14px; font-weight: 650; }
.nzc-audit-day h3 span { color: var(--nzc-muted); font-size: 12px; font-weight: 500; }
.nzc-audit-day ol { margin: 0; padding: 0; list-style: none; border-radius: 16px; background: var(--nzc-field); }
.nzc-audit-day li { position: relative; display: flex; align-items: center; gap: 14px; padding: 12px 16px; }
.nzc-audit-day li + li { border-block-start: 1px solid var(--nzc-border); }
.nzc-audit-dot { flex: none; inline-size: 9px; block-size: 9px; border-radius: 50%; background: var(--nzc-accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--nzc-accent) 18%, transparent); }
.nzc-audit-day li:not([data-outcome='success']) .nzc-audit-dot { background: var(--nzc-danger); box-shadow: 0 0 0 4px var(--nzc-danger-soft); }
.nzc-audit-main { display: grid; flex: 1; gap: 4px; min-inline-size: 0; }
.nzc-audit-main p { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; font-size: 14px; }
.nzc-audit-main p > :last-child::first-letter { text-transform: uppercase; }
.nzc-audit-area { padding: 1px 8px; border-radius: 999px; background: var(--nzc-orange-soft); color: var(--nzc-orange-text); font-size: 11.5px; font-weight: 700; }
.nzc-audit-main small { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--nzc-muted); font-size: 12px; }
.nzc-audit-main code { padding: 1px 6px; border-radius: 6px; background: var(--nzc-card); font-size: 11.5px; }
.nzc-audit-side { display: flex; flex: none; align-items: center; gap: 12px; }
.nzc-audit-side time { min-inline-size: 44px; color: var(--nzc-muted); font-size: 12.5px; text-align: end; font-variant-numeric: tabular-nums; }
@media (max-width: 600px) { .nzc-audit-day li { flex-wrap: wrap; } .nzc-audit-side { inline-size: 100%; justify-content: space-between; padding-inline-start: 23px; } }

/* ---------- Team: members as a list, the invitation form in one line ---------- */
.nzc-members { display: grid; margin: 0; padding: 0; list-style: none; border-radius: 16px; background: var(--nzc-field); }
.nzc-members > li { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 14px 16px; }
.nzc-members > li + li { border-block-start: 1px solid var(--nzc-border); }
.nzc-members-avatar { display: grid; place-items: center; flex: none; inline-size: 40px; block-size: 40px; border-radius: 50%; background: linear-gradient(145deg, #cfe8da, #93b6b3); color: #1b2c29; font-weight: 700; }
.nzc-members-who { display: grid; flex: 1; gap: 2px; min-inline-size: 180px; }
.nzc-members-who strong { display: flex; align-items: center; gap: 8px; font-size: 14.5px; font-weight: 650; }
.nzc-members-who small, .nzc-members-joined small { color: var(--nzc-muted); font-size: 12.5px; }
.nzc-members-you { padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, var(--nzc-accent) 16%, transparent); color: var(--nzc-accent); font-size: 11px; font-weight: 700; }
.nzc-members-joined { display: grid; gap: 2px; min-inline-size: 150px; font-size: 13px; }
.nzc-members-role { flex: none; }
.nzc-members-role .nz-row { margin: 0; flex-wrap: nowrap; align-items: center; }
.nzc-members-role .nz-field-label, .nzc-members-role label { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); }
.nzc-stack-section#invitations > form .nz-row, .nzc-stack-section#invitations > form.nz-row { align-items: end; }
.nzc-stack-section :is(#members, #invitations, #apikeys) .nz-state { padding-block: 22px; }
.nzc-stack-section .nz-state { padding-block: 24px; }
.kni { display: grid; gap: 16px; }
.kni .nz-card { display: grid; gap: 12px; align-content: start; }
.kni .nz-h2, .kni .nz-h3 { margin: 0; }
.kni-toolbar { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: end; }
.kni-toolbar > * { min-inline-size: min(100%, 200px); }
.kni-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px 20px; margin: 0; }
.kni-facts dt { color: var(--nzc-muted); }
.kni-facts dd { margin: 0; overflow-wrap: anywhere; }
.kni-list { margin: 0; padding-inline-start: 20px; display: grid; gap: 6px; }
.kni-log { margin: 0; padding: 10px 12px; max-block-size: 260px; overflow: auto; border: 1px solid var(--nzc-border); border-radius: 10px; background: var(--nzc-field); font-size: 0.85em; list-style: none; display: grid; gap: 4px; }
.kni-log li { display: grid; grid-template-columns: max-content max-content 1fr; gap: 8px; align-items: baseline; }
.kni-pad { padding-block: 8px; }
.kd-swatches { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 12px; }
.kd-swatch { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--nzc-border); border-radius: 10px; background: var(--nzc-field); overflow-wrap: anywhere; }
.kr-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.kr-cand { display: grid; gap: 6px; padding: 12px; border: 1px solid var(--nzc-border); border-radius: 10px; background: var(--nzc-field); overflow-wrap: anywhere; }
.kr-score { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kr-bar { inline-size: min(100%, 220px); block-size: 10px; accent-color: var(--nzc-accent, currentColor); }
.kd-chip { flex: none; inline-size: 36px; block-size: 36px; border-radius: 8px; border: 1px solid var(--nzc-border); background: repeating-conic-gradient(var(--nzc-border) 0% 25%, transparent 0% 50%) 50% / 12px 12px; }

/* ==========================================================================================================================================================
 * SIGN IN / SIGN UP — the website's identity: the mint field with a dotted texture, one glass card, light headline, orange pill button, sage chips.
 * The brand panel keeps its place; the form side becomes one calm card. Works in dark and light, Arabic (RTL) and English.
 * ======================================================================================================================================================== */
.nzc-split {
  position: relative;
  background:
    radial-gradient(60% 55% at 28% -8%, color-mix(in srgb, #bcdccb 20%, transparent), transparent 70%),
    radial-gradient(circle at 1px 1px, rgba(188, 220, 203, 0.10) 1px, transparent 1.4px) 0 0 / 22px 22px,
    var(--nzc-bg);
}
.nzc[data-theme='light'] .nzc-split {
  background:
    radial-gradient(60% 55% at 28% -8%, color-mix(in srgb, #bcdccb 38%, transparent), transparent 70%),
    radial-gradient(circle at 1px 1px, rgba(52, 67, 77, 0.07) 1px, transparent 1.4px) 0 0 / 22px 22px,
    var(--nzc-bg);
}
/* the brand panel: deeper teal, the same dotted field, light headline with the sage second tone */
.nzc-split-panel {
  background:
    radial-gradient(60% 38% at 24% 6%, rgba(255, 255, 255, 0.5), transparent 72%),
    radial-gradient(circle at 1px 1px, rgba(255, 255, 255, 0.10) 1px, transparent 1.4px) 0 0 / 22px 22px,
    linear-gradient(180deg, #cfe8da 0%, #93b6b3 20%, #587079 48%, #34434d 72%, #14181b 100%);
  box-shadow: 0 30px 60px -30px rgba(0, 0, 0, 0.6);
}
.nzc-split-headline { font-weight: 500; letter-spacing: -0.035em; }
.nzc-split-list li {
  background: rgba(10, 16, 20, 0.34);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
.nzc-split-list li > i { background: var(--nzc-orange-grad); color: var(--nzc-orange-ink); font-weight: 700; }
.nzc-split-list li[data-state='current'] { background: #f4f0e8; }
.nzc-split-list li[data-state='current'] > i { background: #14181b; color: #f4f0e8; }
.nzc-split-list li[data-state='done'] > i { background: #bcdccb; color: #14181b; }

/* the language switch: a small pill */
.nzc-split-top > * { padding: 8px 14px; border-radius: 999px; background: var(--nzc-field); color: var(--nzc-fg); font-size: 14px; font-weight: 600; text-decoration: none; }

/* the form card */
.nzc-split-card {
  position: relative;
  inline-size: min(100%, 460px);
  padding: 38px 36px 34px;
  gap: 18px;
  border-radius: 30px;
  background:
    radial-gradient(90% 60% at 50% -18%, color-mix(in srgb, #bcdccb 14%, transparent), transparent 72%),
    color-mix(in srgb, var(--nzc-card) 90%, transparent);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 30px 70px -34px rgba(0, 0, 0, 0.7);
}
.nzc[data-theme='light'] .nzc-split-card { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 30px 70px -40px rgba(52, 67, 77, 0.35); }
.nzc-split-card h1 { font-size: clamp(26px, 2.4vw, 34px); font-weight: 500; letter-spacing: -0.035em; line-height: 1.15; }
.nzc-split-card h1::after { content: ''; display: block; inline-size: 32px; block-size: 3px; margin: 12px auto 0; border-radius: 3px; background: var(--nzc-orange); }
.nzc-split-card-sub { margin: 0 0 6px; line-height: 1.6; }
.nzc-split-card form { gap: 16px; }
.nzc-split-card .nz-field { margin: 0; gap: 8px; }
.nzc-split-card .nz-field label { font-size: 13.5px; font-weight: 600; color: var(--nzc-muted); }
.nzc-split-card :is(input, select) {
  min-block-size: 52px;
  padding-inline: 16px;
  border: 1px solid transparent;
  border-radius: 16px;
  background: var(--nzc-field);
  color: var(--nzc-fg);
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}
.nzc-split-card .nzc-pw input { padding-inline-end: 56px; }
.nzc-split-card :is(input, select):hover { background: color-mix(in srgb, var(--nzc-field) 80%, var(--nzc-fg) 6%); }
.nzc-split-card :is(input, select):focus-visible {
  outline: none;
  border-color: color-mix(in srgb, #93b6b3 70%, transparent);
  box-shadow: 0 0 0 4px color-mix(in srgb, #93b6b3 22%, transparent);
}
/* the main action: the website's orange pill; the provider button: a quiet pill */
.nzc-split-card .nz-btn { min-block-size: 52px; border-radius: 999px; font-size: 15.5px; font-weight: 700; }
.nzc-split-card .nz-btn:not([data-variant='secondary']):not([data-variant='ghost']) { box-shadow: 0 14px 28px -14px rgba(233, 161, 109, 0.7); transition: transform 0.15s ease, filter 0.15s ease; }
.nzc-split-card .nz-btn:not([data-variant='secondary']):not([data-variant='ghost']):hover { transform: translateY(-1px); filter: brightness(1.04); }
.nzc-split-card .nz-btn:active { transform: scale(0.985); }
.nzc-split-card .nz-btn[data-variant='secondary'] { background: var(--nzc-field); color: var(--nzc-fg); box-shadow: none; }
.nzc-split-card .nz-btn[data-variant='secondary']:hover { background: var(--nzc-card-hi, var(--nzc-field)); }
.nzc-split-links { line-height: 1.7; }
.nzc-split-links a { color: var(--nzc-fg); font-weight: 650; text-decoration: none; border-block-end: 1px solid color-mix(in srgb, var(--nzc-orange) 70%, transparent); }
.nzc-split-links a:hover { color: var(--nzc-orange-text, var(--nzc-orange)); }
.nzc-or { text-transform: none; }
.nzc-split-back { border-radius: 999px; background: var(--nzc-field); color: var(--nzc-muted); }
.nzc-split-back:hover, .nzc-split-back:focus-visible { color: var(--nzc-fg); background: var(--nzc-card-hi, var(--nzc-field)); }
@media (max-width: 900px) {
  .nzc-split-card { padding: 28px 22px 26px; border-radius: 26px; }
}
@media (prefers-reduced-motion: reduce) {
  .nzc-split-card .nz-btn, .nzc-split-card :is(input, select) { transition: none; }
}

/* ==========================================================================================================================================================
 * RESOURCE CARDS (the shared Table in card view: domains, servers, websites, databases, buckets, mailboxes, projects…) and "Manage" as a text link.
 * One calm card: a soft top light, a larger title, quiet details, a hairline above the footer, and "Manage →" as orange text (no button).
 * ======================================================================================================================================================== */
.nzc .nz-table-wrap[data-view="cards"] tbody tr {
  position: relative;
  border-radius: 26px;
  background:
    radial-gradient(90% 60% at 18% -12%, color-mix(in srgb, #bcdccb 11%, transparent), transparent 70%),
    var(--nzc-card);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 7%, transparent);
  transition: background-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
}
.nzc[data-theme='light'] .nz-table-wrap[data-view="cards"] tbody tr {
  background:
    radial-gradient(90% 60% at 18% -12%, color-mix(in srgb, #bcdccb 30%, transparent), transparent 70%),
    var(--nzc-card);
  box-shadow: inset 0 1px 0 #fff, 0 1px 2px rgba(52, 67, 77, 0.06);
}
.nzc .nz-table-wrap[data-view="cards"] tbody tr:hover { transform: translateY(-2px); box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 9%, transparent), 0 18px 36px -22px rgba(0, 0, 0, 0.55); }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] tbody tr { padding: 22px 22px 18px; gap: 4px 8px; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="title"] { font-size: 19px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.25; overflow-wrap: anywhere; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] .nz-card-icon > span { border-radius: 15px; background: color-mix(in srgb, var(--nzc-fg) 8%, transparent); color: var(--nzc-fg); }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="meta"] { font-size: 13px; line-height: 1.55; }
/* a hairline between the details and the footer row (the card's last line: the date or value on one side, "Manage →" on the other) */
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] tbody tr::after {
  block-size: 1px;
  margin-block: 14px 10px;
  background: color-mix(in srgb, var(--nzc-fg) 9%, transparent);
}
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td[data-card="footer"] .nz-cell-value { font-size: 14px; font-weight: 650; }
.nzc .nz-table-wrap[data-view="cards"][data-card="rich"] td.nz-manage-col { align-self: center; }

/* "Manage →": orange text and an arrow, nothing else */
.nzc .nz-manage-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 2px;
  border: 0;
  background: none;
  color: var(--nzc-orange-text);
  font: inherit;
  font-size: 14px;
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
.nzc .nz-manage-link .nzc-icon { transition: transform 0.16s ease; }
.nzc .nz-manage-link:hover .nzc-icon, .nzc .nz-manage-link:focus-visible .nzc-icon { transform: translateX(3px); }
[dir='rtl'] .nzc .nz-manage-link .nzc-icon { transform: scaleX(-1); }
[dir='rtl'] .nzc .nz-manage-link:hover .nzc-icon, [dir='rtl'] .nzc .nz-manage-link:focus-visible .nzc-icon { transform: scaleX(-1) translateX(3px); }
.nzc .nz-manage-link:hover { text-decoration: underline; text-underline-offset: 4px; }
.nzc .nz-manage-link:focus-visible { outline: 2px solid var(--nzc-orange-text); outline-offset: 3px; border-radius: 6px; }
/* in a plain (non-rich) card the link sits at the card's bottom edge; in the classic table it is a plain link in its column */
.nzc .nz-table-wrap[data-view="cards"] td.nz-manage-col { padding-block-start: 12px; }
@media (prefers-reduced-motion: reduce) {
  .nzc .nz-manage-link .nzc-icon, .nzc .nz-table-wrap[data-view="cards"] tbody tr { transition: none; }
}

/* ==========================================================================================================================================================
 * DOMAIN SEARCH as a landing screen: before a search, the page is exactly one screen (no scrolling): the search hero fills it and its parts scale with the
 * window height. With results, the page scrolls as usual.
 * ======================================================================================================================================================== */
.nzc .ds-page[data-state='landing'] { display: flex; flex-direction: column; gap: 8px; block-size: calc(100dvh - 180px); min-block-size: 0; overflow: hidden; }
.nzc .ds-page[data-state='landing'] .nzc-back { flex: none; align-self: flex-start; }
.nzc .ds-page[data-state='landing'] .ld-hero { flex: 1 1 0; min-block-size: 0; padding: 0 24px; }
.nzc .ds-page[data-state='landing'] .ld-inner { gap: clamp(8px, 1.9dvh, 18px); }
.nzc .ds-page[data-state='landing'] .ld-title { font-size: clamp(26px, 6.4dvh, 56px); }
.nzc .ds-page[data-state='landing'] .ld-sub { font-size: clamp(13px, 1.9dvh, 16px); margin: 0; }
.nzc .ds-page[data-state='landing'] .ld-tld { padding-block: clamp(8px, 1.4dvh, 14px); }
@media (max-height: 760px) { .nzc .ds-page[data-state='landing'] .ld-art, .nzc .ds-page[data-state='landing'] .ld-note { display: none; } }
@media (max-height: 620px) { .nzc .ds-page[data-state='landing'] .ld-sub, .nzc .ds-page[data-state='landing'] .ld-brand { display: none; } }
@media (max-width: 900px) { .nzc .ds-page[data-state='landing'] { block-size: auto; overflow: visible; } .nzc .ds-page[data-state='landing'] .ld-hero { padding: 28px 16px; } }

/* ==========================================================================================================================================================
 * DASHBOARD RESOURCES (Servers, Domains, Websites): each card is a header (icon, name, count, "View all →" as orange text) over a roomy list of
 * RECTANGULAR rows at the full width of the card. The list shows only the rows that fit whole (no half-cut row, no inner scrolling); "View all" / "+N more" opens the rest.
 * ======================================================================================================================================================== */
.nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) > header > .nzc-status-all {
  padding: 2px 4px; border-radius: 6px; background: none; color: var(--nzc-orange-text); font-size: 13px; font-weight: 700; white-space: nowrap;
}
.nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) > header > .nzc-status-all:hover { background: none; text-decoration: underline; text-underline-offset: 4px; }
.nzc-status[data-layout='row'] .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) {
  grid-template-columns: minmax(0, 1fr) !important; align-items: start; row-gap: 10px; padding: 16px 18px !important;
}
.nzc-status[data-layout='row'] .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) > :is(p, ul) { grid-column: 1 !important; padding-inline-start: 0 !important; }
.nzc-status[data-layout='row'] .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) > ul { display: flex; flex-direction: column; flex-wrap: wrap; align-content: flex-start; gap: 6px; overflow: hidden !important; }
.nzc-status[data-layout='row'] .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) li { flex: none; inline-size: 100%; }
.nzc-status[data-layout='row'] .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) li a {
  min-block-size: 44px; padding: 10px 14px; border-radius: 8px;
  background: color-mix(in srgb, var(--nzc-fg) 5%, transparent);
  border-inline-start: 3px solid var(--nzc-muted);
}
.nzc-status[data-layout='row'] .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) li a:has(.nzc-status-dot[data-tone='ok']) { border-inline-start-color: var(--nzc-success); }
.nzc-status[data-layout='row'] .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) li a:has(.nzc-status-dot[data-tone='warn']) { border-inline-start-color: var(--nzc-orange); }
.nzc-status[data-layout='row'] .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) li a:has(.nzc-status-dot[data-tone='bad']) { border-inline-start-color: var(--nzc-danger); }
.nzc-status[data-layout='row'] .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) li .nzc-status-dot { display: none; }
.nzc-status[data-layout='row'] .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) li a:hover { background: color-mix(in srgb, var(--nzc-fg) 9%, transparent); }
.nzc-status[data-layout='row'] .nzc-status-card:not(.nzc-status-attention, .nzc-status-activity) li small { font-size: 12.5px; }

/* ==========================================================================================================================================================
 * DASHBOARD LAYOUT (wide screens): the three resources side by side in one row (Servers | Domains | Websites), then "Needs attention" and
 * "Recent activity" in a second row. Narrower screens keep the stacked layout above.
 * ======================================================================================================================================================== */
@media (min-width: 1101px) {
  .nzc-status[data-layout='row']:has(> .nzc-status-activity) { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; grid-auto-flow: row; }
  .nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-title { grid-column: 1 / -1 !important; grid-row: 1 !important; }
  .nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-card[data-kind='servers'] { grid-column: 1 !important; grid-row: 2 !important; }
  .nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-card[data-kind='domains'] { grid-column: 2 !important; grid-row: 2 !important; }
  .nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-card[data-kind='sites'] { grid-column: 3 !important; grid-row: 2 !important; }
  .nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-attention { grid-column: 1 / span 2 !important; grid-row: 3 !important; }
  .nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-activity { grid-column: 3 !important; grid-row: 3 !important; }
  .nzc-status[data-layout='row']:has(> .nzc-status-activity):not(:has(> .nzc-status-attention)) > .nzc-status-activity { grid-column: 1 / -1 !important; }
  /* the attention items sit in two columns when there is the width for it */
  .nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-attention > ul { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-attention { padding: 18px 20px; gap: 12px; }
}
@media (min-width: 1101px) and (min-height: 600px) {
  .nzc-home > .nzc-status[data-layout='row']:has(> .nzc-status-activity) { grid-template-rows: auto minmax(0, 1.1fr) minmax(0, 1fr); }
  /* the second row shows whole items only too (what does not fit is on the full page behind "View all") */
  .nzc-home > .nzc-status[data-layout='row'] > :is(.nzc-status-attention, .nzc-status-activity) > ul { display: flex !important; flex-direction: column; flex-wrap: wrap; align-content: flex-start; overflow: hidden !important; min-block-size: 0; }
  .nzc-home > .nzc-status[data-layout='row'] > .nzc-status-attention > ul > li { flex: none; inline-size: calc(50% - 4px); }
  .nzc-home > .nzc-status[data-layout='row'] > .nzc-status-activity > ul > li { flex: none; inline-size: 100%; }
}

/* ==========================================================================================================================================================
 * DASHBOARD RESOURCES, NESTED: Servers, Domains and Websites are inner cards inside ONE shared panel (the panel is the outer card; each resource is a card within it).
 * ======================================================================================================================================================== */
.nzc-status-group {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; padding: 12px; min-inline-size: 0; min-block-size: 0; overflow: hidden;
  border-radius: 30px; background: color-mix(in srgb, var(--nzc-fg) 6%, transparent);
}
.nzc-status-group > .nzc-status-card { min-block-size: 0; border-radius: 20px; background: var(--nzc-card); }
.nzc-status-group > .nzc-status-card { grid-template-rows: auto minmax(0, 1fr); }
.nzc-status-group > .nzc-status-card > ul { min-block-size: 0; align-self: stretch; }
.nzc[data-theme="light"] .nzc-status-group > .nzc-status-card { background: #ffffff; }
.nzc-status[data-layout='row'] > .nzc-status-group { grid-column: 1 / -1; }
@media (min-width: 1101px) {
  .nzc-status[data-layout='row']:has(> .nzc-status-activity) > .nzc-status-group { grid-column: 1 / -1 !important; grid-row: 2 !important; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: minmax(0, 1fr); }
}

/* ==========================================================================================================================================================
 * WEBSITE PAGE: insights first (four facts + what needs attention), tools with the reason when one is unavailable, plan limits, and the delete form tucked away.
 * ======================================================================================================================================================== */
.nzc-insights { display: grid; gap: 14px; margin-block-end: 26px; }
.nzc-insights-head { display: grid; gap: 4px; }
.nzc-insights-head p { margin: 0; font-size: 14px; }
.nzc-insight-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.nzc-insight { display: grid; align-content: start; gap: 8px; padding: 16px 18px; border-radius: 20px; background: var(--nzc-card); min-block-size: 112px; }
.nzc-insight .nzc-quota-value { font-size: 20px; }
.nzc-insight small { font-size: 12.5px; }
.nzc-attn { padding: 14px 18px; border-radius: 20px; background: color-mix(in srgb, var(--nzc-fg) 4%, var(--nzc-card)); display: grid; gap: 6px; }
.nzc-attn p { margin: 0; font-size: 13.5px; }
.nzc-attn ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.nzc-attn li { display: flex; align-items: center; gap: 10px; font-size: 14px; line-height: 1.5; }
.nzc-attn li[data-tone='warn'] .nzc-icon { color: var(--nzc-orange-text); }
.nzc-attn li[data-tone='danger'] .nzc-icon { color: var(--nzc-danger); }
.nzc-attn-ok { display: flex; align-items: center; gap: 8px; color: var(--nzc-success); }
.nzc-danger-zone { margin-block-start: 26px; padding: 12px 16px; border-radius: 18px; background: color-mix(in srgb, var(--nzc-danger) 7%, transparent); }
.nzc-danger-zone > summary { cursor: pointer; font-weight: 650; font-size: 14px; color: var(--nzc-danger); }
.nzc-danger-zone[open] > summary { margin-block-end: 12px; }
.nzc-danger-zone .nz-card { background: transparent; padding: 0; }
.nzc-res-note { margin: -6px 0 12px; font-size: 13px; }

/* WEBSITE PAGE, second design: a header, one Insights block (attention, key numbers, every limit), tile grids for what you can open and for tools, no side column. */
.nzc-site-hero { display: grid; gap: 14px; padding: 22px 24px; margin-block-end: 22px; border-radius: 24px; background: var(--nzc-card); }
.nzc-site-hero-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.nzc-site-hero-main h2 { margin: 0; font-size: clamp(22px, 2.4vw, 30px); letter-spacing: -0.02em; }
.nzc-site-facts { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px 22px; }
.nzc-site-facts dt { font-size: 12px; color: var(--nzc-muted); margin-block-end: 3px; }
.nzc-site-facts dd { margin: 0; font-size: 14.5px; font-weight: 600; overflow-wrap: anywhere; }
.nzc-site-hero > .nz-btn { justify-self: start; display: inline-flex; align-items: center; gap: 8px; }
.nzc-insights { margin-block-end: 26px; }
.nzc-insight .nzc-quota-label { display: flex; align-items: center; gap: 6px; }
.nzc-limit-chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px; }
.nzc-limit-chips li { display: flex; align-items: baseline; gap: 8px; padding: 8px 14px; border-radius: 999px; background: color-mix(in srgb, var(--nzc-fg) 5%, transparent); font-size: 13px; }
.nzc-limit-chips span { color: var(--nzc-muted); }
.nzc-site-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; margin-block-end: 26px; }
.nzc-site-tile { display: grid; align-content: start; gap: 8px; padding: 20px; border-radius: 22px; background: var(--nzc-card); color: var(--nzc-fg); text-decoration: none; transition: background 0.15s ease, transform 0.15s ease; }
.nzc-site-tile:hover { background: color-mix(in srgb, var(--nzc-orange) 8%, var(--nzc-card)); transform: translateY(-2px); }
.nzc-site-tile:focus-visible { outline: 2px solid var(--nzc-orange-text); outline-offset: 3px; }
.nzc-site-tile strong { font-size: 16px; }
.nzc-site-tile .nz-muted { font-size: 13.5px; line-height: 1.55; }
.nzc-site-tile-ico { display: grid; place-items: center; inline-size: 44px; block-size: 44px; border-radius: 14px; background: color-mix(in srgb, var(--nzc-orange) 14%, var(--nzc-field)); color: var(--nzc-orange-text); }
.nzc-site-tile-go { display: inline-flex; align-items: center; gap: 6px; margin-block-start: 4px; color: var(--nzc-orange-text); font-weight: 700; font-size: 13.5px; }
html[dir='rtl'] .nzc-site-tile-go .nzc-icon { transform: scaleX(-1); }
.nzc-tool-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.nzc-tool-tile { display: grid; align-content: start; justify-items: start; gap: 6px; padding: 16px 18px; border-radius: 18px; background: color-mix(in srgb, var(--nzc-fg) 3%, transparent); border: 1px dashed color-mix(in srgb, var(--nzc-fg) 16%, transparent); }
.nzc-tool-tile .nzc-site-tile-ico { inline-size: 38px; block-size: 38px; background: color-mix(in srgb, var(--nzc-fg) 7%, transparent); color: var(--nzc-muted); }
.nzc-tool-tile strong { font-size: 14.5px; }
.nzc-tool-tile .nz-muted { font-size: 13px; line-height: 1.5; }
a.nzc-tool-tile { color: inherit; text-decoration: none; border-style: solid; transition: border-color .15s, background .15s; }
a.nzc-tool-tile:hover, a.nzc-tool-tile:focus-visible { border-color: color-mix(in srgb, var(--nzc-fg) 40%, transparent); background: color-mix(in srgb, var(--nzc-fg) 6%, transparent); }
a.nzc-tool-tile .nzc-site-tile-ico { color: var(--nzc-fg); }
.nzc-tool-tile[aria-disabled="true"] { opacity: .8; }
.nzc-log { margin: 12px 0; padding: 14px 16px; max-block-size: 60vh; overflow: auto; border-radius: 14px; background: color-mix(in srgb, var(--nzc-fg) 5%, transparent); font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; direction: ltr; text-align: start; }
.nzc-editor { inline-size: 100%; min-block-size: 320px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; direction: ltr; text-align: start; }
.nzc-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 10px 0; }
.nz-linkbtn { background: none; border: 0; padding: 0; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }
`;
