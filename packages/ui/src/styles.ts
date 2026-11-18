/**
 * Base stylesheet. Logical properties ONLY (inline-start/end, block-start/end) so RTL works by `dir`, never by
 * overriding left/right; a test forbids physical properties. Touch targets are >= 44px (docs/13 §4).
 */
export const baseCss = `
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: var(--nuzm-font-sans); color: var(--nuzm-color-fg); background: var(--nuzm-color-bg); line-height: 1.6; }
a { color: var(--nuzm-color-accent); }
:focus-visible { outline: 3px solid var(--nuzm-color-focus); outline-offset: 2px; }
.nz-skip { position: absolute; inset-inline-start: -9999px; inset-block-start: 0; background: var(--nuzm-color-bg); padding: var(--nuzm-space-3); z-index: 10; }
.nz-skip:focus { inset-inline-start: var(--nuzm-space-2); }
.nz-shell { display: grid; grid-template-columns: 240px 1fr; grid-template-rows: auto 1fr; min-block-size: 100vh; }
.nz-top { grid-column: 1 / -1; display: flex; align-items: center; gap: var(--nuzm-space-4); padding: var(--nuzm-space-2) var(--nuzm-space-4); border-block-end: 1px solid var(--nuzm-color-border); background: var(--nuzm-color-surface); }
.nz-top .nz-grow { flex: 1; }
.nz-brand { font-weight: 700; text-decoration: none; color: var(--nuzm-color-fg); }
.nz-nav { padding: var(--nuzm-space-4); border-inline-end: 1px solid var(--nuzm-color-border); background: var(--nuzm-color-surface); }
.nz-nav ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--nuzm-space-1); }
.nz-nav a { display: flex; align-items: center; min-block-size: 44px; padding-inline: var(--nuzm-space-3); border-radius: var(--nuzm-radius-md); text-decoration: none; color: var(--nuzm-color-fg); }
.nz-nav a[aria-current="page"] { background: var(--nuzm-color-accent-soft); color: var(--nuzm-color-accent-strong); font-weight: 600; }
.nz-nav a:hover { background: var(--nuzm-color-hover); }
.nz-main { padding: var(--nuzm-space-6); min-inline-size: 0; }
.nz-h1 { margin: 0 0 var(--nuzm-space-4); font-size: 1.5rem; }
.nz-card { border: 1px solid var(--nuzm-color-border); border-radius: var(--nuzm-radius-md); padding: var(--nuzm-space-4); background: var(--nuzm-color-bg); }
.nz-grid { display: grid; gap: var(--nuzm-space-4); grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.nz-btn { display: inline-flex; align-items: center; justify-content: center; min-block-size: 44px; min-inline-size: 44px; padding-inline: var(--nuzm-space-4); border-radius: var(--nuzm-radius-md); border: 1px solid var(--nuzm-color-accent-strong); background: var(--nuzm-color-accent-strong); color: #fff; font: inherit; cursor: pointer; text-decoration: none; }
.nz-btn[data-variant="secondary"] { background: var(--nuzm-color-bg); color: var(--nuzm-color-accent-strong); }
.nz-btn[data-variant="danger"] { background: var(--nuzm-color-danger); border-color: var(--nuzm-color-danger); }
.nz-btn[disabled], .nz-btn[aria-disabled="true"] { opacity: .6; cursor: not-allowed; }
.nz-field { display: grid; gap: var(--nuzm-space-1); margin-block-end: var(--nuzm-space-3); }
.nz-field label { font-weight: 600; }
.nz-input { min-block-size: 44px; padding-inline: var(--nuzm-space-3); border: 1px solid var(--nuzm-color-border-strong); border-radius: var(--nuzm-radius-md); font: inherit; background: var(--nuzm-color-bg); color: var(--nuzm-color-fg); }
.nz-help, .nz-muted { color: var(--nuzm-color-muted); }
.nz-error-text { color: var(--nuzm-color-danger); }
.nz-sr-only { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.nz-table-wrap { overflow-x: auto; border: 1px solid var(--nuzm-color-border); border-radius: var(--nuzm-radius-md); }
.nz-table { inline-size: 100%; border-collapse: collapse; }
.nz-table caption { text-align: start; padding: var(--nuzm-space-3); font-weight: 600; }
.nz-table th, .nz-table td { text-align: start; padding: var(--nuzm-space-2) var(--nuzm-space-3); border-block-start: 1px solid var(--nuzm-color-border); vertical-align: top; }
.nz-table th { background: var(--nuzm-color-surface); font-weight: 600; }
.nz-badge { display: inline-block; padding: 2px var(--nuzm-space-2); border-radius: 999px; font-size: .85rem; border: 1px solid var(--nuzm-color-border-strong); }
.nz-badge[data-tone="success"] { background: #ecfdf3; color: #05603a; border-color: #05603a; }
.nz-badge[data-tone="danger"] { background: #fef3f2; color: #912018; border-color: #912018; }
.nz-badge[data-tone="warn"] { background: #fffaeb; color: #93370d; border-color: #93370d; }
.nz-state { text-align: center; padding: var(--nuzm-space-8) var(--nuzm-space-4); border: 1px dashed var(--nuzm-color-border-strong); border-radius: var(--nuzm-radius-md); }
.nz-state h2 { margin: 0 0 var(--nuzm-space-2); }
.nz-banner { padding: var(--nuzm-space-3) var(--nuzm-space-4); border-block-end: 1px solid; }
.nz-banner[data-tone="warn"] { background: #fffaeb; color: #93370d; border-color: #93370d; }
.nz-banner[data-tone="danger"] { background: #fef3f2; color: #912018; border-color: #912018; }
.nz-skeleton { display: block; block-size: 1em; margin-block: var(--nuzm-space-2); border-radius: var(--nuzm-radius-sm); background: var(--nuzm-color-border); }
.nz-row { display: flex; gap: var(--nuzm-space-3); align-items: center; flex-wrap: wrap; }
.nz-ltr { direction: ltr; unicode-bidi: isolate; display: inline-block; }
.nz-sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.nz-h2 { margin: 0 0 var(--nuzm-space-3); font-size: 1.15rem; }
.nz-grid { display: grid; gap: var(--nuzm-space-4); grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin-block: var(--nuzm-space-4); }
.nz-meter { inline-size: 100%; block-size: 14px; accent-color: var(--nuzm-color-fg); }
.nz-bars { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--nuzm-space-2); }
.nz-bars li { display: grid; grid-template-columns: minmax(7rem, 14rem) 1fr auto; gap: var(--nuzm-space-3); align-items: center; }
.nz-bars .nz-bar { block-size: 12px; background: var(--nuzm-color-border); border-radius: var(--nuzm-radius-sm); overflow: hidden; }
.nz-bars .nz-bar > span { display: block; block-size: 100%; background: var(--nuzm-color-fg); }
/* >>> M09 builder */
.bld-ws { display: grid; gap: var(--nuzm-space-4); grid-template-columns: minmax(260px, 1fr) minmax(0, 2fr) minmax(280px, 1fr); align-items: start; }
.bld-ws > section { min-inline-size: 0; }
.bld-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--nuzm-space-2); }
.bld-list .bld-list { padding-inline-start: var(--nuzm-space-3); }
.bld-msg { border: 1px solid var(--nuzm-color-border); border-radius: var(--nuzm-radius-md); padding: var(--nuzm-space-2) var(--nuzm-space-3); }
.bld-msg[data-role="user"] { background: var(--nuzm-color-accent-soft); }
.bld-frame-wrap { overflow: auto; border: 1px solid var(--nuzm-color-border); border-radius: var(--nuzm-radius-md); background: var(--nuzm-color-surface); padding: var(--nuzm-space-2); }
.bld-frame { display: block; margin-inline: auto; border: 0; block-size: 640px; background: #fff; }
.bld-pre { margin: 0; white-space: pre-wrap; overflow: auto; max-block-size: 360px; direction: ltr; text-align: start; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; background: var(--nuzm-color-surface); border: 1px solid var(--nuzm-color-border); border-radius: var(--nuzm-radius-md); padding: var(--nuzm-space-3); }
@media (max-width: 1180px) { .bld-ws { grid-template-columns: 1fr; } }
/* <<< M09 builder */
@media (max-width: 760px) { .nz-shell { grid-template-columns: 1fr; } .nz-nav { border-inline-end: 0; border-block-end: 1px solid var(--nuzm-color-border); } }
`;
