import { createHash } from 'node:crypto';
import { indexable } from './text';

/**
 * Search documents of a version (S-K5): short, bounded texts built from what the analysis already proved (manifest, components, design, README sections), so retrieval never
 * reads source again and never sees content that was not already scanned and stored. Pure and deterministic: the same facts give the same documents and hashes.
 */
export type DocKind =
  'SUMMARY' | 'COMPONENT' | 'SYMBOL' | 'DOC_SECTION' | 'FEATURE' | 'DESIGN' | 'API';
export interface SearchDoc {
  docKind: DocKind;
  ref: string;
  title: string;
  body: string;
  contentHash: string;
}
export interface IndexComponent {
  name: string;
  kind: string;
  framework: string | null;
  path: string;
  props: { name: string }[];
  dependencies: string[];
}
export interface IndexInput {
  resource: { name: string };
  manifest: Record<string, unknown> | null;
  components: IndexComponent[];
  /** The Design DNA document of the version (S-K4), or null. */
  dna: Record<string, unknown> | null;
  markdown: { path: string; text: string }[];
}
export const INDEX_LIMITS = {
  maxDocs: 800,
  maxBody: 6000,
  maxTitle: 200,
  maxComponents: 400,
  maxSymbols: 200,
  maxFeatures: 100,
  maxSections: 80,
  maxSectionChars: 1800,
  maxSectionsPerFile: 25,
  maxMarkdownFiles: 20,
} as const;
const DOC_ORDER: DocKind[] = [
  'SUMMARY',
  'FEATURE',
  'COMPONENT',
  'SYMBOL',
  'DESIGN',
  'DOC_SECTION',
  'API',
];

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, n = 200): string => (typeof v === 'string' ? v.slice(0, n) : '');
const strs = (v: unknown, max = 40): string[] =>
  arr(v)
    .map((x) => str(x, 120))
    .filter(Boolean)
    .slice(0, max);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const split = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-./]+/g, ' ');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const doc = (docKind: DocKind, ref: string, title: string, body: string): SearchDoc => {
  const t = title.slice(0, INDEX_LIMITS.maxTitle) || ref.slice(0, INDEX_LIMITS.maxTitle);
  const b = indexable(body).slice(0, INDEX_LIMITS.maxBody);
  return {
    docKind,
    ref: ref.slice(0, 500),
    title: t,
    body: b,
    contentHash: sha(`${docKind}\u0000${ref}\u0000${t}\u0000${b}`),
  };
};

/** Markdown → sections by heading (levels 1-4); text before the first heading is the introduction. Code fences are skipped. Linear and bounded. */
export function splitMarkdown(
  path: string,
  text: string,
): { ref: string; title: string; body: string }[] {
  const out: { ref: string; title: string; body: string }[] = [];
  let title = path.split('/').pop() ?? path;
  let slug = 'intro';
  let buf: string[] = [];
  let fence = false;
  const flush = () => {
    const body = buf.join(' ').replace(/\s+/g, ' ').trim().slice(0, INDEX_LIMITS.maxSectionChars);
    if (body.length >= 20) out.push({ ref: `${path}#${slug}`, title, body });
    buf = [];
  };
  let n = 0;
  for (const raw of text.slice(0, 200_000).split('\n')) {
    if (++n > 6000) break;
    const line = raw.replace(/\r$/, '');
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,4})\s+(.{1,160}?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      title = h[2]!.replace(/[`*_[\]]/g, '').trim();
      slug =
        title
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60) || 'section';
    } else buf.push(line.replace(/[`*_>|]/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'));
  }
  flush();
  return out;
}

