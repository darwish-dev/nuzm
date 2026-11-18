import type { RequestSpec, ScenarioConfig, Thresholds } from './runner';

/**
 * The M12 §11 load targets (proposals tied to D-30) as data. `declared` scale = the figure in the prompt; it has to be run on staging with M05 compute
 * (HG-05-xx, staging environment) and reported as measured. Scenarios whose subject system does not exist on this branch are `blocked` with the reason:
 * they are never reported as passing.
 */
export interface ScenarioDef {
  id: string;
  title: string;
  declared: {
    rps?: number;
    durationSeconds?: number;
    concurrentSessions?: number;
    targets: string;
  };
  status: 'runnable' | 'blocked';
  blockedBy?: string;
  build?: (
    baseUrl: string,
    auth: { cookie: string; csrf: string; orgId: string },
    scale: 'smoke' | 'declared',
  ) => ScenarioConfig;
}

const READ_P95 = 300;
const WRITE_P95 = 800;
const mixed: Thresholds = {
  readP95Ms: READ_P95,
  writeP95Ms: WRITE_P95,
  maxErrorRatePct: 0.5,
  minAchievedRpsPct: 98,
};

export const controlPlaneMixed = (
  baseUrl: string,
  a: { cookie: string; csrf: string; orgId: string },
  scale: 'smoke' | 'declared',
): ScenarioConfig => {
  const h = (): Record<string, string> => ({
    cookie: a.cookie,
    'x-csrf-token': a.csrf,
    'x-nuzm-org': a.orgId,
  });
  const reqs: RequestSpec[] = [
    { name: 'GET /v1/me', method: 'GET', path: '/v1/me', weight: 20, kind: 'read', headers: h },
    {
      name: 'GET /v1/workspaces',
      method: 'GET',
      path: '/v1/workspaces',
      weight: 20,
      kind: 'read',
      headers: h,
    },
    {
      name: 'GET /v1/billing/balance',
      method: 'GET',
      path: '/v1/billing/balance',
      weight: 15,
      kind: 'read',
      headers: h,
    },
    {
      name: 'GET /v1/usage/summary',
      method: 'GET',
      path: '/v1/usage/summary',
      weight: 15,
      kind: 'read',
      headers: h,
    },
    {
      name: 'GET /v1/audit-logs',
      method: 'GET',
      path: '/v1/audit-logs?limit=20',
      weight: 10,
      kind: 'read',
      headers: h,
    },
    {
      name: 'POST /v1/workspaces',
      method: 'POST',
      path: '/v1/workspaces',
      weight: 20,
      kind: 'write',
      expectStatus: [201],
      headers: () => ({
        ...h(),
        'idempotency-key': `load-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      }),
      body: () => ({ name: `load-${Math.random().toString(36).slice(2, 10)}` }),
    },
  ];
  return scale === 'declared'
    ? {
        id: 'control-plane-mixed',
        baseUrl,
        rps: 500,
        durationSeconds: 1800,
        maxInFlight: 2000,
        requests: reqs,
        thresholds: mixed,
        scale,
      }
    : {
        id: 'control-plane-mixed',
        baseUrl,
        rps: 20,
        durationSeconds: 10,
        maxInFlight: 100,
        requests: reqs,
        thresholds: mixed,
        scale,
      };
};

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'control-plane-mixed',
    title: 'Control-plane API mixed workload',
    declared: {
      rps: 500,
      durationSeconds: 1800,
      targets: 'p95 reads < 300 ms, writes < 800 ms, error rate < 0.5 %',
    },
    status: 'runnable',
    build: controlPlaneMixed,
  },
  {
    id: 'sessions-2000',
    title: '2,000 concurrent sessions',
    declared: {
      concurrentSessions: 2000,
      targets: 'sessions authenticate and stay valid; p95 as above',
    },
    status: 'runnable',
    build: controlPlaneMixed,
  },
  {
    id: 'ledger-posting',
    title: 'Ledger posting >= 200 tx/s, imbalance 0',
    declared: { rps: 200, targets: 'imbalance 0 (verified by SQL after the run)' },
    status: 'blocked',
    blockedBy:
      'needs the staging environment and a posting driver on the billing service; the ledger property tests (billing/ledger.int.spec.ts) cover correctness, not throughput',
  },
  {
    id: 'metering-ingest',
    title: 'Metering ingest 5,000 events/s sustained, 0 loss, 0 duplicates',
    declared: { rps: 5000, targets: '0 loss, 0 duplicates (count reconciliation after the run)' },
    status: 'blocked',
    blockedBy: 'needs staging; the ingest correctness tests exist (metering/metering.int.spec.ts)',
  },
  {
    id: 'workflows-100ps',
    title: 'Workflows 100 executions/s',
    declared: { rps: 100, targets: 'completion within SLA' },
    status: 'blocked',
    blockedBy: 'M11 (automation) is still being built on another branch',
  },
  {
    id: 'ai-runs-200',
    title: '200 concurrent AI runs (mock gateway) respecting caps',
    declared: { concurrentSessions: 200, targets: 'budget caps respected' },
    status: 'blocked',
    blockedBy: 'M09 (AI core) is still being built on another branch',
  },
  {
    id: 'reconcilers-under-load',
    title: 'Reconcilers finish within their window under load',
    declared: {
      targets: 'RC/TR runs complete within the scheduled window while the mixed workload runs',
    },
    status: 'blocked',
    blockedBy: 'needs staging at declared scale',
  },
  {
    id: 'soak-4h',
    title: 'Soak 4 h, memory growth <= 20 %',
    declared: {
      durationSeconds: 14400,
      targets: 'RSS growth <= 20 % (sampled with memoryGrowthPct)',
    },
    status: 'blocked',
    blockedBy: 'needs staging; a 4 h run was not attempted',
  },
];
