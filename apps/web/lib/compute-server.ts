import 'server-only';
import { apiCall, type CallOptions, type CallResult } from './compute';
import { API_ORIGIN, forwardHeaders } from './server';

/** Server-side compute calls with the caller's customer-realm session (GETs only: mutations run in the browser). */
export async function serverCompute(orgId: string | undefined) {
  const headers = await forwardHeaders(orgId);
  const env = { baseUrl: API_ORIGIN, headers: () => headers };
  return {
    get: <T>(path: string, o?: CallOptions): Promise<CallResult<T>> =>
      apiCall<T>(env, 'GET', path, o),
  };
}
