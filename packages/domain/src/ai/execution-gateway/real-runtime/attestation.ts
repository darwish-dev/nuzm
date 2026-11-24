import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { ACCEPTABLE_RUNTIME_CLASSES } from '../runtime-spec';

/**
 * S-AG6 PHASE 2 (OFFLINE): the ISOLATION ATTESTATION record a runtime node must hold before the real-runtime port starts. The attestation is the machine-checkable form of the
 * HG-10-02 security review: it names the node, the runtime class and image digests, the host properties that were inspected, the escape-suite report that was run against THAT
 * node and the human reviewer who signed. `verifyAttestation` is fail-closed: anything missing, malformed, stale, mismatched, simulated (in live mode) or unsigned is a refusal.
 *
 * An attestation is EVIDENCE OF A REVIEW, not isolation by itself: it is only as good as the review behind it. The signing key belongs to the named reviewer, never to this
 * repository or the runner; nothing in this repository can produce a LIVE-VERIFIED attestation (the test helpers produce SIMULATED ones with a throw-away test key).
 */
export const ATTESTATION_SCHEMA = 'nuzm.runtime-attestation/1' as const;
export type EvidenceLabel = 'LIVE-VERIFIED' | 'SIMULATED' | 'NOT VERIFIED';
export type NodeEnvironment = 'staging' | 'production';

export interface IsolationAttestation {
  schema: typeof ATTESTATION_SCHEMA;
  attestationId: string;
  node: {
    nodeId: string;
    /** a stable id of the endpoint the control plane dials (not a secret, not a URL with credentials) */
    endpointId: string;
    environment: NodeEnvironment;
    os: 'linux';
    kernel: string;
    arch: 'x86_64' | 'aarch64';
  };
  runtime: {
    class: string;
    version: string;
    /** `sha256:<64 hex>` digests of every image the node may start */
    imageDigests: string[];
  };
  host: {
    cgroupsV2: boolean;
    /** the node is dedicated: no other tenant workload, no platform service, no secret on it */
    dedicatedNode: boolean;
    /** `bare-metal` or `nested-virt` for microVM classes, `n/a` for gVisor */
    virtualization: 'bare-metal' | 'nested-virt' | 'n/a';
    swapDisabled: boolean;
    containerRuntimeSocketNotExposed: boolean;
    egress: 'default-deny-proxy-only';
    diskQuota: 'project-quota' | 'per-workspace-volume';
    metadataServiceBlocked: boolean;
  };
  evidence: {
    label: EvidenceLabel;
    escapeSuite: {
      version: string;
      /** sha256 of the suite report file the reviewer inspected */
      reportSha256: string;
      isolatingAttempts: number;
      blocked: number;
      escaped: number;
      notVerified: number;
    };
    securityReview: { ref: string; reviewer: string; decidedAt: string };
    decisionRefs: { d21: string };
  };
  issuedAt: string;
  expiresAt: string;
  signer: { keyId: string };
  /** base64 ed25519 signature over `canonicalJson(attestation without signature)` */
  signature: string;
}

export interface AttestationExpectation {
  /** the node the control plane is about to use: it must be the node the attestation names */
  nodeId: string;
  endpointId: string;
  /** `live` requires LIVE-VERIFIED evidence; `simulated` requires SIMULATED evidence and the port then reports origin MOCK */
  mode: 'live' | 'simulated';
  /** environments this process may use (a staging process never accepts a production node and the other way round) */
  environments: readonly NodeEnvironment[];
  minSuiteVersion: string;
  /** the suite must have run at least this many isolating attempts (the XR-* set) */
  minIsolatingAttempts: number;
  /** longest validity the control plane accepts, in days */
  maxValidityDays: number;
  now: Date;
  isRevoked?: (attestationId: string) => boolean;
}
/** public keys the control plane trusts, by key id (PEM SPKI). Public material only. */
export type TrustedKeys = Readonly<Record<string, string>>;

export type AttestationVerdict =
  { ok: true; attestation: IsolationAttestation } | { ok: false; reasons: string[] };

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SEMVER = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Deterministic JSON: object keys sorted at every level; the signed bytes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}
export function attestationSigningBytes(a: Omit<IsolationAttestation, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(a), 'utf8');
}
const cmpVersion = (a: string, b: string): number | null => {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  return 0;
};
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * Verify an attestation against the expectation of THIS process. Never throws: every problem is a reason code (no content, no key material in the reasons).
 * An absent attestation (`null`/`undefined`) is `attestation_missing`.
 */
