import type { SafeRequest, SafeResponse } from '@nuzm/domain';

/**
 * Thin ports of the automation module (M11). Everything the engine does to the outside world goes through one of these, so (a) the real service of another
 * milestone is ONE wiring change, (b) tests inject fakes that record effects by idempotency key, and (c) nothing here can reach a platform secret.
 *
 * M09 (AI core and builder) is NOT on this base: `AiRunPort` and `DeploymentPort` default to "unavailable" implementations that fail a step with the
 * non-retryable code `m09_unavailable`. Anything that touches them is NOT VERIFIED (docs/reports/M11-m09-interface-assumptions.md).
 */
export class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly opts: { retryable?: boolean; httpStatus?: number; uncertain?: boolean } = {},
  ) {
    super(message);
    this.name = 'ActionError';
  }
  get retryable() {
    return this.opts.retryable === true;
  }
  get httpStatus() {
    return this.opts.httpStatus;
  }
  /** The effect MAY have happened (timeout after send, connection reset): a non-idempotent step is parked, never retried blind. */
  get uncertain() {
    return this.opts.uncertain === true;
  }
}

/** Starts an AI run through the gateway (M09 `POST /v1/ai/runs`). */
export abstract class AiRunPort {
  abstract start(i: {
    orgId: string;
    kind: string;
    prompt: string;
    projectId?: string;
    idempotencyKey: string;
    dataRegion: string;
  }): Promise<{ runId: string; status: string }>;
}
export class UnavailableAiRunPort extends AiRunPort {
  start(): Promise<never> {
    return Promise.reject(new ActionError('m09_unavailable', 'the AI run service (M09) is not available on this deployment', { retryable: false }));
  }
}

/** Creates a deployment (M09 `POST /v1/deployments`). */
export abstract class DeploymentPort {
  abstract create(i: { orgId: string; projectId: string; target?: Record<string, unknown>; idempotencyKey: string }): Promise<{ deploymentId: string; status: string }>;
}
export class UnavailableDeploymentPort extends DeploymentPort {
  create(): Promise<never> {
    return Promise.reject(new ActionError('m09_unavailable', 'the deployment service (M09) is not available on this deployment', { retryable: false }));
  }
}

/** A Nuzm API call with a connector's scoped token (first-party connector). */
export abstract class NuzmApiPort {
  abstract call(i: { orgId: string; method: string; path: string; body?: unknown; token: string; idempotencyKey: string }): Promise<{ status: number; body: unknown }>;
}
/** Calls the platform API over HTTP at `NUZM_API_BASE_URL` (an allow-listed first-party host, so it is not subject to the public-address rule). */
export class HttpNuzmApiPort extends NuzmApiPort {
  constructor(private readonly base = process.env.NUZM_API_BASE_URL) {
    super();
  }
  async call(i: Parameters<NuzmApiPort['call']>[0]) {
    if (!this.base) throw new ActionError('unsupported_capability', 'NUZM_API_BASE_URL is not configured', { retryable: false });
    const url = new URL(i.path, this.base);
    if (url.origin !== new URL(this.base).origin) throw new ActionError('ssrf_denied', 'a Nuzm API step can only call the platform API', { retryable: false });
    const res = await fetch(url, {
      method: i.method,
      headers: { authorization: `Bearer ${i.token}`, 'idempotency-key': i.idempotencyKey, 'content-type': 'application/json' },
      body: i.body === undefined ? undefined : JSON.stringify(i.body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, body };
  }
}

/** Sends a transactional message through M08 (`POST /v1/email/messages`). */
export abstract class EmailSendPort {
  abstract send(i: { orgId: string; actorUserId: string; idempotencyKey: string; body: Record<string, unknown> }): Promise<{ messageId: string; state: string }>;
}

/** Residency decision for a tenant-chosen target (M04 hook). Fails closed: the default asks `ResidencyService`, which denies what it cannot classify. */
export abstract class TargetResidencyPort {
  abstract check(i: { orgId: string; host: string; declaredRegion: string; purpose: string; assessmentId?: string | null }): Promise<{ allowed: boolean; reason?: string }>;
}

/** The HTTP client for tenant-chosen URLs (SSRF guarded). */
export abstract class EgressHttpPort {
  abstract request(r: SafeRequest, policy: { allowHosts?: readonly string[]; denyHosts?: readonly string[] }): Promise<SafeResponse>;
}
