import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';

export type { components, paths } from './schema';
export type Schemas = components['schemas'];

export interface SdkOptions {
  /** API origin, or '' to use same-origin paths (the portals proxy /v1/* to the API). */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Active organization (sent as X-Nuzm-Org; the server verifies membership, it is a selector only). */
  getOrg?: () => string | undefined;
  /** CSRF token (double-submit cookie value) for cookie-authenticated unsafe requests. */
  getCsrf?: () => string | undefined;
  /** Extra headers, e.g. a forwarded Cookie header when called from a server component. */
  getHeaders?: () => Record<string, string>;
  credentials?: RequestCredentials;
  locale?: 'ar' | 'en';
  /** Console realm, sent as X-Nuzm-Realm so shared-host consoles never use each other's session. */
  realm?: 'web' | 'admin';
}

/** RFC 9457 problem+json as returned by every non-2xx response (docs/04 §1). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string | undefined,
    readonly traceId: string | undefined,
    readonly errors: unknown[] | undefined,
    /** Full problem body, for extension members such as `mfaFactorId`. */
    readonly body: Record<string, unknown> = {},
  ) {
    super(`${status} ${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'ApiError';
  }
  get isUnauthenticated() {
    return this.status === 401 && this.code === 'unauthenticated';
  }
  /** On `mfa_required`: the factor to challenge (null = enrol first). */
  get mfaFactorId(): string | null | undefined {
    return this.body.mfaFactorId as string | null | undefined;
  }
  get needsStepUp() {
    return this.code === 'step_up_required';
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isNotFound() {
    return this.status === 404;
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createApi(opts: SdkOptions) {
  const client = createClient<paths>({
    baseUrl: opts.baseUrl,
    fetch: opts.fetch,
    credentials: opts.credentials ?? 'include',
  });
  const mw: Middleware = {
    onRequest({ request }) {
      for (const [k, v] of Object.entries(opts.getHeaders?.() ?? {})) request.headers.set(k, v);
      const org = opts.getOrg?.();
      if (org && !request.headers.has('x-nuzm-org')) request.headers.set('x-nuzm-org', org);
      const csrf = opts.getCsrf?.();
      if (csrf && !SAFE.has(request.method)) request.headers.set('x-csrf-token', csrf);
      if (opts.locale) request.headers.set('accept-language', opts.locale);
      if (opts.realm) request.headers.set('x-nuzm-realm', opts.realm);
      return request;
    },
  };
  client.use(mw);
  return client;
}

export type Api = ReturnType<typeof createApi>;

interface Result<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** Resolve to the typed body or throw an ApiError built from the problem+json body. */
export async function unwrap<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p;
  if (r.response.ok) return r.data as T;
  const e = (r.error ?? {}) as {
    code?: string;
    detail?: string;
    traceId?: string;
    errors?: unknown[];
  };
  throw new ApiError(
    r.response.status,
    e.code ?? 'unknown_error',
    e.detail,
    e.traceId ?? r.response.headers.get('x-trace-id') ?? undefined,
    e.errors,
    e as Record<string, unknown>,
  );
}
