import { seal, type Label, type Track } from './verify';

/**
 * P3-S08: test vectors for the evidence verifier and the matrix. They are SYNTHETIC: the hashes are made up and no run happened. They exist only in tests and are never
 * written under `docs/phase3/EVIDENCE/<track>/`. `liveRecord(track)` is a record in the shape a real run must produce; the tests mutate it to prove each rejection.
 */
export const H = (n: number): string => n.toString(16).padStart(64, '0');
const usage = { requests: 4, tokensIn: 1200, tokensOut: 800 };
const model = { provider: 'anthropic', id: 'claude-opus-5-5' };
const tsA = '2026-12-01T10:00:00Z';
const tsB = '2026-12-01T10:04:30Z';

export const DETAILS: Record<Track, Record<string, unknown>> = {
  provider: {
    track: 'A',
    provider: 'anthropic',
    model: model.id,
    usage,
    usageReconciled: true,
    keyLeakScan: 'clean',
  },
  'tool-calling': {
    track: 'B',
    model: model.id,
    usage,
    toolsDeclared: ['read_file', 'write_file'],
    roundTrips: 2,
    supportsToolsFromEvidence: true,
    malformedToolCalls: 0,
  },
  codegen: {
    track: 'C',
    model: model.id,
    briefId: 'syn-brief-01',
    usage,
    files: 12,
    filesTreeSha256: H(21),
    syntaxChecked: true,
    secretScan: 'clean',
  },
  runtime: {
    track: 'D',
    node: {
      id: 'node-staging-01',
      kernel: '6.8.0',
      sandbox: 'gvisor-systrap',
      sandboxVersion: '20260101',
      imageSha256: H(22),
    },
    escapeSuite: {
      version: '1.1.0',
      runs: 2,
      isolatingAttempts: 65,
      controlPlaneAttempts: 212,
      escaped: 0,
      notVerified: 0,
      canaryRead: false,
    },
    attestation: {
      sha256: H(23),
      reviewer: 'independent-reviewer-1',
      expiresAt: '2026-12-31T00:00:00Z',
    },
    rebuiltNodeBetweenRuns: true,
  },
  'build-repair': {
    track: 'E',
    model: model.id,
    projectId: 'syn-broken-01',
    usage,
    rounds: 3,
    repairLimit: 5,
    errorClasses: ['type-error', 'missing-import', 'failing-test'],
    initialBuild: 'FAILED',
    finalBuild: 'GREEN',
    attempts: [
      {
        round: 1,
        errorClass: 'type-error',
        errorSha256: H(31),
        patchSha256: H(32),
        result: 'STILL_FAILING',
      },
      {
        round: 2,
        errorClass: 'missing-import',
        errorSha256: H(33),
        patchSha256: H(34),
        result: 'STILL_FAILING',
      },
      {
        round: 3,
        errorClass: 'failing-test',
        errorSha256: H(35),
        patchSha256: H(36),
        result: 'GREEN',
      },
    ],
  },
  preview: {
    track: 'F',
    previewHost: 'p-1a2b3c4d5e6f7a8b.preview.example.test',
    isolatedOrigin: true,
    healthStatus: 200,
    tls: { issuer: 'staging-ca', validNotAfter: '2027-02-01T00:00:00Z', verified: true },
    servedContentSha256: H(41),
    artifactSha256: H(41),
  },
  deploy: {
    track: 'G',
    target: { id: 'staging-01', provider: 'contabo', region: 'eu' },
    releases: [
      {
        releaseId: 'rel-1',
        contentSha256: H(51),
        urlChecks: [{ path: '/', status: 200, bodySha256: H(52) }],
      },
      {
        releaseId: 'rel-2',
        contentSha256: H(53),
        urlChecks: [{ path: '/', status: 200, bodySha256: H(54) }],
      },
    ],
    ssl: { issued: true, verified: true },
    rollback: {
      fromReleaseId: 'rel-2',
      toReleaseId: 'rel-1',
      servedSha256AfterRollback: H(51),
      equalsTargetReleaseHash: true,
      ownApprovalRef: 'approval-rb-1',
    },
    teardown: 'done',
  },
  benchmark: {
    track: 'H',
    stage: 'A',
    model: model.id,
    dataset: { version: '2.1.0', sha256: H(61), tasks: 83 },
    thresholdsVersion: 'thresholds-1',
    thresholdsAcceptedBy: 'owner',
    reviewers: ['reviewer-1', 'reviewer-2', 'reviewer-3'],
    scoredTasks: 83,
    notRecorded: 0,
    thresholdResults: [{ id: 'T01', status: 'PASS', actual: 0.9 }],
    reportFingerprint: H(62),
    usage,
  },
  mobile: {
    track: 'M',
    platform: 'android',
    projectId: 'syn-flutter-01',
    toolchain: { flutter: '3.35.7', 'android-sdk': '35', java: '17' },
    analyze: 'clean',
    unitTests: { passed: 14, failed: 0 },
    artifact: { kind: 'apk-debug', sha256: H(71), bytes: 18_000_000 },
    install: { method: 'emulator', launched: true, result: 'PASS' },
    signing: 'debug-test-key',
    productionKeyUsed: false,
  },
  website: {
    track: 'W',
    model: model.id,
    language: 'ar',
    briefId: 'syn-brief-ar',
    usage,
    pages: 6,
    qa: {
      axeViolations: 0,
      brokenLinks: 0,
      cspStrict: true,
      sizeBudgetOk: true,
      rtlVerified: true,
    },
    artifactSha256: H(81),
  },
  fullstack: {
    track: 'S',
    model: model.id,
    briefId: 'syn-crm',
    usage,
    build: 'GREEN',
    migrations: { applied: 3, databaseKind: 'ephemeral-postgres' },
    tests: {
      signupLoginLogout: 'PASS',
      authenticatedCrud: 'PASS',
      unauthenticatedRejected: 'PASS',
      crossUserIsolation: 'PASS',
    },
    dbIsolationProof: 'PASS',
    platformSecretsInAppEnv: false,
    artifactSha256: H(91),
  },
  security: {
    track: 'Q',
    kind: 'credential-leak-scan',
    surfacesScanned: ['logs', 'database', 'artifacts', 'responses', 'audit-rows', 'evidence-files'],
    findings: 0,
  },
};
const TRACK_TARGETS: Record<Track, string[]> = {
  provider: ['T1', 'T3', 'T5'],
  'tool-calling': ['T2'],
  codegen: ['T3'],
  runtime: ['T2', 'T5'],
  'build-repair': ['T5'],
  preview: ['T1', 'T6'],
  deploy: ['T1', 'T2', 'T6'],
  benchmark: [],
  mobile: ['T3'],
  website: ['T1'],
  fullstack: ['T2'],
  security: [],
};

