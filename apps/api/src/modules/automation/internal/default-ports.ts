import { SafeHttpClient, DEFAULT_EGRESS, type SafeRequest, type SafeResponse } from '@nuzm/domain';
import type { ResidencyService } from '../../compliance';
import type { MessageService } from '../../email';
import { ActionError, EgressHttpPort, EmailSendPort, TargetResidencyPort } from './ports';

/** Tenant-chosen URLs leave only through the SSRF-guarded client; per-organization allow/deny lists narrow it further. */
export class GuardedEgressPort extends EgressHttpPort {
  constructor(private readonly client: SafeHttpClient = new SafeHttpClient(DEFAULT_EGRESS)) {
    super();
  }
  request(
    r: SafeRequest,
    policy: { allowHosts?: readonly string[]; denyHosts?: readonly string[] },
  ): Promise<SafeResponse> {
    if (!policy.allowHosts?.length && !policy.denyHosts?.length) return this.client.request(r);
    return new SafeHttpClient({
      ...DEFAULT_EGRESS,
      allowHosts: policy.allowHosts,
      denyHosts: policy.denyHosts,
    }).request(r);
  }
}

/** M08 transactional email (category fixed to `transactional`: marketing/bulk is blocked by M08 policy). */
export class MessageEmailPort extends EmailSendPort {
  constructor(private readonly messages: Pick<MessageService, 'send'>) {
    super();
  }
  async send(i: Parameters<EmailSendPort['send']>[0]) {
    const body = Object.fromEntries(
      Object.entries(i.body).filter(([, v]) => v !== undefined && v !== null),
    );
    const m = await this.messages.send(i.orgId, i.actorUserId, i.idempotencyKey, body);
    return { messageId: m.id, state: String((m as { status?: string }).status ?? 'queued') };
  }
}

/**
 * Residency for a tenant-chosen target: the declared region is evaluated by M04 (`ResidencyService.evaluate`, FAIL CLOSED). The default `unverified` region
 * is never allowed in-Kingdom-only mode, so an HTTP step must name a region (connector `hostRegion`) or carry an approved transfer assessment. The declared region is
 * the tenant's own statement and is NOT VERIFIED against where the host really runs (no geolocation in M11).
 */
export class ResidencyTargetPort extends TargetResidencyPort {
  constructor(private readonly residency: Pick<ResidencyService, 'evaluate'>) {
    super();
  }
  async check(i: Parameters<TargetResidencyPort['check']>[0]) {
    try {
      const r = await this.residency.evaluate({
        orgId: i.orgId,
        dataClass: 'customer-content',
        targetRegion: i.declaredRegion,
        purpose: i.purpose,
        operation: 'write',
      });
      if (r.decision === 'allow') return { allowed: true };
      if (
        r.decision === 'requires_assessment' &&
        i.assessmentId &&
        r.assessmentId === i.assessmentId
      )
        return { allowed: true };
      return {
        allowed: false,
        reason: r.reasons[0]?.message.en ?? 'denied by the residency policy',
      };
    } catch (e) {
      throw new ActionError(
        'residency_denied',
        `residency could not be evaluated: ${(e as Error).message}`,
        { retryable: false },
      );
    }
  }
}
