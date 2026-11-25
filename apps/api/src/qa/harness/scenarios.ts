import type { Track } from '../evidence/verify';

/**
 * P3-S08 qualification harness: the ordered scenario list. Order is dependency order for a LIVE run (a later scenario needs the model, the runtime or the target an earlier one
 * qualifies). Each scenario names the approvals and external facts it needs (the same ids as `OWNER-APPROVAL-PACK.md` and `evidence/matrix.ts`), the track and targets its evidence
 * belongs to, and the entry point of the session that owns the real run. Nothing here executes anything.
 */
export interface Scenario {
  id: string;
  title: string;
  track: Track;
  /** acceptance targets the evidence is for */
  targets: string[];
  /** owner approval ids that must be recorded before the real run */
  approvals: string[];
  /** keys of EXTERNAL_BLOCKERS (evidence/matrix.ts) */
  external: string[];
  /** scenario ids that must have LIVE-VERIFIED evidence first (live mode) */
  after: string[];
  /** the owner session and the command or function the real run calls */
  owner: string;
  entry: string;
  /** hard maximum cost in USD micro-units for a live run of this scenario (0 = free); a run above it is stopped */
  maxCostMicroUsd: number;
}

const PROVIDER = ['D2', 'D5', 'D6', 'D4', 'D3', 'D9'];
const RUNTIME = ['D-21', 'HG-10-02', 'ADR-067'];
const DEPLOY = ['HG-05', 'HG-06', 'HOST-TRANSPORT', 'B-DOMAIN', 'HOST-JOIN'];

