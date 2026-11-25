import { artifactManifest, type ArtifactFile } from './artifact';
import { axeGate, loadAxe } from './axe';
import { buildContext, type QaContext } from './context';
import {
  assetsGate,
  completenessGate,
  contrastGate,
  cspGate,
  formsGate,
  htmlGate,
  linksGate,
  rtlGate,
  seoGate,
  sizeGate,
  structureGate,
} from './gates';
import {
  ALL_GATES,
  type GateId,
  type GateResult,
  type QaFinding,
  type QaOptions,
  type QaReport,
} from './types';

const SYNC: Record<Exclude<GateId, 'a11y-axe'>, (c: QaContext) => QaFinding[]> = {
  structure: structureGate,
  html: htmlGate,
  links: linksGate,
  csp: cspGate,
  size: sizeGate,
  rtl: rtlGate,
  contrast: contrastGate,
  seo: seoGate,
  forms: formsGate,
  assets: assetsGate,
  completeness: completenessGate,
};

const result = (
  gate: GateId,
  findings: QaFinding[],
  t0: number,
  metrics: GateResult['metrics'] = {},
): GateResult => ({
  gate,
  status: findings.some((f) => f.severity === 'error') ? 'fail' : 'pass',
  findings,
  metrics,
  durationMs: Math.max(0, Math.round(performance.now() - t0)),
});

/**
 * Run the website QA gates over an artifact (a list of files). Pure with respect to the files (no network, no clock in the result's content), so the same artifact
 * gives the same findings. `qualified` is the only flag that may back a "QA passed" claim: it requires every requested gate to have RUN and none to have failed.
 */
export async function runWebsiteQa(files: ArtifactFile[], opts: QaOptions = {}): Promise<QaReport> {
  const c = buildContext(files, opts);
  const wanted = opts.gates ?? [...ALL_GATES];
  const results: GateResult[] = [];
  for (const g of wanted) {
    const t0 = performance.now();
    if (g === 'a11y-axe') {
      if (opts.axe === 'off') {
        results.push({
          gate: g,
          status: 'skipped',
          findings: [],
          metrics: { reason: 'disabled by the caller' },
          durationMs: 0,
        });
        continue;
      }
      const load = loadAxe();
      if ('error' in load) {
        const severe = opts.axe === 'require';
        results.push({
          gate: g,
          status: severe ? 'fail' : 'skipped',
          findings: severe
            ? [
                {
                  gate: g,
                  code: 'a11y-axe.unavailable',
                  severity: 'error',
                  message: `axe-core/jsdom could not be loaded: ${load.error}`,
                  hint: 'install axe-core and jsdom',
                },
              ]
            : [],
          metrics: { reason: load.error },
          durationMs: 0,
        });
        continue;
      }
      const r = await axeGate(c, load);
      results.push(result(g, r.findings, t0, r.metrics));
      continue;
    }
    const metrics: GateResult['metrics'] = {};
    if (g === 'size') metrics.totalBytes = c.files.reduce((n, f) => n + f.bytes.length, 0);
    if (g === 'completeness')
      metrics.pagesPerLocale = c.locales
        .map((l) => `${l}=${c.pages.filter((p) => p.locale === l).length}`)
        .join(',');
    results.push(result(g, SYNC[g](c), t0, metrics));
  }
  const errors = results.reduce(
    (n, r) => n + r.findings.filter((f) => f.severity === 'error').length,
    0,
  );
  const warnings = results.reduce(
    (n, r) => n + r.findings.filter((f) => f.severity === 'warning').length,
    0,
  );
  const manifest = artifactManifest(files);
  const passed = results.every((r) => r.status !== 'fail');
  return {
    schema: 'nuzm.website-qa/1',
    rootHash: manifest.rootHash,
    fileCount: files.length,
    totalBytes: manifest.totalBytes,
    locales: c.locales,
    pages: c.pages.length,
    gates: results,
    counts: { errors, warnings },
    passed,
    qualified:
      passed && results.every((r) => r.status === 'pass') && wanted.length === ALL_GATES.length,
  };
}

/** The findings that fail the build, flattened and bounded: what the repair loop (P3-S03) feeds back to the model. Stable order (gate, file, code). */
export function repairFindings(report: QaReport, limit = 25): QaFinding[] {
  return report.gates
    .flatMap((g) => g.findings)
    .filter((f) => f.severity === 'error')
    .sort((a, b) => (a.gate + (a.file ?? '') + a.code < b.gate + (b.file ?? '') + b.code ? -1 : 1))
    .slice(0, limit);
}
/** The same findings as short text lines, one per finding (for a model prompt or a log). */
export function repairText(report: QaReport, limit = 25): string {
  return repairFindings(report, limit)
    .map(
      (f) =>
        `[${f.code}]${f.file ? ` ${f.file}:` : ''} ${f.message}${f.hint ? ` (fix: ${f.hint})` : ''}`,
    )
    .join('\n');
}

export function summarize(report: QaReport): string {
  const lines = [
    `website QA: ${report.qualified ? 'QUALIFIED' : report.passed ? 'PASSED WITH GATES SKIPPED' : 'FAILED'}  (${report.pages} pages, ${report.fileCount} files, ${report.totalBytes} bytes)`,
    `artifact ${report.rootHash}`,
  ];
  for (const g of report.gates) {
    const e = g.findings.filter((f) => f.severity === 'error').length;
    const w = g.findings.length - e;
    lines.push(
      `  ${g.status.toUpperCase().padEnd(7)} ${g.gate.padEnd(13)} ${e} errors, ${w} warnings`,
    );
  }
  return lines.join('\n');
}
