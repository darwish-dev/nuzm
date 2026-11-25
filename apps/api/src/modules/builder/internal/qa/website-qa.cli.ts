/**
 * Website QA gate runner, as a command: `tsx src/modules/builder/qa/website-qa.cli.ts <artifact-dir> [--json] [--min-pages N] [--require-slugs home,about,…]
 *   [--forms-origin https://…] [--preview] [--no-axe] [--browser] [--out report.json]`.  Exit code 0 only when every gate RAN and passed (`qualified`); 1 when a gate failed;
 *   2 on a usage error; 3 when it passed but a gate was skipped (axe-core/jsdom missing). It reads files only: no network, no browser, no provider.
 */
import { writeFile } from 'node:fs/promises';
import { loadArtifactDir } from './artifact';
import { runBrowserQa } from './browser-qa';
import { repairText, runWebsiteQa, summarize } from './runner';
import type { QaOptions } from './types';

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const dir = args.find(
    (a) =>
      !a.startsWith('--') &&
      !args[args.indexOf(a) - 1]?.match(/^--(min-pages|require-slugs|forms-origin|out)$/),
  );
  if (!dir) {
    console.error(
      'usage: website-qa <artifact-dir> [--json] [--min-pages N] [--require-slugs a,b] [--forms-origin URL] [--preview] [--no-axe] [--browser] [--out file]',
    );
    return 2;
  }
  const val = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const opts: QaOptions = {
    mode: args.includes('--preview') ? 'preview' : 'publish',
    axe: args.includes('--no-axe') ? 'off' : 'auto',
  };
  const mp = val('--min-pages');
  if (mp !== undefined) {
    if (!/^\d+$/.test(mp)) {
      console.error('--min-pages needs a number');
      return 2;
    }
    opts.minPages = Number(mp);
  }
  const rs = val('--require-slugs');
  if (rs) opts.requiredSlugs = rs.split(',').filter(Boolean);
  const fo = val('--forms-origin');
  if (fo) opts.formsOrigin = fo;
  const files = await loadArtifactDir(dir);
  const report = await runWebsiteQa(files, opts);
  const out = val('--out');
  if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(summarize(report));
    const t = repairText(report, 40);
    if (t) console.log(`\nfailures:\n${t}`);
  }
  let code = report.qualified ? 0 : report.passed ? 3 : 1;
  if (args.includes('--browser')) {
    // heavy: opens Chrome on a loopback server (axe with layout, CSP as enforced, RTL, overflow). Run it deliberately.
    const b = await runBrowserQa(files, opts);
    if (b.status === 'unavailable') {
      console.log(`\nbrowser QA: UNAVAILABLE (${b.reason}) - not a pass`);
      code = code === 1 ? 1 : 3;
    } else {
      const errs = b.findings.filter((x) => x.severity === 'error');
      console.log(
        `\nbrowser QA (${b.metrics.browser}, axe ${b.metrics.axeVersion}): ${errs.length ? 'FAILED' : 'PASSED'} - ${b.metrics.pagesChecked} page loads (${b.metrics.viewports}), ${errs.length} errors, ${b.findings.length - errs.length} warnings`,
      );
      for (const x of b.findings.slice(0, 40)) console.log(`  [${x.code}] ${x.message}`);
      if (errs.length) code = 1;
    }
  }
  return code;
}
main(process.argv).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  },
);
