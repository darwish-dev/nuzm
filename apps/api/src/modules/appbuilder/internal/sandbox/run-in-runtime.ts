import { executionGateway as eg } from '@nuzm/domain';

/**
 * TRACK D (S-AG6 phase 2): the RUNNABLE entry for "run a project command in the isolated runtime". It runs TODAY in `simulated` mode only (a `SimulatedWorkspaceRuntime`: nothing is
 * executed, the output is a labelled placeholder). The `live` mode is the same code path and REFUSES, before any node contact, unless ALL of these hold:
 *   - a node attestation that verifies in live mode (LIVE-VERIFIED, signed by a trusted reviewer key, bound to the node and endpoint given here, unexpired, not revoked)
 *   - a D-21 decision reference, an HG-10-02 review reference, an accepted-ADR reference and an owner approval reference (the last also confirmed in the environment,
 *     `NUZM_EXECUTION_APPROVED=<ref>`), from which the gate inputs are computed and `executionGate` must be OPEN (staging only: production is refused here)
 *   - a node client exists (none does: `endpoint_client_unavailable`)
 * It is not imported by any module or route, runs nothing on the machine it is started on, and takes the profile name only: the argv is the gateway policy's.
 */
export interface RunInRuntimeInput {
  mode: 'simulated' | 'live';
  endpoint: string;
  profile: string;
  params?: Record<string, unknown>;
  files: ReadonlyMap<string, string>;
  /** the human approval id for a profile that needs one (`install-deps`, `run-script`) */
  approvalId?: string;
  attestation?: unknown;
  trust?: eg.TrustedKeys;
  nodeId?: string;
  endpointId?: string;
  refs?: { d21?: string; hg1002?: string; adr?: string; approval?: string };
  env?: Record<string, string | undefined>;
  now?: () => number;
  connect?: (endpoint: string) => Promise<eg.WorkspaceRuntime | null>;
  projectScripts?: readonly string[];
}
export interface RunInRuntimeResult {
  label: 'SIMULATED' | 'LIVE';
  statement: string;
  decision: { profile: string; argv: string[]; network: string; requiresApproval: boolean };
  outcome: eg.ExecutionOutcome;
  origin: 'MOCK' | 'REAL';
}
export class RunRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`run refused: ${reasons.join(',')}`);
    this.name = 'RunRefused';
  }
}
const SIM_STATEMENT =
  'SIMULATED: nothing was executed and nothing was isolated; the output below is a placeholder from a stand-in node, not a build or test result.';

export async function runInRuntime(i: RunInRuntimeInput): Promise<RunRefusedOrResult> {
  const now = i.now ?? (() => Date.now());
  const env = i.env ?? {};
  const why: string[] = [];
  if (i.mode === 'simulated') {
    if (!/^simulated:[a-z0-9-]{1,40}$/.test(i.endpoint))
      why.push('only_simulated_endpoints_in_simulated_mode');
  } else {
    const r = i.refs ?? {};
    if (!r.d21 || !/^D-21/.test(r.d21)) why.push('d21_reference_missing');
    if (!r.hg1002 || !/^HG-10-02/.test(r.hg1002)) why.push('hg_10_02_reference_missing');
    if (!r.adr || !/^ADR-/.test(r.adr)) why.push('adr_acceptance_reference_missing');
    if (!r.approval) why.push('approval_reference_missing');
    else if (env.NUZM_EXECUTION_APPROVED !== r.approval)
      why.push('approval_not_confirmed_in_environment');
    if (!i.nodeId || !i.endpointId) why.push('node_binding_missing');
    if (i.attestation === undefined || i.attestation === null) why.push('attestation_missing');
    if (/^simulated:/.test(i.endpoint)) why.push('simulated_endpoint_cannot_be_live');
  }
  if (why.length > 0) throw new RunRefused(why);

  const connect = i.connect ?? (async (ep: string) => defaultSim(ep));
  const node = await connect(i.endpoint);
  if (!node) throw new RunRefused(['endpoint_client_unavailable']);
  const ident = await node.identity();

  let svc: eg.RealRuntimeService;
  try {
    if (i.mode === 'simulated') {
      const kit = eg.createSimulatedKit();
      const n = { nodeId: ident.nodeId, endpointId: ident.endpointId };
      svc = await eg.RealRuntimeService.start({
        mode: 'simulated',
        nodes: [{ ...n, runtime: node, attestation: kit.attestation(n, { now: new Date(now()) }) }],
        trust: kit.trusted,
        environments: ['staging'],
        now,
      });
    } else {
      svc = await eg.RealRuntimeService.start({
        mode: 'live',
        nodes: [
          {
            nodeId: i.nodeId!,
            endpointId: i.endpointId!,
            runtime: node,
            attestation: i.attestation,
          },
        ],
        trust: i.trust ?? {},
        environments: ['staging'], // production is never reachable from this entry
        now,
      });
    }
  } catch (e) {
    if (e instanceof eg.AttestationRefused)
      throw new RunRefused(e.reasons.map((r) => `attestation:${r}`));
    throw e;
  }
  if (i.mode === 'live') {
    // the gate inputs are computed from the references and from the verified attestation, never from flags typed on a command line
    const att = (svc.status()[0] as { attestationId: string }).attestationId;
    const gate = eg.executionGate({
      d21Decided: true,
      runtimeVerified: att.length > 0,
      escapeSuitePassed: true, // verifyAttestation already required every isolating attempt blocked and none escaped
      adrAccepted: true,
      ownerApproved: true,
      production: false,
      rolloutDecided: false,
    });
    if (!gate.open) throw new RunRefused(gate.blockers.map(() => 'gate_closed'));
  }

  const ctx: eg.ExecContext = {
    orgId: 'org-cli',
    runId: `run-cli-${now()}`,
    enabledProfiles: ['typecheck', 'unit-tests', 'build', 'run-script', 'install-deps'],
    projectScripts: i.projectScripts ?? [],
  };
  const port = svc.portFor(ctx, { seedFiles: () => i.files, canaries: () => [] });
  const decision = await port.request({
    orgId: ctx.orgId,
    runId: ctx.runId,
    profile: i.profile,
    params: i.params,
  });
  if (!decision.allowed) throw new RunRefused(decision.reasons.map((r) => `policy:${r}`));
  const outcome = await port.run(decision, {
    orgId: ctx.orgId,
    runId: ctx.runId,
    approvalId: i.approvalId,
  });
  return {
    label: i.mode === 'live' ? 'LIVE' : 'SIMULATED',
    statement: i.mode === 'live' ? 'LIVE run on an attested staging node' : SIM_STATEMENT,
    decision: {
      profile: decision.profile,
      argv: decision.argv,
      network: decision.network,
      requiresApproval: decision.requiresApproval,
    },
    outcome,
    origin: port.origin,
  };
}
export type RunRefusedOrResult = RunInRuntimeResult;

function defaultSim(endpoint: string): eg.WorkspaceRuntime | null {
  const m = /^simulated:([a-z0-9-]{1,40})$/.exec(endpoint);
  if (!m) return null;
  const rt = new eg.SimulatedWorkspaceRuntime({
    nodeId: m[1]!,
    endpointId: `simulated-${m[1]}`,
    runtimeClass: 'gvisor-runsc',
    imageDigests: [eg.SIMULATED_IMAGE_DIGEST],
  });
  rt.setScript(() => ({ exitCode: 0, stdout: '[SIMULATED] nothing was executed\n' }));
  return rt;
}
