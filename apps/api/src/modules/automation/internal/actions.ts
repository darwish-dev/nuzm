import { SsrfError, renderTemplate, evalExpression, type SafeResponse, type StepDef } from '@nuzm/domain';
import { ProblemException } from '../../../common/errors';
import type { ConnectorService, ResolvedConnector } from './connector.service';
import { scopeCovers, type AutomationConfig } from './model';
import { ActionError, AiRunPort, DeploymentPort, EgressHttpPort, EmailSendPort, NuzmApiPort, TargetResidencyPort } from './ports';

export interface StepRuntime {
  orgId: string;
  executionId: string;
  stepKey: string;
  attempt: number;
  /** sha256(rootExecutionId|stepKey|attemptGroup): identical for every retry and every replay of the logical step. */
  idempotencyKey: string;
  idempotent: boolean;
  dataRegion: string;
  actorUserId: string;
}
export interface ActionOutcome {
  output: unknown;
  /** Secret values this step handled: removed from everything that is persisted. */
  secrets: string[];
  billable: boolean;
  connectorId?: string;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const FORBIDDEN_HEADERS = /^(host|content-length|connection|transfer-encoding|upgrade|te|trailer|expect|proxy-.*|x-forwarded-.*|forwarded|cookie|set-cookie)$/i;

/** Render every `{{ ... }}` in a params tree. Keys are never rendered. `expr`/`over` are expressions and are handled by their step types. */
export function renderParams(v: unknown, scope: Record<string, unknown>, depth = 0): Json {
  if (depth > 10) throw new ActionError('params_too_deep', 'parameters are nested too deeply');
  if (typeof v === 'string') return renderTemplate(v, scope);
  if (Array.isArray(v)) return v.map((x) => renderParams(x, scope, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderParams(x, scope, depth + 1)]));
  return v as Json;
}

const hostAllowed = (host: string, allowed: string[]) => allowed.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h));

/**
 * Executes ONE step's action. It never retries, never persists and never decides what a failure means: it throws an `ActionError` that says whether a retry
 * can help (`retryable`) and whether the effect may have happened (`uncertain`); the engine owns the policy. Connector use is gated here (fail closed),
 * the residency decision for the target is asked BEFORE the call, and tenant-supplied URLs only ever leave through the SSRF-guarded egress client.
 */
export class ActionRunner {
  constructor(
    private readonly connectors: Pick<ConnectorService, 'resolve' | 'acquire' | 'rateOf' | 'outcome'>,
    private readonly egress: EgressHttpPort,
    private readonly nuzm: NuzmApiPort,
    private readonly email: EmailSendPort,
    private readonly ai: AiRunPort,
    private readonly deploy: DeploymentPort,
    private readonly residency: TargetResidencyPort,
    private readonly cfg: AutomationConfig,
    private readonly egressLists: (orgId: string) => Promise<{ allowHosts?: string[]; denyHosts?: string[] }> = async () => ({}),
  ) {}

  async run(step: StepDef, scope: Record<string, unknown>, rt: StepRuntime): Promise<ActionOutcome> {
    const p = renderParams(step.params, scope) as Record<string, Json>;
    switch (step.type) {
      case 'http_request':
        return this.http(step, p, scope, rt);
      case 'nuzm_api':
        return this.nuzmApi(p, rt);
      case 'send_email': {
        const r = await this.email.send({
          orgId: rt.orgId,
          actorUserId: rt.actorUserId,
          idempotencyKey: rt.idempotencyKey,
          body: { senderId: p.senderId, to: p.to, subject: p.subject, html: p.html, text: p.text, templateId: p.templateId, variables: p.variables, category: 'transactional' },
        }).catch(mapKnown);
        return { output: { messageId: r.messageId, state: r.state }, secrets: [], billable: true };
      }
      case 'start_ai_run': {
        const r = await this.ai.start({ orgId: rt.orgId, kind: String(p.kind), prompt: String(p.prompt), projectId: typeof p.projectId === 'string' ? p.projectId : undefined, idempotencyKey: rt.idempotencyKey, dataRegion: rt.dataRegion });
        return { output: { runId: r.runId, status: r.status }, secrets: [], billable: true };
      }
      case 'create_deployment': {
        const r = await this.deploy.create({ orgId: rt.orgId, projectId: String(p.projectId), target: (p.target as Record<string, unknown> | undefined) ?? undefined, idempotencyKey: rt.idempotencyKey });
        return { output: { deploymentId: r.deploymentId, status: r.status }, secrets: [], billable: true };
      }
      default:
        throw new ActionError('unsupported_step', `step type ${step.type} is not an action`);
    }
  }

  private async useConnector(orgId: string, id: string, scope: string | undefined): Promise<ResolvedConnector> {
    const c = await this.connectors.resolve(orgId, id, scope); // throws 403 connector_not_authorized: the step fails closed
    this.connectors.acquire(id, await this.connectors.rateOf(orgId, id));
    return c;
  }