export function baseRecord(
  track: Track,
  label: Label,
  id = `${track}-fixture-1`,
): Record<string, unknown> {
  const live = label === 'LIVE-VERIFIED';
  const o: Record<string, unknown> = {
    schema: 'nuzm.p3-evidence/1',
    id,
    track,
    targets: TRACK_TARGETS[track],
    component: `p3-${track}-entry`,
    label,
    result: label === 'NOT VERIFIED' ? 'NOT_VERIFIED' : 'PASS',
    recordedAt: '2026-12-01T10:05:00Z',
    startedAt: tsA,
    finishedAt: tsB,
    durationMs: 270_000,
    revision: { commit: 'abcdef1234567', branch: 'integration/phase3' },
    components: [
      { name: `p3-${track}-entry`, version: '1.0.0', origin: live ? 'real' : 'simulated', label },
    ],
    approvals: live
      ? [
          {
            id: 'D9',
            ref: 'APPR-2026-12-01-D9',
            recordedIn: 'docs/parallel/OWNER-APPROVAL-PACK.md#6',
          },
        ]
      : [],
    inputs: [{ name: 'synthetic-brief', sha256: H(1) }],
    outputs: [{ name: 'artifact', sha256: H(2), bytes: 1000 }],
    cost: { currency: 'USD', unit: 'micro', usedMinor: live ? '120000' : '0', maxMinor: '500000' },
    checks: [{ id: 'primary', label, result: label === 'NOT VERIFIED' ? 'NOT_VERIFIED' : 'PASS' }],
    blockers:
      label === 'NOT VERIFIED'
        ? [{ id: 'B-1', text: 'live validation missing: approval not recorded' }]
        : [],
    details: DETAILS[track],
  };
  if (live) o.identity = { model };
  return o;
}
/** a sealed (valid) record */
export const liveRecord = (track: Track, id?: string) =>
  seal(baseRecord(track, 'LIVE-VERIFIED', id));
export const simulatedRecord = (track: Track, id?: string) =>
  seal(baseRecord(track, 'SIMULATED', id));
export const notVerifiedRecord = (track: Track, id?: string) =>
  seal(baseRecord(track, 'NOT VERIFIED', id));
