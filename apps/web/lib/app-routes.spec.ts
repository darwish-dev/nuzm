import { beforeEach, describe, expect, it, vi } from 'vitest';

class Redirected extends Error {}
class Missing extends Error {}
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
  notFound: () => {
    throw new Missing();
  },
}));
let project: { ok: boolean; type?: string } = { ok: true, type: 'webapp' };
vi.mock('./server', () => ({
  requireSession: vi.fn(async () => ({ org: { orgId: 'o1' } })),
}));
vi.mock('./compute-server', () => ({
  serverCompute: vi.fn(async () => ({
    get: vi.fn(async () => ({ response: { ok: project.ok }, data: { type: project.type } })),
  })),
}));
import { redirectWebapp } from './app-redirect';

const ID = '018f0000-0000-7000-8000-0000000000aa';
const params = (id = ID, locale = 'en') => Promise.resolve({ locale, id });
const go = async (segment: Parameters<typeof redirectWebapp>[1], p = params()) => {
  try {
    await redirectWebapp(p, segment);
  } catch (e) {
    if (e instanceof Redirected) return e.message;
    throw e;
  }
  return 'no redirect';
};
beforeEach(() => {
  project = { ok: true, type: 'webapp' };
});

describe('the former pages of a web-app project redirect into the builder workspace', () => {
  it.each([
    ['spec', 'spec'],
    ['design', 'design'],
    ['ide', 'code'],
    ['tests', 'tests'],
    ['deployments', 'deployments'],
    ['exports', 'exports'],
    ['versions', 'versions'],
  ] as const)('/builder/projects/{id}/%s -> ?tab=%s', async (segment, tab) => {
    expect(await go(segment)).toBe(`/en/builder/projects/${ID}?tab=${tab}`);
    expect(await go(segment, params(ID, 'ar'))).toBe(`/ar/builder/projects/${ID}?tab=${tab}`);
  });
  it('a website keeps its own versions and deployments pages (nothing is redirected)', async () => {
    project = { ok: true, type: 'website' };
    expect(await go('versions')).toBe('no redirect');
    expect(await go('deployments')).toBe('no redirect');
  });
  it('a project that cannot be read here falls through to the page (which answers forbidden or not found)', async () => {
    project = { ok: false };
    expect(await go('ide')).toBe('no redirect');
  });
  it('an id that is not a UUID is a 404', async () => {
    await expect(redirectWebapp(params('nope'), 'spec')).rejects.toBeInstanceOf(Missing);
  });
});
