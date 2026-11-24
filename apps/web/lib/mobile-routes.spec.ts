import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A redirect or a not-found ends the page the way Next does: by throwing. The tests read where it went. */
class Redirected extends Error {}
class Missing extends Error {}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
  notFound: () => {
    throw new Missing();
  },
}));
const flags: Record<string, boolean> = { 'mobile_builder.enabled': true };
vi.mock('./builder-view', () => ({
  builderView: vi.fn(),
  builderGuard: vi.fn(async () => ({
    ok: true,
    s: { me: { featureFlags: flags, id: 'u1' }, can: () => true },
    orgId: 'o1',
    c: {},
  })),
}));

const ID = '018f0000-0000-7000-8000-0000000000aa';
const params = (id = ID, locale = 'en') => Promise.resolve({ locale, id });
const dest = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Redirected) return e.message;
    throw e;
  }
  return 'no redirect';
};
const BASE = `/builder/projects/${ID}`;

beforeEach(() => {
  flags['mobile_builder.enabled'] = true;
});

describe('the former mobile pages redirect into the builder workspace (existing links keep working)', () => {
  it.each([
    [
      '/mobile/[id]',
      () => import('../app/[locale]/(console)/mobile/[id]/page'),
      `${BASE}?tab=preview`,
    ],
    [
      '/mobile/[id]/preview',
      () => import('../app/[locale]/(console)/mobile/[id]/preview/page'),
      `${BASE}?tab=preview`,
    ],
    [
      '/mobile/[id]/builds',
      () => import('../app/[locale]/(console)/mobile/[id]/builds/page'),
      `${BASE}?tab=builds`,
    ],
    [
      '/mobile/[id]/signing',
      () => import('../app/[locale]/(console)/mobile/[id]/signing/page'),
      `${BASE}?tab=signing`,
    ],
    [
      '/mobile/[id]/releases',
      () => import('../app/[locale]/(console)/mobile/[id]/releases/page'),
      `${BASE}?tab=releases`,
    ],
    [
      '/mobile/[id]/releases/new',
      () => import('../app/[locale]/(console)/mobile/[id]/releases/new/page'),
      `${BASE}?tab=releases&new=1`,
    ],
  ])('%s', async (_route, load, to) => {
    const page = (await load()).default as (a: { params: Promise<unknown> }) => Promise<unknown>;
    expect(await dest(page({ params: params() }))).toBe(to);
    // Arabic keeps its locale
    expect(await dest(page({ params: params(ID, 'ar') }))).toBe(to.replace('/', '/'));
  });
  it('an id that is not a UUID, or an unknown locale, is a plain 404 (nothing is redirected to)', async () => {
    const page = (await import('../app/[locale]/(console)/mobile/[id]/builds/page'))
      .default as (a: { params: Promise<unknown> }) => Promise<unknown>;
    await expect(page({ params: params('not-a-uuid') })).rejects.toBeInstanceOf(Missing);
    await expect(page({ params: params(ID, 'fr') })).rejects.toBeInstanceOf(Missing);
  });
});

describe('/mobile/new is the Mobile apps entry: it opens the start screen with the Mobile tile selected', () => {
  const load = async () =>
    (await import('../app/[locale]/(console)/mobile/new/page')).default as (a: {
      params: Promise<{ locale: string }>;
    }) => Promise<unknown>;
  it('redirects to the builder start screen filtered to mobile apps while the flag is on', async () => {
    expect(await dest((await load())({ params: Promise.resolve({ locale: 'en' }) }))).toBe(
      '/builder/projects?type=mobile',
    );
  });
  it('still answers the "not enabled" state while mobile_builder.enabled is off (no redirect)', async () => {
    flags['mobile_builder.enabled'] = false;
    expect(await dest((await load())({ params: Promise.resolve({ locale: 'en' }) }))).toBe(
      'no redirect',
    );
  });
});
