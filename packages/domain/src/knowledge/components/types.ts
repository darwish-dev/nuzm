/**
 * Component and architecture analysis (S-K2c, ADR-065): per-file FACTS extracted by parse-only analyzers (TypeScript compiler API in the worker, a lexical Dart analyzer
 * here), assembled into component rows, relationships and an architecture summary. Facts are PATH-INDEPENDENT (keyed by the file's content hash) so an unchanged file is
 * never analysed again, in this version or in the next one. Nothing is executed, imported or resolved from the file system outside the snapshot.
 */
export const COMPONENT_ANALYZER_VERSION = '1.0.0';
export type FileLang = 'ts' | 'dart';
export type Framework = 'react' | 'next' | 'nestjs' | 'flutter';
export type ComponentKind =
  | 'react-component'
  | 'react-class-component'
  | 'next-page'
  | 'next-layout'
  | 'nest-module'
  | 'nest-controller'
  | 'nest-provider'
  | 'nest-dto'
  | 'flutter-widget'
  | 'flutter-stateful-widget'
  | 'flutter-state'
  | 'flutter-state-holder'
  | 'flutter-provider';
export interface PropFact {
  name: string;
  type: string | null;
  required: boolean;
}
export interface LinkFact {
  relation: 'declares' | 'imports' | 'exports' | 'injects' | 'guarded_by' | 'state_of';
  target: string;
}
export interface ComponentFact {
  name: string;
  kind: ComponentKind;
  framework: Framework;
  line: number;
  exported: boolean;
  isDefault: boolean;
  props: PropFact[];
  hooks: string[];
  /** Names of components/widgets rendered (JSX tags, widget constructor calls). */
  children: string[];
  decorators: string[];
  links: LinkFact[];
}
export interface ImportFact {
  spec: string;
  kind: 'relative' | 'alias' | 'package' | 'dart-package' | 'dart-relative' | 'dynamic';
  names: string[];
  line: number;
  style: boolean;
  asset: boolean;
}
export type SkipReason = 'too_large' | 'minified' | 'parse_error' | 'budget' | 'generated';
export interface FileFacts {
  lang: FileLang;
  imports: ImportFact[];
  exports: string[];
  reexports: { spec: string; line: number }[];
  components: ComponentFact[];
  directives: string[];
  /** Dart routers: `GoRoute(path: '/x', builder: ... Screen())` → route path and the screen it builds. */
  routeRefs: { path: string; target: string; line: number }[];
  hasTheme: boolean;
  skipped: SkipReason | null;
  truncated: boolean;
}
export const emptyFacts = (lang: FileLang, skipped: SkipReason | null = null): FileFacts => ({
  lang,
  imports: [],
  exports: [],
  reexports: [],
  components: [],
  directives: [],
  routeRefs: [],
  hasTheme: false,
  skipped,
  truncated: false,
});

export const LIMITS = {
  maxComponentsPerFile: 200,
  maxPropsPerComponent: 40,
  maxChildrenPerComponent: 80,
  maxImportsPerFile: 400,
  maxLine: 5000,
  maxFacts: 150_000,
  maxFiles: 3000,
  maxComponents: 5000,
  maxRelationships: 20_000,
} as const;
const ID = /^[A-Za-z_$][\w$]{0,119}$/;
/** Names that come from source text are restricted to identifier characters (no `__proto__` tricks reach a key: they are only ever values). */
export const safeName = (s: unknown): string | null =>
  typeof s === 'string' && ID.test(s) ? s : null;

export interface ComponentRow {
  name: string;
  kind: ComponentKind;
  framework: Framework;
  path: string;
  line: number;
  project: string;
  exported: boolean;
  props: PropFact[];
  hooks: string[];
  dependencies: string[];
  styleDeps: string[];
  assets: string[];
  platforms: string[];
}
export interface RelationshipRow {
  fromKind: 'component' | 'file' | 'route' | 'module';
  fromRef: string;
  toKind: 'component' | 'file' | 'module';
  toRef: string;
  relation: string;
  evidence: { path: string; line?: number };
}
export interface ArchitectureSummary {
  layers: { project: string; name: string; role: string; files: number }[];
  modules: {
    name: string;
    project: string;
    files: number;
    dependsOn: { module: string; weight: number }[];
  }[];
  cycles: { files: string[]; size: number }[];
  entryReachability: {
    roots: number;
    analysedFiles: number;
    unreachable: number;
    sample: string[];
  } | null;
  publicSurface: { project: string; file: string; exports: string[] }[];
  orphanComponents: { name: string; path: string }[];
  stats: {
    files: number;
    skipped: Record<string, number>;
    internalImports: number;
    unresolvedImports: number;
    truncated: string[];
  };
}
export interface AssembleResult {
  components: ComponentRow[];
  relationships: RelationshipRow[];
  architecture: ArchitectureSummary;
}
