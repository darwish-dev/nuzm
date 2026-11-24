import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { ArtifactFile } from './artifact';
import { buildContext, defaultPolicy } from './context';
import type { QaFinding, QaOptions } from './types';

/**
 * Real-browser QA of an artifact: the files are served from a LOOPBACK server with the platform's response headers (strict CSP, nosniff, no cookies) and opened in Chrome
 * at a phone and a desktop width, in every locale. What a DOM-less check cannot decide is decided here:
 *   - axe-core WITH layout: colour contrast, target size, visibility-dependent rules (WCAG 2.1 A/AA);
 *   - the CSP as the browser enforces it: any `securitypolicyviolation`, any blocked or failed request, any console error is a finding;
 *   - RTL layout: Arabic pages compute `direction: rtl`, and the navigation runs right-to-left;
 *   - responsive: no horizontal scrolling at 375 px.
 * Needs Chrome and `playwright-core` + `@axe-core/playwright` (resolved from the working directory, the repository `e2e/` directory or `BROWSER_QA_MODULES`); when
 * they are missing the result says so and is NEVER a pass. It is a heavy step (a browser): callers (CI, the Master) run it deliberately, not unit tests.
 */
export interface BrowserQaResult {
  /** `ran`: every page was opened; `unavailable`: no browser tooling (reason says what) */
  status: 'ran' | 'unavailable';
  reason?: string;
  findings: QaFinding[];
  metrics: { pagesChecked: number; viewports: string; browser: string; axeVersion: string };
}

interface Pw {
  chromium: { launch(o: Record<string, unknown>): Promise<Browser> };
}
interface Browser {
  version(): string;
  newContext(o: Record<string, unknown>): Promise<Ctx>;
  close(): Promise<void>;
}
interface Ctx {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Page {
  goto(u: string, o?: Record<string, unknown>): Promise<{ status(): number } | null>;
  on(ev: string, fn: (a: never) => void): void;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  exposeFunction(n: string, fn: (...a: never[]) => void): Promise<void>;
  addInitScript(s: string): Promise<void>;
}

function resolveFrom(roots: string[], id: string): unknown {
  for (const r of roots) {
    try {
      return createRequire(path.join(r, 'noop.js'))(id);
    } catch {
      /* try the next root */
    }
  }
  return undefined;
}
function tools():
  { pw: Pw; AxeBuilder: new (o: { page: Page }) => AxeB; axeVersion: string } | string {
  const roots = [
    ...(process.env.BROWSER_QA_MODULES ? process.env.BROWSER_QA_MODULES.split(path.delimiter) : []),
    process.cwd(),
    path.resolve(process.cwd(), '../../e2e'),
    path.resolve(process.cwd(), 'e2e'),
  ];
  const pw = resolveFrom(roots, 'playwright-core') as Pw | undefined;
  const axe = resolveFrom(roots, '@axe-core/playwright') as
    | { AxeBuilder?: new (o: { page: Page }) => AxeB; default?: new (o: { page: Page }) => AxeB }
    | undefined;
  const AxeBuilder = axe?.AxeBuilder ?? axe?.default;
  if (!pw) return 'playwright-core could not be resolved';
  if (!AxeBuilder) return '@axe-core/playwright could not be resolved';
  const ver =
    (resolveFrom(roots, 'axe-core/package.json') as { version?: string } | undefined)?.version ??
    'bundled';
  return { pw, AxeBuilder, axeVersion: ver };
}
interface AxeB {
  withTags(t: string[]): AxeB;
  analyze(): Promise<{
    violations: {
      id: string;
      impact?: string | null;
      help: string;
      nodes: { html: string; failureSummary?: string }[];
    }[];
  }>;
}

function serve(files: ArtifactFile[], policy: string): Promise<{ server: Server; origin: string }> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const server = createServer((req, res) => {
    let p: string;
    try {
      p = decodeURIComponent((req.url ?? '/').split('?')[0]!).replace(/^\/+/, '');
    } catch {
      p = '..';
    }
    if (p === '' || p.endsWith('/')) p += 'index.html';
    const f = p.includes('..') ? undefined : byPath.get(p);
    if (!f) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const mime = p.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : p.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : p.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : p.endsWith('.svg')
            ? 'image/svg+xml'
            : p.endsWith('.xml')
              ? 'application/xml'
              : p.endsWith('.txt')
                ? 'text/plain; charset=utf-8'
                : 'application/octet-stream';
    res
      .writeHead(200, {
        'content-type': mime,
        'content-security-policy': policy,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      })
      .end(Buffer.from(f.bytes));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    );
  });
}

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

