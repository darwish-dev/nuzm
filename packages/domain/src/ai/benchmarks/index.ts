export * from './types';
export {
  CATEGORY_KIND,
  MIN_TASKS_PER_CATEGORY,
  TASK_CATEGORIES,
  TASK_KINDS,
  type TaskCategory,
} from './categories';
export { GOLDEN_TASKS, CORE_TASKS } from './dataset';
export { canonicalJson, fingerprint, sha256Hex } from './canonical';
export {
  DATASET_VERSION,
  GoldenTaskRegistry,
  buildManifest,
  classifyChange,
  diffManifests,
  nextVersion,
  taskHash,
  validateDataset,
  type DatasetManifest,
  type ManifestDiff,
  type ManifestEntry,
  type TaskFilter,
} from './registry';
export { mutantsOf, proveTask, type Mutant, type TaskProof } from './proofs';
export { referenceRecording } from './reference';
export { replayTask, REPLAY_LIMITS } from './replay';
export { scoreRun, scoreRunDetailed, QUALITY_WEIGHTS } from './score';
export {
  DIMENSION_RULE_IDS,
  contrastRatio,
  evaluateDimensions,
  type DimensionResult,
  type Finding,
} from './dimensions';
export { EFFICIENCY_SHAPE, creditsFor, efficiencyScore, type RateCard } from './efficiency';
export {
  evidenceLabel,
  recordingProblem,
  renderReport,
  renderReportCsv,
  renderReportJson,
  reportFingerprint,
  runSuite,
  summarize,
  type BenchmarkReport,
  type EvidenceLabel,
  type KindSummary,
  type RejectedRecording,
} from './report';
export {
  PROPOSED_THRESHOLDS,
  HUMAN_ACCEPTANCE_PROPOSAL,
  THRESHOLDS_VERSION,
  evaluateThresholds,
  regressions,
  rolloutDecision,
  type Threshold,
  type ThresholdResult,
  type RolloutDecision,
} from './thresholds';