export const SCENARIOS: Scenario[] = [
  {
    id: 'P01-provider-connection',
    title: 'Track A: real provider connection through the metered gateway',
    track: 'provider',
    targets: ['T1', 'T3', 'T5'],
    approvals: PROVIDER,
    external: [],
    after: [],
    owner: 'P3-S01',
    entry: 'pnpm --filter @nuzm/api qualify:a --execute',
    maxCostMicroUsd: 6_400,
  },
  {
    id: 'P02-tool-calling',
    title: 'Track B: tool-call round trip with the real model',
    track: 'tool-calling',
    targets: ['T2'],
    approvals: PROVIDER,
    external: [],
    after: ['P01-provider-connection'],
    owner: 'P3-S01',
    entry: 'pnpm --filter @nuzm/api qualify:b --execute',
    maxCostMicroUsd: 80_720,
  },
  {
    id: 'P03-codegen',
    title: 'Track C: real code generation from a synthetic brief',
    track: 'codegen',
    targets: ['T3'],
    approvals: PROVIDER,
    external: [],
    after: ['P02-tool-calling'],
    owner: 'P3-S01',
    entry: 'pnpm --filter @nuzm/api qualify:c --execute',
    maxCostMicroUsd: 30_400,
  },
  {
    id: 'R01-runtime-isolation',
    title: 'Track D: escape suite twice on a rebuilt node, signed attestation',
    track: 'runtime',
    targets: ['T2', 'T5'],
    approvals: RUNTIME,
    external: ['LINUX-NODE'],
    after: [],
    owner: 'P3-S02',
    entry: 'pnpm --filter @nuzm/api sandbox:escape-suite (qualify mode) and track:d',
    maxCostMicroUsd: 0,
  },
  {
    id: 'B01-build-repair',
    title:
      'T5: detect a build error, repair it with the real model, rebuild green (3 error classes)',
    track: 'build-repair',
    targets: ['T5'],
    approvals: [...PROVIDER, ...RUNTIME],
    external: ['LINUX-NODE'],
    after: ['P03-codegen', 'R01-runtime-isolation'],
    owner: 'P3-S03',
    entry: 'pnpm --filter @nuzm/api track:e (P3-S03 repair engine)',
    maxCostMicroUsd: 500_000,
  },
  {
    id: 'W01-website',
    title: 'T1 part 1: complete Arabic and English business website, QA gates green',
    track: 'website',
    targets: ['T1'],
    approvals: PROVIDER,
    external: [],
    after: ['P03-codegen'],
    owner: 'P3-S04',
    entry: 'P3-S04 website pipeline (entry point not yet announced)',
    maxCostMicroUsd: 500_000,
  },
  {
    id: 'F01-fullstack',
    title: 'T2: full-stack app (auth, API, PostgreSQL) built and tested in the isolated runtime',
    track: 'fullstack',
    targets: ['T2'],
    approvals: [...PROVIDER, ...RUNTIME, 'B-DB'],
    external: ['LINUX-NODE'],
    after: ['P03-codegen', 'R01-runtime-isolation'],
    owner: 'P3-S05',
    entry: 'P3-S05 full-stack pipeline (entry point not yet announced)',
    maxCostMicroUsd: 1_000_000,
  },
  {
    id: 'M01-android-apk',
    title: 'T3: Flutter project to an installable debug APK (test key)',
    track: 'mobile',
    targets: ['T3'],
    approvals: [...PROVIDER, 'B-Android', 'B-SIGN'],
    external: [],
    after: ['P03-codegen'],
    owner: 'P3-S06',
    entry: 'P3-S06 mobile build engine, Android recipe (entry point not yet announced)',
    maxCostMicroUsd: 1_000_000,
  },
  {
    id: 'M02-ios-build',
    title: 'T4: Flutter iOS build without code signing on macOS with full Xcode',
    track: 'mobile',
    targets: ['T4'],
    approvals: ['B-iOS'],
    external: ['B-iOS-XCODE'],
    after: ['M01-android-apk'],
    owner: 'P3-S06',
    entry: 'P3-S06 iOS recipe + prerequisite checker (entry point not yet announced)',
    maxCostMicroUsd: 0,
  },
  {
    id: 'D00-real-preview',
    title: 'T1/T6: real preview on an isolated origin with TLS and a health check',
    track: 'preview',
    targets: ['T1', 'T6'],
    approvals: DEPLOY,
    external: ['NO-HOSTING-NODE'],
    after: ['W01-website'],
    owner: 'P3-S07',
    entry: 'pnpm --filter @nuzm/api track:fg (real mode, preview step)',
    maxCostMicroUsd: 0,
  },
  {
    id: 'D01-preview-deploy-rollback',
    title: 'T1 part 2 / T6: real preview, two releases, rollback verified by content hash',
    track: 'deploy',
    targets: ['T1', 'T6'],
    approvals: DEPLOY,
    external: ['NO-HOSTING-NODE', 'HOST-TRANSPORT-BUILD'],
    after: ['D00-real-preview'],
    owner: 'P3-S07',
    entry: 'pnpm --filter @nuzm/api track:fg (real mode)',
    maxCostMicroUsd: 0,
  },
  {
    id: 'H01-benchmark-stage-a',
    title: 'Track H: benchmark Stage A on the verified model',
    track: 'benchmark',
    targets: [],
    approvals: [...PROVIDER, 'AC-AG-10', 'BUD', 'REV', 'SEC-AG'],
    external: [],
    after: ['P03-codegen'],
    owner: 'P3-S08',
    entry: 'pnpm qualify:h --mode live --stage A',
    maxCostMicroUsd: 4_400_000,
  },
  {
    id: 'Q01-credential-leak-scan',
    title: 'Security: live-run credential leak scan of logs, database, artifacts and evidence',
    track: 'security',
    targets: [],
    approvals: PROVIDER,
    external: [],
    after: ['P03-codegen'],
    owner: 'P3-S08',
    entry: 'harness security driver (scans every surface after the real runs)',
    maxCostMicroUsd: 0,
  },
  {
    id: 'Q02-ledger-reconciliation',
    title: 'Security: wallet, ledger and usage reconcile to the cent after real paid runs',
    track: 'security',
    targets: [],
    approvals: PROVIDER,
    external: [],
    after: ['P03-codegen'],
    owner: 'P3-S08',
    entry: 'harness security driver (reconciliation SQL on the platform database)',
    maxCostMicroUsd: 0,
  },
  // the five Phase 2 synthetic projects: offline today, re-run unchanged with the real model once the loop is real
  {
    id: 'S01-synthetic-business-website',
    title: 'Synthetic project 1: business website (lifecycle, offline)',
    track: 'website',
    targets: ['T1'],
    approvals: [],
    external: [],
    after: [],
    owner: 'P3-S08',
    entry: 'LifecycleRunner over in-memory ports',
    maxCostMicroUsd: 0,
  },
  {
    id: 'S02-synthetic-ecommerce',
    title: 'Synthetic project 2: e-commerce frontend (lifecycle, offline)',
    track: 'website',
    targets: [],
    approvals: [],
    external: [],
    after: [],
    owner: 'P3-S08',
    entry: 'LifecycleRunner over in-memory ports',
    maxCostMicroUsd: 0,
  },
  {
    id: 'S03-synthetic-fullstack',
    title: 'Synthetic project 3: full-stack app (lifecycle, offline)',
    track: 'fullstack',
    targets: ['T2'],
    approvals: [],
    external: [],
    after: [],
    owner: 'P3-S08',
    entry: 'LifecycleRunner over in-memory ports',
    maxCostMicroUsd: 0,
  },
  {
    id: 'S04-synthetic-crm',
    title: 'Synthetic project 4: ERP/CRM module (lifecycle, offline)',
    track: 'fullstack',
    targets: [],
    approvals: [],
    external: [],
    after: [],
    owner: 'P3-S08',
    entry: 'LifecycleRunner over in-memory ports',
    maxCostMicroUsd: 0,
  },
  {
    id: 'S05-synthetic-flutter',
    title: 'Synthetic project 5: Flutter app (lifecycle, offline)',
    track: 'mobile',
    targets: ['T3'],
    approvals: [],
    external: [],
    after: [],
    owner: 'P3-S08',
    entry: 'LifecycleRunner over in-memory ports',
    maxCostMicroUsd: 0,
  },
];
export const byId = (id: string): Scenario | undefined => SCENARIOS.find((s) => s.id === id);
/** the five synthetic projects have no real counterpart in a live run: the real model re-runs them through W01, F01 and M01 */
export const isOfflineOnly = (s: Scenario): boolean => /^S\d\d-/.test(s.id);
