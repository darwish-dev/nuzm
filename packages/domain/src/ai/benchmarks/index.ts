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
export { MOCK_PROFILES, mockRecording, mockSuite, type MockProfile } from './simulate';
export {
  compareModels,
  signTest,
  type ComparisonEntry,
  type ComparisonRow,
  type ModelComparison,
  type Pairwise,
} from './compare';
export {
  CATEGORY_PASS_FLOOR,
  CATEGORY_REGRESSION_TOLERANCE,
  ORIGINAL_THRESHOLD_IDS,
  detectRegressions,
  taskRegressions,
  type Regression,
} from './thresholds';
export {
  REVIEW_PROTOCOL,
  createReviewPlan,
  summarizeReviews,
  validateReview,
  type HumanAcceptanceResult,
  type Review,
  type ReviewItem,
  type ReviewPlan,
  type Reviewer,
} from './review';
export {
  BudgetLedger,
  costMinor,
  preflightBudget,
  priceCardProblem,
  validateBudget,
  worstCaseTaskMinor,
  type BenchmarkBudget,
  type BudgetCheck,
  type PriceCard,
} from './budget';
export {
  evaluateRolloutGate,
  type GateCheck,
  type GateDecision,
  type GateInput,
  type SecurityReviewRecord,
  type ThresholdAcceptance,
} from './gate';
export {
  effectiveState,
  isQualified,
  proposeQualification,
  stepQualification,
  type EffectiveState,
  type QualificationEvent,
  type QualificationEvidence,
  type QualificationRecord,
  type QualificationState,
  type StepResult,
} from './qualification';
export {
  UncertainCaptureError,
  livePreflight,
  runLiveBenchmark,
  type CaptureRequest,
  type CaptureResult,
  type CaptureSource,
  type LivePreconditions,
  type LiveRunResult,
  type LiveRunStatus,
  type Refusal,
  type RefusalCode,
} from './live-runner';
export {
  DEFAULT_COST_ASSUMPTIONS,
  PREREQUISITES,
  REFERENCE_RATE_INPUTS,
  STAGES,
  STAGE_IDS,
  calibrateAssumptions,
  evaluateStageEntry,
  evaluateStageExit,
  planContinuousMonth,
  planStage,
  programmeExposure,
  proposedBudgetFor,
  selectStageTasks,
  stageDefinition,
  stageExited,
  type ContinuousCadence,
  type CostAssumptions,
  type ExitCheck,
  type PrerequisiteId,
  type RateInput,
  type StageDefinition,
  type StageEntry,
  type StageId,
  type StageOutcome,
  type StagePlan,
  type StageState,
} from './stages';
export {
  SCORECARD_DIMENSIONS,
  buildScorecard,
  type ScorecardDimension,
  type ScorecardRow,
} from './scorecard';
