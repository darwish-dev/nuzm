'use client';
import { apiCall, type CallEnv, type CallOptions, type CallResult } from './compute';

const read = (name: string) =>
  typeof document === 'undefined'
    ? undefined
    : document.cookie
        .split('; ')
        .find((c) => c.startsWith(`${name}=`))
        ?.slice(name.length + 1);

/** Same-origin browser calls (the web app proxies /v1/*): CSRF token, active org and realm come from the first-party cookies. */
const env: CallEnv = {
  baseUrl: '',
  credentials: 'same-origin',
  headers: () => {
    const org = read('nuzm_org');
    const csrf = read('nuzm_csrf');
    return {
      'x-nuzm-realm': 'web',
      ...(org ? { 'x-nuzm-org': org } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    };
  },
};

export const browserCompute = {
  get: <T>(path: string, o?: CallOptions): Promise<CallResult<T>> =>
    apiCall<T>(env, 'GET', path, o),
  post: <T>(path: string, o?: CallOptions): Promise<CallResult<T>> =>
    apiCall<T>(env, 'POST', path, o),
  del: <T>(path: string, o?: CallOptions): Promise<CallResult<T>> =>
    apiCall<T>(env, 'DELETE', path, o),
};
