import { executionGateway as eg } from '@nuzm/domain';
import type { AuditSink } from './audit';
import type { Metrics } from './metrics';
import { NodeError, type Caller, type NodeService } from './node-service';

/**
 * The transport-independent request handler of the agent: the HTTPS server (`server.ts`) and the in-process loopback transport call this same function, so what the tests
 * exercise is what the network serves. Order of checks, none skippable:
 *   1. method, path and content type (unknown paths are 404 before any authentication work);
 *   2. the signed request token (node, operation, exact body, scope, expiry, one-time id): any failure is a generic 401, the reason goes to the audit trail and a metric only;
 *   3. strict parsing of the body (unknown members, wrong types, oversize);
 *   4. the token's tenant binding must equal what the body addresses (org, workspace, handle);
 *   5. the operation, with the token's organization as the caller identity.
 * Answers are content-free: a code, and for a refused spec the violation codes. Nothing from the request is echoed.
 */
export interface HandlerOptions {
  service: NodeService;
  nodeId: string;
  trusted: eg.TrustedControlKeys;
  replay: eg.ReplayCache;
  metrics: Metrics;
  audit: AuditSink;
  now?: () => number;
}
const STATUS: Record<string, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  unknown_workspace: 404,
  unknown_handle: 404,
  too_large: 413,
  conflict: 409,
  workspace_exists: 409,
  no_capacity: 503,
  node_disabled: 503,
  workspace_not_bound_to_run: 422,
  workspace_tenant_mismatch: 422,
  disk_quota_missing: 422,
  path_escapes_workspace: 422,
  not_a_regular_file: 422,
  image_not_attested: 422,
  spec_refused: 422,
  platform_refused: 500,
  destroy_failed: 500,
  internal: 500,
};
const json = (status: number, body: unknown): eg.NodeHttpResponse => ({
  status,
  body: Buffer.from(JSON.stringify(body), 'utf8'),
});
const fail = (code: eg.NodeErrorCode, detail?: string): eg.NodeHttpResponse =>
  json(STATUS[code] ?? 500, { ok: false, error: { code, ...(detail ? { detail } : {}) } });

export function createRequestHandler(o: HandlerOptions): eg.NodeRequestHandler {
  const now = o.now ?? (() => Date.now());
  return async (req) => {
    const m = /^\/v1\/([A-Za-z]{1,40})$/.exec(req.path);
    if (req.method !== 'POST' || !m) return fail('not_found');
    const op = m[1] as eg.NodeOp;
    if (!(eg.NODE_OPS as readonly string[]).includes(op)) return fail('not_found');
    if (!/^application\/json(\s*;.*)?$/i.test(req.headers['content-type'] ?? ''))
      return fail('bad_request');
    if (req.body.length > eg.NODE_LIMITS.maxBodyBytes) return fail('too_large');

    const verdict = eg.verifyRequestToken({
      header: req.headers['authorization'],
      nodeId: o.nodeId,
      op,
      body: req.body,
      trusted: o.trusted,
      replay: o.replay,
      now: now(),
    });
    if (!verdict.ok) {
      o.metrics.inc('nuzm_agent_auth_refused_total', 1, verdict.reason);
      void o.audit.write({ type: 'request_refused', detail: { reason: verdict.reason, op } });
      return fail('unauthorized');
    }
    const tok = verdict.payload;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(req.body.toString('utf8'));
    } catch {
      return fail('bad_request');
    }
    const parsed = eg.parseNodeRequest(op, parsedJson);
    if (!parsed.ok) return fail(parsed.code);
    const body = parsed.value as never;

    // the token must address exactly what the body addresses
    const bind = eg.requestBinding(op, body);
    if (bind.workspaceId !== undefined && tok.workspaceId !== bind.workspaceId)
      return fail('forbidden');
    if (bind.handle !== undefined && tok.handle !== bind.handle) return fail('forbidden');
    if (bind.orgId !== undefined && tok.orgId !== bind.orgId) return fail('forbidden');
    const caller: Caller = { orgId: tok.orgId };

    const svc = o.service;
    try {
      let result: unknown = {};
      switch (op) {
        case 'identity':
          result = await svc.identity();
          break;
        case 'health':
          result = await svc.health();
          break;
        case 'createWorkspace':
          await svc.createWorkspace(body as eg.WorkspaceSpec, caller);
          break;
        case 'putFiles': {
          const b = body as eg.NodeRequestMap['putFiles'];
          await svc.putFiles(b.workspaceId, b.files, caller);
          break;
        }
        case 'start':
          result = await svc.start((body as eg.NodeRequestMap['start']).spec, caller);
          break;
        case 'wait': {
          const b = body as eg.NodeRequestMap['wait'];
          result = await svc.wait(b.handle, b.maxWaitMs, caller);
          break;
        }
        case 'stats':
          result = await svc.stats((body as eg.NodeRequestMap['stats']).handle, caller);
          break;
        case 'kill': {
          const b = body as eg.NodeRequestMap['kill'];
          await svc.kill(b.handle, b.how, caller);
          break;
        }
        case 'destroy':
          await svc.destroy((body as eg.NodeRequestMap['destroy']).handle, caller);
          break;
        case 'listProduced':
          result = {
            files: await svc.listProduced(
              (body as eg.NodeRequestMap['listProduced']).workspaceId,
              caller,
            ),
          };
          break;
        case 'readProduced': {
          const b = body as eg.NodeRequestMap['readProduced'];
          result = { content: await svc.readProduced(b.workspaceId, b.path, b.maxBytes, caller) };
          break;
        }
        case 'destroyWorkspace':
          await svc.destroyWorkspace(
            (body as eg.NodeRequestMap['destroyWorkspace']).workspaceId,
            caller,
          );
          break;
        case 'listWorkspaces':
          result = { workspaces: await svc.listWorkspaces() };
          break;
        case 'emergencyStop':
          result = await svc.emergencyStop();
          break;
        case 'reap':
          result = await svc.reap();
          break;
      }
      return json(200, { ok: true, result });
    } catch (e) {
      if (e instanceof NodeError)
        return fail(e.code, e.code === 'spec_refused' ? e.detail : undefined);
      o.metrics.inc('nuzm_agent_internal_errors_total');
      return fail('internal');
    }
  };
}
