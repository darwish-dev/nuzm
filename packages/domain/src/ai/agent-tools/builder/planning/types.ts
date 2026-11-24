/**
 * Requirement analysis, task decomposition and implementation planning (S-05 priority 2 and 5). Everything here is deterministic and offline: it reads a customer's text as DATA with
 * fixed keyword tables (Arabic and English), never follows an instruction inside it, and never calls a model, a network or a clock. A model-produced plan (later, after S-AG4) must
 * validate against the same `ImplementationPlan` shape (`validatePlan`), so a model can only ever propose what a deterministic checker accepts.
 */
export const PRODUCT_TYPES = [
  'website',
  'landing',
  'ecommerce',
  'webapp',
  'mobile',
  'flutter',
  'erp',
  'crm',
  'saas',
  'fullstack',
  'api',
  'database',
  'auth',
  'docs',
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export type Locale = 'ar' | 'en';
export interface Bilingual {
  en: string;
  ar: string;
}

export type TaskKind = 'config' | 'schema' | 'backend' | 'frontend' | 'auth' | 'integration' | 'tests' | 'docs' | 'review';

/** A capability a customer may ask for, recognised by keywords in either language. */
export interface FeatureDef {
  id: string;
  title: Bilingual;
  en: readonly string[];
  /** Arabic stems, matched on normalised text (so the definite article and suffixes do not matter) */
  ar: readonly string[];
}

export interface ModuleSpec {
  id: string;
  title: Bilingual;
  kind: TaskKind;
  /** module ids this one needs first (ids not selected for a plan are ignored) */
  dependsOn: readonly string[];
  /** expected files; `{name}` style placeholders are not used: paths are fixed per stack family */
  files: readonly string[];
  acceptance: readonly Bilingual[];
  /** `null` = always part of the plan; otherwise the feature id that pulls it in */
  feature: string | null;
  /** relative effort, 1 (small) to 5 (large): drives the token estimate */
  size: 1 | 2 | 3 | 4 | 5;
  /** a human must approve before this task's output is applied (migrations, payments, auth, pipeline) */
  approval?: string;
}

export interface StackOption {
  id: string;
  title: Bilingual;
  /** language and runtime families the stack uses, shown to the customer */
  parts: readonly string[];
  /** hard preferences it satisfies when a requirement names one (matched on normalised keywords) */
  keywords: readonly string[];
  /** `files` of the modules use this family's layout */
  family: 'node-web' | 'node-api' | 'flutter' | 'static' | 'sql';
}

export interface ProductProfile {
  type: ProductType;
  title: Bilingual;
  en: readonly string[];
  ar: readonly string[];
  stacks: readonly StackOption[];
  modules: readonly ModuleSpec[];
  /** features that are expected for this type even if the text does not name them */
  impliedFeatures: readonly string[];
  /** questions asked when the text does not settle them */
  questions: readonly { id: string; text: Bilingual; unlessFeature?: string }[];
}

export interface RequirementAnalysis {
  locale: Locale;
  truncated: boolean;
  productType: ProductType;
  /** every type that scored, best first (the plan uses the first; a tie is reported as an ambiguity) */
  candidates: { type: ProductType; score: number }[];
  features: string[];
  impliedFeatures: string[];
  /** stack the text asks for, when it names one */
  requestedStack: string | null;
  ambiguities: { id: string; text: Bilingual }[];
  questions: { id: string; text: Bilingual }[];
  /** short fixed notes, e.g. regulated areas the generator will NOT claim compliance for */
  notes: Bilingual[];
  /** 0 to 1: how much of the text the analysis could place */
  confidence: number;
}

export interface PlanTask {
  id: string;
  moduleId: string;
  title: Bilingual;
  kind: TaskKind;
  dependsOn: string[];
  /** 0-based wave: tasks of one wave can be worked in parallel */
  wave: number;
  files: string[];
  acceptance: Bilingual[];
  size: number;
  approval: string | null;
}

export interface ImplementationPlan {
  version: 1;
  productType: ProductType;
  locale: Locale;
  stack: { id: string; title: Bilingual; parts: string[]; reason: 'requested' | 'default' };
  tasks: PlanTask[];
  waves: number;
  /** distinct files the plan expects to create */
  fileCount: number;
  approvals: { taskId: string; reason: string }[];
  risks: { code: string; text: Bilingual }[];
  /** relative effort in "size points" (sum of task sizes) */
  effort: number;
  analysis: Pick<RequirementAnalysis, 'features' | 'impliedFeatures' | 'questions' | 'ambiguities' | 'notes' | 'confidence'>;
}

export const PLAN_LIMITS = {
  maxRequirementChars: 20_000,
  maxTasks: 60,
  maxFilesPerTask: 40,
  maxFeatures: 40,
} as const;
