import type { ImplementationPlan } from '../planning/types';

/**
 * Deployment PREPARATION (PHASE-2 S05): a description of what would be deployed and what a person is asked to approve. Nothing is deployed, no hosting or registrar is called and
 * no environment value is read: only the NAMES of environment variables the code mentions. The deployment itself is Session 06's, started from the deployments screen after the
 * approval; every claim in the plan carries the evidence it rests on (`origin: 'MOCK'` = the build and test results were scripted).
 */
export type DeployTarget =
  'static-site' | 'node-web' | 'node-api' | 'mobile-store' | 'database-only';

export interface Evidence {
  reviewErrors: number;
  reviewWarnings: number;
  buildPassed: boolean;
  testsPassed: boolean;
  /** 'MOCK' = scripted results: nothing proves the code builds */
  origin: 'MOCK' | 'REAL';
}

export interface DeploymentPlan {
  version: 1;
  target: DeployTarget;
  /** where the built output is expected (the build profile decides the real one) */
  outputPaths: string[];
  /** names only, never values; the customer sets them in the deployment's environment screen */
  envVars: string[];
  healthCheckPath: string | null;
  files: number;
  /** `ready` only with a passing review, build and tests on REAL evidence; everything else is `needs_attention` (the approval request still shows why) */
  readiness: 'ready' | 'needs_attention';
  blockers: string[];
  evidence: Evidence;
}

/** reads the NAMES of environment variables in customer code; built from a string so that this pure module never mentions a process object as code */
const ENV_REF = new RegExp(
  '(?:process\\.env|import\\.meta\\.env)\\.([A-Z][A-Z0-9_]{1,60})\\b',
  'g',
);
/** values a platform sets itself: not something the customer must supply */
const PLATFORM_ENV = new Set([
  'NODE_ENV',
  'PORT',
  'HOST',
  'MODE',
  'DEV',
  'PROD',
  'BASE_URL',
  'SSR',
]);

export function envVarNames(files: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>();
  for (const [path, text] of files) {
    if (!/\.(c|m)?(j|t)sx?$/.test(path) || text.length > 400_000) continue;
    for (const m of text.matchAll(ENV_REF)) if (!PLATFORM_ENV.has(m[1]!)) out.add(m[1]!);
  }
  return [...out].sort().slice(0, 50);
}

function targetOf(plan: Pick<ImplementationPlan, 'productType' | 'stack'>): DeployTarget {
  if (
    plan.productType === 'mobile' ||
    plan.productType === 'flutter' ||
    plan.stack.id.includes('flutter')
  )
    return 'mobile-store';
  if (plan.productType === 'database') return 'database-only';
  if (plan.productType === 'api') return 'node-api';
  if (
    plan.productType === 'landing' ||
    plan.productType === 'website' ||
    plan.productType === 'docs'
  )
    return 'static-site';
  return 'node-web';
}

export function prepareDeployment(
  files: ReadonlyMap<string, string>,
  plan: Pick<ImplementationPlan, 'productType' | 'stack'>,
  evidence: Evidence,
): DeploymentPlan {
  const target = targetOf(plan);
  const blockers: string[] = [];
  if (evidence.reviewErrors > 0) blockers.push('review_errors');
  if (!evidence.buildPassed) blockers.push('build_not_passed');
  if (!evidence.testsPassed) blockers.push('tests_not_passed');
  if (evidence.origin === 'MOCK') blockers.push('simulated_evidence');
  const paths = {
    'static-site': ['dist'],
    'node-web': ['.next', 'dist', 'build'],
    'node-api': ['dist'],
    'mobile-store': ['build'],
    'database-only': [],
  }[target];
  return {
    version: 1,
    target,
    outputPaths: [...paths],
    envVars: envVarNames(files),
    healthCheckPath: target === 'node-web' || target === 'node-api' ? '/health' : null,
    files: files.size,
    readiness: blockers.length === 0 ? 'ready' : 'needs_attention',
    blockers,
    evidence,
  };
}