export function buildSearchDocuments(i: IndexInput): SearchDoc[] {
  const m = rec(i.manifest);
  const out: SearchDoc[] = [];
  const frameworks = strs(m.frameworks);
  const languages = strs(m.languages);
  const caps = arr(m.capabilities).map(rec);
  const routes = arr(m.routes).map(rec);
  const screens = arr(m.screens).map(rec);
  const projects = arr(m.projects).map(rec);
  const modules = strs(m.modules, 60);

  // one summary: what the package IS, from detected facts only
  out.push(
    doc(
      'SUMMARY',
      'summary',
      i.resource.name,
      [
        `frameworks: ${frameworks.join(' ')}`,
        `languages: ${languages.join(' ')}`,
        `project kinds: ${projects.map((p) => `${str(p.kind, 30)} ${str(p.name, 60)}`).join(', ')}`,
        `capabilities: ${caps.map((c) => str(c.name, 60)).join(', ')}`,
        `routes: ${routes
          .slice(0, 60)
          .map((r) => str(r.path, 80))
          .join(' ')}`,
        `screens: ${screens
          .slice(0, 40)
          .map((s) => str(s.name, 60))
          .join(' ')}`,
        `modules: ${modules.join(' ')}`,
      ].join('\n'),
    ),
  );
  // features: capabilities (with where they were proven) and routes/screens people recognise as product features
  for (const c of caps.slice(0, INDEX_LIMITS.maxFeatures)) {
    const name = str(c.name, 80);
    if (!name) continue;
    const ev = arr(c.evidence)
      .map(rec)
      .slice(0, 3)
      .map((e) => str(e.path, 120))
      .join(' ');
    out.push(doc('FEATURE', `capability:${name}`, name, `${name} ${split(name)} ${ev}`));
  }
  for (const r of routes.slice(0, INDEX_LIMITS.maxFeatures)) {
    const p = str(r.path, 120);
    if (p && p !== '/')
      out.push(
        doc(
          'FEATURE',
          `route:${p}`,
          `route ${p}`,
          `page route ${p} ${split(p)} ${str(r.file, 120)}`,
        ),
      );
  }
  for (const c of i.components.slice(0, INDEX_LIMITS.maxComponents))
    out.push(
      doc(
        'COMPONENT',
        `${c.path}#${c.name}`,
        c.name,
        `${c.name} ${split(c.name)} ${c.kind} ${c.framework ?? ''} ${split(c.path)} props: ${c.props
          .map((p) => p.name)
          .slice(0, 30)
          .join(' ')} uses: ${c.dependencies.slice(0, 20).join(' ')}`,
      ),
    );
  // symbols: what a library exports (the public surface of the architecture analysis)
  const surface = arr(rec(m.architecture).publicSurface).map(rec);
  for (const s of surface.slice(0, INDEX_LIMITS.maxSymbols)) {
    const file = str(s.file, 200);
    const names = strs(s.exports, 80);
    if (file && names.length)
      out.push(
        doc(
          'SYMBOL',
          file,
          file.split('/').pop() ?? file,
          `${file} exports: ${names.join(' ')} ${names.map(split).join(' ')}`,
        ),
      );
  }
  // design: the language of the visual identity in words
  const projectsDna = arr(rec(i.dna).projects).map(rec);
  const primary = projectsDna[Number(rec(i.dna).primary) || 0] ?? projectsDna[0];
  if (primary) {
    const traits = rec(primary.traits);
    const t = Object.entries(traits)
      .filter(([, v]) => v === true)
      .map(([k]) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());
    const palette = arr(primary.palette).map(rec);
    const roles = palette
      .flatMap((p) => arr(p.roles).map(rec))
      .slice(0, 30)
      .map((r) => `${str(r.role, 30)} ${str(r.hex, 9)}`);
    const fams = arr(rec(primary.typography).families)
      .map(rec)
      .slice(0, 6)
      .map((f) => str(f.resolved ?? f.value, 80));
    out.push(
      doc(
        'DESIGN',
        'design',
        'design',
        `design ${t.join(' ')} modes: ${strs(primary.modes, 8).join(' ')} schemes: ${strs(traits.schemes, 10).join(' ')} fonts: ${fams.join(' ')} colours: ${roles.join(' ')}`,
      ),
    );
  }
  let sections = 0;
  for (const f of i.markdown.slice(0, INDEX_LIMITS.maxMarkdownFiles)) {
    // a cap per file as well as in total: one huge README cannot crowd out the rest of the documentation
    let inFile = 0;
    for (const s of splitMarkdown(f.path, f.text)) {
      if (sections >= INDEX_LIMITS.maxSections || inFile >= INDEX_LIMITS.maxSectionsPerFile) break;
      sections++;
      inFile++;
      out.push(doc('DOC_SECTION', s.ref, s.title, `${s.title}\n${s.body}`));
    }
  }
  // deterministic order and bounds; a duplicate (kind, ref) keeps the first
  const seen = new Set<string>();
  return out
    .filter((d) => {
      const k = `${d.docKind}\u0000${d.ref}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort(
      (a, b) =>
        DOC_ORDER.indexOf(a.docKind) - DOC_ORDER.indexOf(b.docKind) ||
        (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
    )
    .slice(0, INDEX_LIMITS.maxDocs);
}
