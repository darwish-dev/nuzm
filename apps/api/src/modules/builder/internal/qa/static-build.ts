import { createRequire } from 'node:module';
import { validateSiteModel, type RenderIssue, type SiteModel } from '@nuzm/domain';
import { renderSiteCss } from '../../../../common/site-css';
import { modelHash } from '../version.service';
import { artifactManifest, type ArtifactFile, type ArtifactManifest } from './artifact';
import { repairFindings, runWebsiteQa } from './runner';
import type { QaFinding, QaOptions, QaReport } from './types';

/**
 * The static build of a website: a validated site model in, a HASH-BOUND artifact out (files + manifest) and, optionally, the QA report of exactly those files.
 * No server code is produced and none runs: the renderer is pure, Tailwind is compiled in-process by `compileSiteCss` (ADR-062), and nothing reads the network. This is
 * the "in-process safe tooling" path for the offline pipeline; when the qualified runtime (P3-S02) exists, a build that needs real tooling runs there and hands its
 * output directory to `artifactManifest` the same way, so the QA gates and the deploy hand-off do not care which path produced the files.
 */
export interface StaticBuildInput {
  model: SiteModel;
  baseUrl?: string;
  /** absolute origin + path prefix the contact forms post to (`${formsBaseUrl}/v1/public/forms/<id>`); '' for none */
  formsBaseUrl?: string;
  /** bytes of uploaded assets by content hash */
  assetBytes?: Record<string, Uint8Array>;
  /** `preview` adds the "not published" banner and noindex; `publish` (default) builds the page that goes live */
  mode?: 'publish' | 'preview';
  /** run the QA gates over the result (default: yes, all gates; axe when installed) */
  qa?: QaOptions | false;
}
export interface StaticBuildResult {
  /** the build produced files and, when QA ran, every QA gate passed */
  ok: boolean;
  files: ArtifactFile[];
  manifest: ArtifactManifest;
  modelHash: string;
  renderIssues: RenderIssue[];
  qa?: QaReport;
  /** why `ok` is false, as findings the repair loop can act on */
  failures: QaFinding[];
}

const req = createRequire(__filename);
function tailwindVersion(): string {
  try {
    return (req('tailwindcss/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
const enc = new TextEncoder();
const origin = (u: string | undefined): string | undefined => {
  try {
    return u ? new URL(u).origin : undefined;
  } catch {
    return undefined;
  }
};

export async function buildWebsiteArtifact(input: StaticBuildInput): Promise<StaticBuildResult> {
  const issues = validateSiteModel(input.model);
  if (issues.length) {
    const failures: QaFinding[] = issues.slice(0, 25).map((i) => ({
      gate: 'structure',
      code: 'model.invalid',
      severity: 'error',
      message: `${i.path} ${i.message}`,
    }));
    return {
      ok: false,
      files: [],
      manifest: artifactManifest([]),
      modelHash: modelHash(input.model),
      renderIssues: [],
      failures,
    };
  }
  const mode = input.mode ?? 'publish';
  const baseUrl = input.baseUrl ?? input.model.seo.baseUrl;
  const out = await renderSiteCss(input.model, {
    ...(baseUrl ? { baseUrl } : {}),
    formsBaseUrl: input.formsBaseUrl ?? '',
    previewBanner: mode === 'preview',
    ...(input.assetBytes ? { assetBytes: input.assetBytes } : {}),
  });
  const files: ArtifactFile[] = out.files.map((f) => ({
    path: f.path,
    mime: f.mime,
    bytes: typeof f.content === 'string' ? enc.encode(f.content) : f.content,
  }));
  const manifest = artifactManifest(files, {
    modelHash: modelHash(input.model),
    renderer: 'nuzm-render',
    tailwind: tailwindVersion(),
    mode,
  });
  const renderErrors = out.issues.filter((i) => i.severity === 'error');
  const failures: QaFinding[] = renderErrors.slice(0, 25).map((i) => ({
    gate: 'html',
    code: `render.${i.code}`,
    severity: 'error',
    ...(i.file ? { file: i.file } : {}),
    message: i.message,
  }));
  let qa: QaReport | undefined;
  if (input.qa !== false) {
    const fo = origin(input.formsBaseUrl);
    qa = await runWebsiteQa(files, {
      mode,
      ...(fo ? { formsOrigin: fo } : {}),
      ...(input.qa ?? {}),
    });
    failures.push(...repairFindings(qa));
  }
  return {
    ok: failures.length === 0 && (qa ? qa.passed : true),
    files,
    manifest,
    modelHash: manifest.provenance.modelHash!,
    renderIssues: out.issues,
    ...(qa ? { qa } : {}),
    failures,
  };
}
