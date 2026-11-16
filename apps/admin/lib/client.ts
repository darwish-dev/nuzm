'use client';
import { createApi } from '@nuzm/sdk';

const read = (name: string) =>
  typeof document === 'undefined'
    ? undefined
    : document.cookie
        .split('; ')
        .find((c) => c.startsWith(`${name}=`))
        ?.slice(name.length + 1);

/** Same-origin browser client; admin realm uses its own CSRF cookie. */
export const browserApi = () =>
  createApi({
    baseUrl: '',
    credentials: 'same-origin',
    realm: 'admin',
    getCsrf: () => read('nuzm_admin_csrf'),
  });