  private async http(step: StepDef, p: Record<string, Json>, _scope: Record<string, unknown>, rt: StepRuntime): Promise<ActionOutcome> {
    const method = String(p.method ?? 'GET').toUpperCase();
    const url = String(p.url);
    const connectorId = typeof step.params.connectorId === 'string' ? step.params.connectorId : undefined;
    const conn = connectorId ? await this.useConnector(rt.orgId, connectorId, typeof p.scope === 'string' ? p.scope : undefined) : undefined;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new ActionError('ssrf_denied', 'the URL cannot be parsed', { retryable: false });
    }
    const allowedHosts = conn?.config.allowedHosts as string[] | undefined;
    if (allowedHosts && !hostAllowed(host, allowedHosts)) throw new ActionError('host_not_allowed', 'the host is not allowed by the connector', { retryable: false });
    const region = String(conn?.config.hostRegion ?? p.region ?? this.cfg.defaultTargetRegion);
    const res = await this.residency.check({ orgId: rt.orgId, host, declaredRegion: region, purpose: 'workflow.http', assessmentId: conn?.transferAssessmentId });
    if (!res.allowed) throw new ActionError('residency_denied', res.reason ?? 'the data residency policy does not allow this target', { retryable: false });

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((p.headers as Record<string, Json> | undefined) ?? {})) {
      if (FORBIDDEN_HEADERS.test(k) || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(k)) throw new ActionError('invalid_header', `the header ${k} is not allowed`, { retryable: false });
      headers[k.toLowerCase()] = String(v ?? '');
    }
    const secrets: string[] = [];
    if (conn?.secret) {
      secrets.push(conn.secret);
      const t = conn.config.authType ?? (conn.type === 'oauth2' ? 'bearer' : 'none');
      if (t === 'bearer') headers.authorization = `Bearer ${conn.secret}`;
      else if (t === 'header') headers[String(conn.config.headerName ?? 'x-api-key').toLowerCase()] = conn.secret;
    }
    if (typeof step.idempotencyKey === 'string') headers['idempotency-key'] = String(renderTemplate(step.idempotencyKey, _scope));
    else if (['PUT', 'DELETE'].includes(method)) headers['idempotency-key'] = rt.idempotencyKey;
    let body: string | undefined;
    if (p.body !== undefined && p.body !== null && !['GET', 'HEAD'].includes(method)) {
      body = typeof p.body === 'string' ? p.body : JSON.stringify(p.body);
      if (typeof p.body !== 'string' && !headers['content-type']) headers['content-type'] = 'application/json';
    }
    if (body !== undefined && Buffer.byteLength(body) > 1024 * 1024) throw new ActionError('body_too_large', 'the request body is larger than 1 MB', { retryable: false });
    let res2: SafeResponse;
    try {
      res2 = await this.egress.request({ url, method, headers, body }, await this.egressLists(rt.orgId));
    } catch (e) {
      if (conn) this.connectors.outcome(conn.id, false);
      if (e instanceof SsrfError) {
        const transient = e.code === 'timeout' || e.code === 'transport_error' || e.code === 'dns_failed';
        // a timeout / reset AFTER the request left may have had its effect: uncertain (never retried blindly unless the step is idempotent)
        throw new ActionError(transient ? e.code : 'ssrf_denied', e.message, { retryable: transient, uncertain: e.code === 'timeout' || e.code === 'transport_error' });
      }
      throw e;
    }
    const status = res2.status;
    if (conn) this.connectors.outcome(conn.id, status < 500);
    const ct = res2.headers['content-type'] ?? '';
    let parsed: unknown = res2.body.slice(0, 20_000);
    if (/json/i.test(ct)) {
      try {
        parsed = JSON.parse(res2.body);
      } catch {
        /* keep the text */
      }
    }
    const output = { status, contentType: ct || null, body: parsed, redirects: res2.redirects };
    if (status >= 200 && status < 400) return { output, secrets, billable: true, connectorId: conn?.id };
    const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
    throw Object.assign(new ActionError(retryable ? 'http_retryable' : 'http_4xx', `the target answered ${status}`, { retryable, httpStatus: status, uncertain: status >= 500 }), { secrets, output });
  }

  private async nuzmApi(p: Record<string, Json>, rt: StepRuntime): Promise<ActionOutcome> {
    const method = String(p.method ?? 'GET').toUpperCase();
    const path = String(p.path);
    const resource = /^\/v1\/([a-z-]+)/.exec(path)?.[1] ?? '';
    const need = typeof p.scope === 'string' ? p.scope : `${resource}:${['GET', 'HEAD'].includes(method) ? 'read' : 'write'}`;
    const conn = await this.useConnector(rt.orgId, String(p.connectorId), need);
    if (conn.type !== 'nuzm') throw new ProblemException('connector_not_authorized', 'a Nuzm API step needs a first-party Nuzm connector');
    if (!scopeCovers(conn.scopes, need)) throw new ProblemException('connector_not_authorized', `the connector does not declare ${need}`);
    const r = await this.nuzm.call({ orgId: rt.orgId, method, path, body: p.body, token: conn.secret ?? '', idempotencyKey: rt.idempotencyKey });
    this.connectors.outcome(conn.id, r.status < 500);
    const secrets = conn.secret ? [conn.secret] : [];
    if (r.status >= 200 && r.status < 400) return { output: { status: r.status, body: r.body }, secrets, billable: true, connectorId: conn.id };
    const retryable = r.status === 429 || r.status >= 500;
    throw Object.assign(new ActionError(retryable ? 'http_retryable' : 'http_4xx', `the Nuzm API answered ${r.status}`, { retryable, httpStatus: r.status, uncertain: r.status >= 500 }), { secrets, output: { status: r.status } });
  }

  /** Condition/loop expressions evaluate here too so every evaluation shares one scope shape. */
  evaluate(expr: string, scope: Record<string, unknown>) {
    return evalExpression(expr, scope);
  }
}

/** A ProblemException from a called Nuzm service (e.g. the email service answering 422 suppressed) is a PERMANENT step failure with its code. */
function mapKnown(e: unknown): never {
  if (e instanceof ProblemException) throw new ActionError(e.code, e.detail ?? e.message, { retryable: e.getStatus() >= 500 || e.getStatus() === 429 });
  throw e;
}
