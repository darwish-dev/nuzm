// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import { BuilderHistory, bucketOf, foldersOf } from './BuilderHistory';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => {
  cleanup();
  push.mockClear();
  vi.unstubAllGlobals();
});
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const PROJECTS = [
  { id: 'p1', name: 'Coffee shop', type: 'website', updatedAt: daysAgo(5) },
  { id: 'p2', name: 'Clinic app', type: 'webapp', updatedAt: daysAgo(2) },
  { id: 'p3', name: 'Empty project', type: 'mobile', updatedAt: daysAgo(40) },
];
const SESSIONS = [
  { id: 's1', title: 'Menu page', projectId: 'p1', createdAt: daysAgo(0) },
  { id: 's2', title: 'Booking form', projectId: 'p2', createdAt: daysAgo(1) },
  { id: 's3', title: 'Hero redesign', projectId: 'p1', createdAt: daysAgo(3) },
  { id: 's4', title: 'Loose idea', projectId: null, createdAt: daysAgo(90) },
];
const api = (over: (url: string, init: RequestInit) => Response | undefined = () => undefined) =>
  vi.fn(async (url: string, init: RequestInit = {}) => {
    const o = over(url, init);
    if (o) return o;
    if (url.includes('/v1/builder/projects'))
      return json(200, { items: PROJECTS, nextCursor: null });
    if (url.includes('/v1/ai/sessions')) return json(200, { items: SESSIONS, nextCursor: null });
    return json(500, {});
  });
const openPanel = (locale: 'en' | 'ar' = 'en') => {
  fireEvent.click(
    screen.getByRole('button', { name: t(locale, 'bld.hist.projects'), expanded: false }),
  );
  return screen.getByRole('complementary', { name: t(locale, 'bld.hist.title') });
};

describe('builder chat history', () => {
  it('groups chats by day', () => {
    const now = new Date('2026-11-23T12:00:00');
    expect(bucketOf('2026-11-23T08:00:00', now)).toBe('today');
    expect(bucketOf('2026-11-22T23:00:00', now)).toBe('yesterday');
    expect(bucketOf('2026-11-19T10:00:00', now)).toBe('week');
    expect(bucketOf('2026-11-01T10:00:00', now)).toBe('month');
    expect(bucketOf('2026-08-01T10:00:00', now)).toBe('older');
  });

  it('puts each chat in its project folder, most recently active project first', () => {
    const { folders, loose } = foldersOf(PROJECTS, SESSIONS);
    expect(folders.map((f) => f.project.id)).toEqual(['p1', 'p2', 'p3']);
    expect(folders[0]!.chats.map((c) => c.id)).toEqual(['s1', 's3']);
    expect(folders[2]!.chats).toEqual([]);
    expect(loose.map((c) => c.id)).toEqual(['s4']);
  });

  it('opens from the top icon and lists project folders with their chats, each opening that conversation', async () => {
    const fetch = api();
    vi.stubGlobal('fetch', fetch);
    render(<BuilderHistory locale="en" />);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const panel = openPanel();
    // folders start closed
    const folder = await within(panel).findByRole('button', { name: /^Coffee shop/ });
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    expect(within(panel).queryByRole('link', { name: /Menu page/ })).toBeNull();
    fireEvent.click(folder);
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    const menu = within(panel).getByRole('link', { name: /Menu page/ });
    expect(menu.getAttribute('href')).toBe('/builder/projects/p1?session=s1');
    fireEvent.click(folder);
    expect(within(panel).queryByRole('link', { name: /Menu page/ })).toBeNull();
    // a project with one chat is a direct link to it, with nothing to unfold; one with none opens the project
    const clinic = within(panel).getByRole('link', { name: /^Clinic app/ });
    expect(clinic.getAttribute('href')).toBe('/builder/projects/p2?session=s2');
    expect(within(panel).queryByRole('button', { name: /^Clinic app/ })).toBeNull();
    expect(
      within(panel)
        .getByRole('link', { name: /^Empty project/ })
        .getAttribute('href'),
    ).toBe('/builder/projects/p3');
    // a chat without a project is listed apart, not as a link
    expect(within(panel).getByText('Loose idea').closest('a')).toBeNull();
    // searching finds chats inside folders, and whole folders by name
    fireEvent.change(within(panel).getByPlaceholderText(t('en', 'bld.hist.search')), {
      target: { value: 'booking' },
    });
    expect(within(panel).getByRole('link', { name: /Clinic app/ })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /^Coffee shop/ })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('starts a new chat inside a project and opens it', async () => {
    const fetch = api((url, init) =>
      url.endsWith('/v1/ai/sessions') && init.method === 'POST'
        ? json(201, { id: 's9' })
        : undefined,
    );
    vi.stubGlobal('fetch', fetch);
    render(<BuilderHistory locale="en" />);
    const panel = openPanel();
    fireEvent.click(
      await within(panel).findByRole('button', {
        name: t('en', 'bld.hist.newChatIn', { name: 'Clinic app' }),
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith('/builder/projects/p2?session=s9'));
    const post = fetch.mock.calls.find(
      ([u, i]) => u.endsWith('/v1/ai/sessions') && i?.method === 'POST',
    )!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      title: t('en', 'bld.hist.newChatTitle'),
      projectId: 'p2',
    });
  });

  it('hides the new-chat buttons for someone who cannot start AI work', async () => {
    vi.stubGlobal('fetch', api());
    render(<BuilderHistory locale="en" canChat={false} />);
    const panel = openPanel();
    await within(panel).findByRole('link', { name: /^Clinic app/ });
    expect(within(panel).queryByRole('button', { name: /New chat in/ })).toBeNull();
  });

  it('says so when the list cannot be read, and retries', async () => {
    const fetch = vi.fn(async () => json(500, { code: 'internal' }));
    vi.stubGlobal('fetch', fetch);
    render(<BuilderHistory locale="ar" />);
    openPanel('ar');
    fireEvent.click(await screen.findByRole('button', { name: t('ar', 'action.retry') }));
    // two reads per attempt: the projects and the chats
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  });
});
