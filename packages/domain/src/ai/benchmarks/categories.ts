import type { TaskKind } from './types';

/**
 * The 23 benchmark categories of S-AG5. `kind` (website, webapp, code-edit, tool-calling) stays the coarse group the rollout thresholds T05-T08 are scoped to; the category is
 * the finer axis a report is broken down by. Every category maps to exactly one kind.
 */
export const TASK_CATEGORIES = [
  'landing-page',
  'business-website',
  'e-commerce',
  'web-application',
  'mobile-application',
  'flutter-application',
  'full-stack',
  'erp',
  'crm',
  'saas',
  'backend-api',
  'database-architecture',
  'authentication',
  'ui-implementation',
  'responsive-design',
  'arabic-rtl',
  'accessibility',
  'code-editing',
  'multi-file-refactoring',
  'bug-fixing',
  'security-remediation',
  'tool-calling',
  'build-deployment-planning',
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const CATEGORY_KIND: Record<TaskCategory, TaskKind> = {
  'landing-page': 'website',
  'business-website': 'website',
  'responsive-design': 'website',
  'arabic-rtl': 'website',
  accessibility: 'website',
  'e-commerce': 'webapp',
  'web-application': 'webapp',
  'mobile-application': 'webapp',
  'flutter-application': 'webapp',
  'full-stack': 'webapp',
  erp: 'webapp',
  crm: 'webapp',
  saas: 'webapp',
  'backend-api': 'webapp',
  'database-architecture': 'webapp',
  authentication: 'webapp',
  'ui-implementation': 'webapp',
  'build-deployment-planning': 'webapp',
  'code-editing': 'code-edit',
  'multi-file-refactoring': 'code-edit',
  'bug-fixing': 'code-edit',
  'security-remediation': 'code-edit',
  'tool-calling': 'tool-calling',
};
export const TASK_KINDS = ['website', 'webapp', 'code-edit', 'tool-calling'] as const;

/** Minimum number of tasks a category needs before a rollout gate treats it as covered. */
export const MIN_TASKS_PER_CATEGORY = 3;
