'use client';
import { createApi } from '@nuzm/sdk';

const read = (name: string) =>
  typeof document === 'undefined'
    ? undefined
    : document.cookie
        .split('; ')
        .find((c) => c.startsWith(`${name}=`))
        ?.slice(name.length + 1);

/** Same-origin browser client (the web app proxies /v1/* to the API, so cookies are first-party). */
export const browserApi = () =>
  createApi({
    baseUrl: '',
    credentials: 'same-origin',
    realm: 'web',
    getCsrf: () => read('nuzm_csrf'),
    getOrg: () => read('nuzm_org'),
  });
