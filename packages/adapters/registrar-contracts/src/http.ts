import { AdapterTimeoutError } from './mirror/errors';
import { assertEgressAllowed, type EgressPolicy } from './mirror/egress';

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json(): unknown;
}
export interface HttpClient {
  request(req: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    url: string;
    headers?: Record<string, string>;
    body?: string;
    deadlineMs: number;
  }): Promise<HttpResponse>;
}

/** fetch-based client with the egress guard (M05 §9: an adapter only reaches its allow-listed hosts) and a hard deadline that raises AdapterTimeoutError. */
export class FetchHttpClient implements HttpClient {
  constructor(
    private readonly policy: EgressPolicy,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async request(req: Parameters<HttpClient['request']>[0]): Promise<HttpResponse> {
    const url = assertEgressAllowed(req.url, this.policy);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(req.deadlineMs, 1));
    try {
      const res = await this.fetchImpl(url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: ac.signal,
        redirect: 'error',
      });
      const text = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      return {
        status: res.status,
        headers,
        text,
        json() {
          return JSON.parse(text) as unknown;
        },
      };
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new AdapterTimeoutError();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
