import { createRequire } from 'node:module';
import type { QaContext } from './context';
import type { QaFinding } from './types';

/**
 * axe-core (WCAG 2.1 A/AA rules) over every locale page, run on jsdom's DOM with scripts DISABLED (the page's own JS never executes; only axe's source is evaluated in
 * the throw-away window). Honest limits, reported in the gate metrics: jsdom has no layout engine, so the rules that need rendering (`color-contrast`, `target-size`,
 * `scrollable-region-focusable`, visibility-dependent ones) cannot run here; colour contrast is decided from the design tokens by the renderer's palette (every
 * text/background pair is held to 4.5:1 and checked in `contrastGate`), and a rendered check belongs to the browser E2E (P3-S08). Both `axe-core` and `jsdom` are
 * optional at load time: when they cannot be resolved the gate is `skipped` (never a pass).
 */
interface AxeResult {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl?: string;
  nodes: { html: string; target: unknown[]; failureSummary?: string }[];
}
interface AxeApi {
  source: string;
  run(ctx: unknown, opts: unknown): Promise<{ violations: AxeResult[]; incomplete: AxeResult[] }>;
}
interface JsdomApi {
  VirtualConsole: new () => unknown;
  JSDOM: new (
    html: string,
    opts: Record<string, unknown>,
  ) => { window: Record<string, unknown> & { close(): void; eval(s: string): unknown } };
}

export const AXE_DISABLED_RULES = [
  'color-contrast', // needs layout; see contrastGate
  'color-contrast-enhanced',
  'target-size',
  'scrollable-region-focusable',
  'link-in-text-block', // needs computed colours
  'region', // a static page with <main> and landmarks; the "all content in landmarks" best practice is advisory
];

export interface AxeLoad {
  axe: AxeApi;
  jsdom: JsdomApi;
  version: string;
}
export function loadAxe(): AxeLoad | { error: string } {
  try {
    const req = createRequire(__filename);
    const axe = req('axe-core') as AxeApi & { version?: string };
    const jsdom = req('jsdom') as JsdomApi;
    return { axe, jsdom, version: axe.version ?? 'unknown' };
  } catch (e) {
    return { error: (e as Error).message.split('\n')[0] ?? 'axe-core or jsdom is not installed' };
  }
}

export async function axeGate(
  c: QaContext,
  load: AxeLoad,
): Promise<{ findings: QaFinding[]; metrics: Record<string, number | string> }> {
  const findings: QaFinding[] = [];
  let rules = 0;
  let incomplete = 0;
  for (const p of c.pages) {
    const dom = new load.jsdom.JSDOM(p.html, {
      // a console that goes nowhere: jsdom reports unimplemented browser APIs (canvas) there, and that noise is not a finding
      virtualConsole: new load.jsdom.VirtualConsole(),
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      url: 'https://site.invalid/',
    });
    try {
      dom.window.eval(load.axe.source);
      const axe = dom.window.axe as AxeApi;
      const doc = dom.window.document as unknown;
      const r = await axe.run(doc, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
        },
        rules: Object.fromEntries(AXE_DISABLED_RULES.map((id) => [id, { enabled: false }])),
        resultTypes: ['violations', 'incomplete'],
      });
      incomplete += r.incomplete.length;
      rules++;
      for (const v of r.violations)
        for (const n of v.nodes.slice(0, 3))
          findings.push({
            gate: 'a11y-axe',
            code: `a11y-axe.${v.id}`,
            // axe's own "minor"/"best-practice" findings are advisory; serious and critical fail the gate, moderate too (WCAG A/AA)
            severity: v.impact === 'minor' ? 'warning' : 'error',
            file: p.path,
            message: `${v.help}: ${n.html.replace(/\s+/g, ' ').slice(0, 140)}`,
            hint: (n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 220),
          });
    } finally {
      dom.window.close();
    }
  }
  return {
    findings,
    metrics: {
      axeVersion: load.version,
      pagesChecked: rules,
      needsReview: incomplete,
      engine: 'axe-core on jsdom (no layout: color-contrast, target-size not evaluated)',
    },
  };
}