export function verifyAttestation(
  raw: unknown,
  expect: AttestationExpectation,
  trusted: TrustedKeys,
): AttestationVerdict {
  const r = new Set<string>();
  if (raw === null || raw === undefined) return { ok: false, reasons: ['attestation_missing'] };
  if (!isObj(raw)) return { ok: false, reasons: ['attestation_malformed'] };
  const a = raw as Partial<IsolationAttestation> & Record<string, unknown>;
  if (a.schema !== ATTESTATION_SCHEMA) r.add('schema_unknown');
  const node = isObj(a.node) ? a.node : null;
  const runtime = isObj(a.runtime) ? a.runtime : null;
  const host = isObj(a.host) ? a.host : null;
  const ev = isObj(a.evidence) ? a.evidence : null;
  const suite = ev && isObj(ev.escapeSuite) ? ev.escapeSuite : null;
  const review = ev && isObj(ev.securityReview) ? ev.securityReview : null;
  const decisions = ev && isObj(ev.decisionRefs) ? ev.decisionRefs : null;
  const signer = isObj(a.signer) ? a.signer : null;
  if (
    !node ||
    !runtime ||
    !host ||
    !ev ||
    !suite ||
    !review ||
    !decisions ||
    !signer ||
    !str(a.attestationId)
  )
    return { ok: false, reasons: [...r, 'attestation_malformed'] };

  // ---- the node and the endpoint this process is about to use
  if (node.nodeId !== expect.nodeId) r.add('node_mismatch');
  if (node.endpointId !== expect.endpointId) r.add('endpoint_mismatch');
  if (!expect.environments.includes(node.environment as NodeEnvironment))
    r.add('environment_not_allowed');
  if (node.os !== 'linux') r.add('os_not_linux');
  if (!str(node.kernel, 80)) r.add('kernel_missing');
  if (node.arch !== 'x86_64' && node.arch !== 'aarch64') r.add('arch_unknown');

  // ---- runtime class: a plain container is not an isolating class
  if (!(ACCEPTABLE_RUNTIME_CLASSES as readonly string[]).includes(String(runtime.class)))
    r.add('runtime_class_not_isolating');
  if (!str(runtime.version, 60)) r.add('runtime_version_missing');
  const digests = Array.isArray(runtime.imageDigests) ? runtime.imageDigests : null;
  if (!digests || digests.length === 0 || digests.length > 50) r.add('image_digests_missing');
  else if (!digests.every((d) => typeof d === 'string' && SHA256_DIGEST.test(d)))
    r.add('image_digest_not_pinned');

  // ---- host properties that were inspected
  if (host.cgroupsV2 !== true) r.add('cgroups_v2_missing');
  if (host.dedicatedNode !== true) r.add('node_not_dedicated');
  if (host.swapDisabled !== true) r.add('swap_enabled');
  if (host.containerRuntimeSocketNotExposed !== true) r.add('runtime_socket_exposed');
  if (host.metadataServiceBlocked !== true) r.add('metadata_service_reachable');
  if (host.egress !== 'default-deny-proxy-only') r.add('egress_not_default_deny');
  if (host.diskQuota !== 'project-quota' && host.diskQuota !== 'per-workspace-volume')
    r.add('disk_quota_missing');
  const microVm =
    runtime.class === 'firecracker-microvm' || String(runtime.class).startsWith('kata-');
  if (microVm && host.virtualization !== 'bare-metal' && host.virtualization !== 'nested-virt')
    r.add('virtualization_missing');

  // ---- evidence label
  if (expect.mode === 'live' && ev.label !== 'LIVE-VERIFIED') r.add('evidence_not_live_verified');
  if (expect.mode === 'simulated' && ev.label !== 'SIMULATED') r.add('evidence_label_mismatch');
  if (ev.label !== 'LIVE-VERIFIED' && ev.label !== 'SIMULATED') r.add('evidence_label_invalid');

  // ---- the escape suite that was run against THIS node
  const sv =
    typeof suite.version === 'string' ? cmpVersion(suite.version, expect.minSuiteVersion) : null;
  if (sv === null || sv < 0) r.add('escape_suite_version_too_old');
  if (typeof suite.reportSha256 !== 'string' || !SHA256_HEX.test(suite.reportSha256))
    r.add('escape_suite_report_unhashed');
  const iso = suite.isolatingAttempts;
  const blocked = suite.blocked;
  if (!Number.isInteger(iso) || (iso as number) < expect.minIsolatingAttempts)
    r.add('escape_suite_incomplete');
  if (suite.escaped !== 0) r.add('escape_suite_escaped');
  if (suite.notVerified !== 0) r.add('escape_suite_not_verified_remaining');
  if (!Number.isInteger(blocked) || blocked !== iso) r.add('escape_suite_not_all_blocked');

  // ---- review and decisions
  if (!str(review.ref) || !/^HG-10-02/.test(String(review.ref))) r.add('security_review_missing');
  if (!str(review.reviewer, 120)) r.add('reviewer_missing');
  if (typeof review.decidedAt !== 'string' || !ISO.test(review.decidedAt))
    r.add('review_date_invalid');
  if (!str(decisions.d21, 120) || !/^D-21/.test(String(decisions.d21)))
    r.add('d21_reference_missing');

  // ---- validity window
  const issued =
    typeof a.issuedAt === 'string' && ISO.test(a.issuedAt) ? Date.parse(a.issuedAt) : NaN;
  const expires =
    typeof a.expiresAt === 'string' && ISO.test(a.expiresAt) ? Date.parse(a.expiresAt) : NaN;
  const now = expect.now.getTime();
  if (Number.isNaN(issued) || Number.isNaN(expires)) r.add('validity_dates_invalid');
  else {
    if (issued > now) r.add('issued_in_the_future');
    if (expires <= now) r.add('attestation_expired');
    if (expires <= issued) r.add('validity_window_invalid');
    else if ((expires - issued) / 86_400_000 > expect.maxValidityDays) r.add('validity_too_long');
  }
  if (expect.isRevoked?.(String(a.attestationId))) r.add('attestation_revoked');

  // ---- signature over everything else, by a trusted key
  const keyPem =
    typeof signer.keyId === 'string'
      ? Object.getOwnPropertyDescriptor(trusted, signer.keyId)?.value
      : undefined;
  if (typeof keyPem !== 'string') r.add('signer_not_trusted');
  else if (typeof a.signature !== 'string' || a.signature.length < 20) r.add('signature_missing');
  else {
    try {
      const { signature, ...rest } = a;
      const ok = cryptoVerify(
        null,
        attestationSigningBytes(rest as Omit<IsolationAttestation, 'signature'>),
        createPublicKey(keyPem),
        Buffer.from(signature, 'base64'),
      );
      if (!ok) r.add('signature_invalid');
    } catch {
      r.add('signature_invalid');
    }
  }
  return r.size === 0
    ? { ok: true, attestation: raw as unknown as IsolationAttestation }
    : { ok: false, reasons: [...r] };
}
