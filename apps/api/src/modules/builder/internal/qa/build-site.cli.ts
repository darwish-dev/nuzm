/**
 * `tsx src/modules/builder/internal/qa/build-site.cli.ts <template-id|model.json> <out-dir> [--base-url https://…] [--forms-base https://…] [--preview]`: static build of a template
 * (or a site-model JSON file) into `<out-dir>/site/` + `<out-dir>/manifest.json` (hash-bound), then the website QA gates over exactly those files. Offline: no model call, no
 * network. Exit 0 when the build and every gate passed (axe included), 1 on a failure, 2 on usage, 3 when passed with a gate skipped.
 */
import { readFile } from 'node:fs/promises';
import { TEMPLATES, type SiteModel } from '@nuzm/domain';
import { writeArtifactDir } from './artifact';
import { repairText, summarize } from './runner';
import { buildWebsiteArtifact } from './static-build';

async function main(a: string[]): Promise<number> {
  const [src, out] = a.filter(
    (x, i) => !x.startsWith('--') && !/^--(base-url|forms-base)$/.test(a[i - 1] ?? ''),
  );
  if (!src || !out) {
    console.error(
      'usage: build-site <template-id|model.json> <out-dir> [--base-url URL] [--forms-base URL] [--preview]',
    );
    return 2;
  }
  const val = (k: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  let model: SiteModel;
  const tpl = TEMPLATES.find((t) => t.id === src);
  if (tpl)
    model = tpl.build({
      name: { ar: 'موقع تجريبي', en: 'Sample site' },
      locales: ['ar', 'en'],
      ...(val('--base-url') ? { baseUrl: val('--base-url')! } : {}),
    });
  else model = JSON.parse(await readFile(src, 'utf8')) as SiteModel;
  const r = await buildWebsiteArtifact({
    model,
    ...(val('--base-url') ? { baseUrl: val('--base-url')! } : {}),
    formsBaseUrl: val('--forms-base') ?? '',
    mode: a.includes('--preview') ? 'preview' : 'publish',
  });
  if (r.files.length) {
    const w = await writeArtifactDir(out, r.files, r.manifest);
    console.log(
      `artifact ${r.manifest.rootHash}\n  ${r.files.length} files -> ${w.siteDir}\n  manifest ${w.manifestPath}`,
    );
  }
  if (r.qa) console.log(summarize(r.qa));
  if (!r.ok)
    console.log(
      `\nfailures:\n${r.qa ? repairText(r.qa, 40) : r.failures.map((f) => `[${f.code}] ${f.message}`).join('\n')}`,
    );
  return r.ok ? (r.qa?.qualified ? 0 : 3) : 1;
}
main(process.argv.slice(2)).then(
  (c) => process.exit(c),
  (e: unknown) => (console.error(e instanceof Error ? e.message : String(e)), process.exit(2)),
);