export async function runBrowserQa(
  files: ArtifactFile[],
  opts: QaOptions & { maxPages?: number } = {},
): Promise<BrowserQaResult> {
  const t = tools();
  const metrics = {
    pagesChecked: 0,
    viewports: VIEWPORTS.map((v) => `${v.name}:${v.width}`).join(','),
    browser: 'none',
    axeVersion: 'n/a',
  };
  if (typeof t === 'string') return { status: 'unavailable', reason: t, findings: [], metrics };
  const c = buildContext(files, opts);
  const policy = opts.policy ?? defaultPolicy(opts.formsOrigin);
  const findings: QaFinding[] = [];
  const f = (
    code: string,
    message: string,
    file: string,
    hint?: string,
    severity: 'error' | 'warning' = 'error',
  ): QaFinding => ({
    gate: 'a11y-axe',
    code: `browser.${code}`,
    severity,
    file,
    message,
    ...(hint ? { hint } : {}),
  });
  const { server, origin } = await serve(files, policy);
  let browser: Browser | undefined;
  try {
    try {
      browser = await t.pw.chromium.launch({ channel: 'chrome', headless: true });
    } catch (e) {
      return {
        status: 'unavailable',
        reason: `Chrome could not be launched: ${(e as Error).message.split('\n')[0]}`,
        findings: [],
        metrics,
      };
    }
    metrics.browser = `chrome ${browser.version()}`;
    metrics.axeVersion = t.axeVersion;
    const pages = c.pages.slice(0, opts.maxPages ?? 200);
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        javaScriptEnabled: true,
        bypassCSP: false,
      });
      try {
        for (const p of pages) {
          const page = await ctx.newPage();
          const seen: string[] = [];
          await page.addInitScript(
            `window.addEventListener('securitypolicyviolation', e => { (window.__csp = window.__csp || []).push(e.violatedDirective + ' ' + e.blockedURI); });`,
          );
          page.on('console', ((m: { type(): string; text(): string }) => {
            if (m.type() === 'error') seen.push(`console: ${m.text().slice(0, 160)}`);
          }) as never);
          page.on('pageerror', ((e: Error) =>
            seen.push(`script error: ${String(e.message).slice(0, 160)}`)) as never);
          page.on('response', ((r: { status(): number; url(): string }) => {
            if (r.status() >= 400) seen.push(`HTTP ${r.status()}: ${r.url().slice(0, 100)}`);
          }) as never);
          page.on('requestfailed', ((r: {
            url(): string;
            failure(): { errorText: string } | null;
          }) =>
            seen.push(
              `request failed: ${r.url().slice(0, 100)} (${r.failure()?.errorText ?? ''})`,
            )) as never);
          const url = `${origin}/${p.path}`;
          const resp = await page.goto(url, { waitUntil: 'load' });
          metrics.pagesChecked++;
          const where = `${p.path} @${vp.name}`;
          if (!resp || resp.status() !== 200)
            findings.push(f('status', `${where}: HTTP ${resp?.status() ?? 'none'}`, p.path));
          const csp = await page.evaluate<string[]>(
            () => (window as unknown as { __csp?: string[] }).__csp ?? [],
          );
          for (const v of csp)
            findings.push(
              f(
                'csp_violation',
                `${where}: the browser blocked ${v}`,
                p.path,
                'the page uses something the CSP forbids',
              ),
            );
          for (const s of seen) findings.push(f('runtime', `${where}: ${s}`, p.path));
          // responsive: nothing forces sideways scrolling
          const overflow = await page.evaluate<number>(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          if (overflow > 1)
            findings.push(
              f(
                'overflow',
                `${where}: the page is ${overflow}px wider than the viewport (horizontal scrolling)`,
                p.path,
                'let long words wrap and cap fixed widths',
              ),
            );
          // RTL: computed direction and navigation order
          const dir = await page.evaluate<string>(() => getComputedStyle(document.body).direction);
          const want = p.locale === 'ar' ? 'rtl' : 'ltr';
          if (dir !== want)
            findings.push(
              f('direction', `${where}: computed direction is ${dir}, expected ${want}`, p.path),
            );
          if (vp.name === 'desktop') {
            const order = await page.evaluate<number[]>(() =>
              Array.from(document.querySelectorAll('header nav ul a'))
                .slice(0, 6)
                .map((a) => Math.round(a.getBoundingClientRect().left))
                .filter((x, i, arr) => arr.indexOf(x) === i),
            );
            if (order.length >= 2) {
              const first = order[0]!;
              const last = order[order.length - 1]!;
              const rtlOrder = first > last;
              if ((want === 'rtl') !== rtlOrder)
                findings.push(
                  f(
                    'nav_order',
                    `${where}: the navigation runs ${rtlOrder ? 'right-to-left' : 'left-to-right'} on a ${want} page (link left edges: ${order.join(', ')})`,
                    p.path,
                    'use logical (start/end) layout',
                    'warning',
                  ),
                );
            }
          }
          // axe with layout
          const r = await new t.AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
          for (const v of r.violations)
            for (const n of v.nodes.slice(0, 3))
              findings.push({
                gate: 'a11y-axe',
                code: `browser.axe.${v.id}`,
                severity: v.impact === 'minor' ? 'warning' : 'error',
                file: p.path,
                message: `${where}: ${v.help}: ${n.html.replace(/\s+/g, ' ').slice(0, 140)}`,
                hint: (n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 200),
              });
          await (page as unknown as { close(): Promise<void> }).close();
        }
      } finally {
        await ctx.close();
      }
    }
    return { status: 'ran', findings, metrics };
  } finally {
    await browser?.close().catch(() => undefined);
    server.close();
  }
}
