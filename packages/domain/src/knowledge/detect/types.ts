/**
 * Project detection (S-K2b, ADR-065): static analysis of an ingested package. Everything here reads TEXT that the ingestion worker already inventoried and stored;
 * nothing is executed, imported, installed or resolved from the file system. A detection exists only with at least one concrete piece of evidence (a dependency
 * line, a configuration file, an entry point, a directory convention); prose such as a README is never evidence.
 */
export type EvidenceKind =
  | 'dependency'
  | 'config'
  | 'file'
  | 'directory'
  | 'script'
  | 'source'
  | 'lockfile'
  | 'workspace'
  | 'manifest';
export interface Evidence {
  kind: EvidenceKind;
  /** Path inside the package. */
  path: string;
  line?: number;
  /** A short fact (`next@^15.0.0`, `GoRoute path`), never file content beyond a token. */
  detail?: string;
}
export type Level = 'high' | 'medium' | 'low';
export type DetectionCategory = 'framework' | 'runtime' | 'language' | 'library' | 'tool';
export interface Detection {
  id: string;
  name: string;
  category: DetectionCategory;
  version: string | null;
  versionSource: 'lockfile' | 'declared' | null;
  confidence: number;
  level: Level;
  evidence: Evidence[];
  notes: string[];
}
export interface PackageManagerInfo {
  name:
    | 'npm'
    | 'pnpm'
    | 'yarn'
    | 'bun'
    | 'pub'
    | 'pip'
    | 'poetry'
    | 'pipenv'
    | 'composer'
    | 'go'
    | 'bundler';
  version: string | null;
  evidence: Evidence[];
  confidence: number;
}
export type ProjectKind = 'application' | 'library' | 'example' | 'tooling-root';
export type Role = 'frontend' | 'backend' | 'mobile' | 'library' | 'cli' | 'tooling';
export interface DependencyFact {
  name: string;
  range: string | null;
  /** The version resolved by a lockfile, when one was read. */
  resolved: string | null;
  kind: 'runtime' | 'dev' | 'peer' | 'optional';
  ecosystem: 'npm' | 'pub' | 'pip' | 'composer' | 'go' | 'gem';
  line?: number;
}
export interface RouteFact {
  kind:
    | 'next-app-page'
    | 'next-route-handler'
    | 'next-pages-page'
    | 'next-pages-api'
    | 'nest-controller-route'
    | 'flutter-route';
  /** Normalised path (`/users/[id]`, `/api/users/:id`). */
  path: string;
  methods: string[];
  dynamic: boolean;
  file: string;
  line?: number;
  project: string;
  confidence: number;
}
export interface ModuleFact {
  kind: 'nest-module' | 'nest-controller' | 'flutter-screen';
  name: string;
  file: string;
  line?: number;
  project: string;
  confidence: number;
}
export interface BuildInfo {
  scripts: { name: string; command: string }[];
  configFiles: string[];
  typescript: {
    path: string;
    strict: boolean | null;
    target: string | null;
    module: string | null;
  } | null;
  docker: { path: string; baseImages: string[] }[];
  ci: string[];
  flutter?: {
    sdkConstraint: string | null;
    platforms: string[];
    usesMaterialDesign: boolean | null;
    assets: number;
  };
}
export interface ProjectInfo {
  /** Directory of the manifest, relative to the package root (`.` for the root). */
  root: string;
  name: string | null;
  kind: ProjectKind;
  roles: { role: Role; evidence: Evidence[] }[];
  ecosystems: string[];
  detections: Detection[];
  packageManager: PackageManagerInfo | null;
  entryPoints: Evidence[];
  build: BuildInfo;
  dependencyCount: number;
  dependencies: DependencyFact[];
}
export interface WorkspaceInfo {
  tool: 'pnpm' | 'npm' | 'yarn' | 'lerna' | 'nx' | 'turbo' | 'melos' | 'convention';
  root: string;
  patterns: string[];
  members: string[];
  evidence: Evidence[];
}
export interface ManifestCapability {
  name: string;
  confidence: number;
  evidence: Evidence[];
}
export interface Ambiguity {
  code: string;
  detail: string;
  paths: string[];
}
export interface ProjectManifest {
  schemaVersion: '1';
  analyzer: { id: 'project-detect'; version: string };
  /** Ids of the frameworks detected (confidence at least 0.5) in application projects. Kept flat for the resource summary. */
  frameworks: string[];
  languages: string[];
  languageStats: { name: string; files: number; bytes: number }[];
  packageManagers: string[];
  modules: string[];
  /** Reserved for the AST analysis (S-K2c). */
  components: string[];
  capabilities: ManifestCapability[];
  projects: ProjectInfo[];
  workspaces: WorkspaceInfo[];
  routes: RouteFact[];
  screens: ModuleFact[];
  moduleFacts: ModuleFact[];
  ambiguities: Ambiguity[];
  stats: {
    filesConsidered: number;
    filesRead: number;
    bytesRead: number;
    truncated: string[];
    skippedLarge: number;
  };
}
export interface DetectFile {
  path: string;
  bytes: number;
  sha256: string;
  language: string | null;
  /** Content is in the snapshot and can be read. */
  stored: boolean;
}
export interface DetectInput {
  files: DetectFile[];
  /** Returns the text of a stored file, or null. Must never throw for a missing file. */
  read: (path: string, maxBytes: number) => Promise<string | null>;
}
export interface DetectOptions {
  maxReadBytes?: number;
  maxTotalReadBytes?: number;
  maxFilesRead?: number;
  maxRoutes?: number;
  maxProjects?: number;
  now?: () => number;
  maxMillis?: number;
}
export const ANALYZER_VERSION = '1.0.0';
