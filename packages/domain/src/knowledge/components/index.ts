export { analyzeDart, blank } from './dart';
export {
  assemble,
  buildManifestV2,
  type AssembleFile,
  type AssembleProject,
  type AssembleRoute,
} from './assemble';
export { aliasesOf, resolveDart, resolveTs, normalize, type Alias } from './resolve';
export {
  COMPONENT_ANALYZER_VERSION,
  LIMITS as COMPONENT_LIMITS,
  emptyFacts,
  safeName,
} from './types';
export type {
  ArchitectureSummary,
  AssembleResult,
  ComponentFact,
  ComponentKind,
  ComponentRow,
  FileFacts,
  ImportFact,
  LinkFact,
  PropFact,
  RelationshipRow,
  SkipReason,
} from './types';
export { longestLine } from './dart';
