// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import { BuilderStart, nameFromPrompt } from './BuilderStart';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
const mockFetch = (h: (url: string, n: number) => Response) => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return h(url, calls.length);
    }),
  );
};
afterEach(() => {
  cleanup();
  push.mockClear();
  vi.unstubAllGlobals();
});

const wallet = { availableCredits: '100', lowCredit: false } as never;
const screenUnderTest = (canRun = true) =>
  render(<BuilderStart locale="en" credits={wallet} canRun={canRun} />);
const typeIn = (text: string) =>
  fireEvent.change(screen.getByLabelText(t('en', 'bld.start.promptLabel')), {
    target: { value: text },
  });

describe('nameFromPrompt', () => {
  it('uses the first words, never more than 100 characters, never empty', () => {
    expect(nameFromPrompt('A website for my coffee shop in Riyadh with a menu.')).toBe(
      'A website for my coffee shop',
    );
    expect(nameFromPrompt('x'.repeat(300)).length).toBeLessThanOrEqual(61);
    expect(nameFromPrompt('   ')).toBe('Project');
    expect(nameFromPrompt('موقع لمطعمي مع قائمة الطعام وحجز الطاولات.')).toBe(
      'موقع لمطعمي مع قائمة الطعام وحجز',
    );
  });
});

describe('start a project (one prompt, no steps)', () => {
  it('creates the project, the AI session and the first website run from the prompt alone, then opens the workspace', async () => {
    mockFetch((url) =>
      url === '/v1/builder/projects'
        ? json(201, { id: 'p1', name: 'x' })
        : url === '/v1/ai/sessions'
          ? json(201, { id: 's1' })
          : json(202, { id: 'r1' }),
    );
    screenUnderTest();
    typeIn('A website for my restaurant with a menu and table booking');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('en', 'bld.start.go')) }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/builder/projects/p1'));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /v1/builder/projects',
      'POST /v1/ai/sessions',
      'POST /v1/ai/runs',
    ]);
    expect(calls[0]!.body).toMatchObject({
      type: 'website',
      name: 'A website for my restaurant with',
      locale: ['ar', 'en'],
    });
    expect(calls[2]!.body).toMatchObject({
      sessionId: 's1',
      kind: 'website',
      projectId: 'p1',
      input: { description: 'A website for my restaurant with a menu and table booking' },
    });
    // every side-effecting call carries its own idempotency key
    const keys = calls.map((c) => c.headers['idempotency-key']);
    expect(new Set(keys).size).toBe(3);
  });

  it('a mobile app can be started when the organization has the mobile builder: a mobile project and run, its request is stored as the first chat message, then the workspace opens (in its mobile mode)', async () => {
    mockFetch((url) =>
      url === '/v1/builder/projects'
        ? json(201, { id: 'm1', name: 'x' })
        : url === '/v1/ai/sessions'
          ? json(201, { id: 's1' })
          : url.endsWith('/messages')
            ? json(201, { id: 'msg1' })
            : json(202, { id: 'r1' }),
    );
    render(<BuilderStart locale="en" credits={wallet} canRun mobileEnabled />);
    fireEvent.click(screen.getByLabelText(new RegExp(t('en', 'bld.start.type.mobile'))));
    typeIn('A mobile app for booking padel courts');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('en', 'bld.start.go')) }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/builder/projects/m1'));
    expect(calls[0]!.body).toMatchObject({ type: 'mobile' });
    expect(calls[2]!.url).toBe('/v1/ai/sessions/s1/messages');
    expect(calls[2]!.body).toMatchObject({ content: 'A mobile app for booking padel courts' });
    expect(calls[3]!.body).toMatchObject({
      kind: 'mobile',
      projectId: 'm1',
      input: { description: 'A mobile app for booking padel courts' },
    });
    expect(screen.queryByText(t('en', 'bld.start.soon'))).not.toBe(null); // the web-app tile is still "coming soon" here (its flag is off)
  });

  it('an empty prompt is refused on the screen and calls nothing', () => {
    mockFetch(() => json(500, {}));
    screenUnderTest();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('en', 'bld.start.go')) }));
    expect(screen.getByRole('alert').textContent).toContain('600');
    expect(calls).toHaveLength(0);
  });

  it('the same words twice take the next free name instead of failing', async () => {
    let n = 0;
    mockFetch((url) =>
      url === '/v1/builder/projects'
        ? n++ === 0
          ? json(409, { code: 'name_taken' })
          : json(201, { id: 'p2' })
        : url === '/v1/ai/sessions'
          ? json(201, { id: 's2' })
          : json(202, { id: 'r2' }),
    );
    screenUnderTest();
    typeIn('Coffee shop site');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('en', 'bld.start.go')) }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/builder/projects/p2'));
    const created = calls.filter((c) => c.url === '/v1/builder/projects');
    expect(created.map((c) => (c.body as { name: string }).name)).toEqual([
      'Coffee shop site',
      'Coffee shop site 2',
    ]);
  });

  it('a refused run keeps the project and offers to open it; a retry never creates a second project', async () => {
    let runs = 0;
    mockFetch((url) =>
      url === '/v1/builder/projects'
        ? json(201, { id: 'p3' })
        : url === '/v1/ai/sessions'
          ? json(201, { id: 's3' })
          : runs++ === 0
            ? json(422, { code: 'unsupported_capability' })
            : json(202, { id: 'r3' }),
    );
    screenUnderTest();
    typeIn('Portfolio for a photographer');
    const go = () =>
      fireEvent.click(screen.getByRole('button', { name: new RegExp(t('en', 'bld.start.go')) }));
    go();
    await screen.findByText(t('en', 'bld.wiz.partial'), { exact: false });
    go();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/builder/projects/p3'));
    expect(calls.filter((c) => c.url === '/v1/builder/projects')).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/v1/ai/sessions')).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/v1/ai/runs')).toHaveLength(2);
  });

  it('web app and mobile app are shown as coming soon and cannot be started', () => {
    mockFetch(() => json(500, {}));
    screenUnderTest();
    for (const id of ['webapp', 'mobile'] as const) {
      fireEvent.click(screen.getByLabelText(new RegExp(t('en', `bld.start.type.${id}`))));
      const go = screen.getByRole('button', {
        name: new RegExp(t('en', 'bld.start.go')),
      }) as HTMLButtonElement;
      expect(go.disabled).toBe(true);
      expect(screen.getByRole('status').textContent).toContain(t('en', `bld.start.type.${id}`));
    }
    expect(screen.getAllByText(t('en', 'bld.start.soon')).length).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('a template fills the prompt, selects its type and, for a website, its site template', () => {
    mockFetch(() => json(500, {}));
    render(<BuilderStart locale="en" credits={wallet} canRun appsEnabled />);
    fireEvent.click(screen.getByLabelText(new RegExp(t('en', 'bld.start.type.webapp'))));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.tpl.button') }));
    const dialog = screen.getByRole('dialog', { name: t('en', 'bld.tpl.title') });
    // the popup opens on the type that is selected, with one tab per type
    const tabs = within(dialog).getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(
      within(dialog)
        .getByRole('tab', { name: new RegExp(t('en', 'bld.start.type.webapp')) })
        .getAttribute('aria-selected'),
    ).toBe('true');
    fireEvent.click(
      within(dialog).getByRole('tab', { name: new RegExp(t('en', 'bld.start.type.website')) }),
    );
    fireEvent.click(
      within(dialog).getByRole('button', { name: new RegExp(t('en', 'bld.land.exTitle.clinic')) }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      (screen.getByLabelText(t('en', 'bld.start.promptLabel')) as HTMLTextAreaElement).value,
    ).toBe(t('en', 'bld.start.ex.clinic'));
    expect(
      (screen.getByLabelText(new RegExp(t('en', 'bld.start.type.website'))) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect((screen.getByLabelText(t('en', 'bld.wiz.template')) as HTMLSelectElement).value).toBe(
      'clinic',
    );
  });

  it('templates of a type the organization cannot start yet are shown as coming soon and cannot be used', () => {
    render(<BuilderStart locale="en" credits={wallet} canRun />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.tpl.button') }));
    const dialog = screen.getByRole('dialog', { name: t('en', 'bld.tpl.title') });
    fireEvent.click(
      within(dialog).getByRole('tab', { name: new RegExp(t('en', 'bld.start.type.mobile')) }),
    );
    const cards = within(dialog).getAllByRole('button', {
      name: new RegExp(t('en', 'bld.land.use')),
    });
    expect(cards).toHaveLength(3);
    expect(cards.every((c) => (c as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the start screen is the prompt alone: no projects or examples section below it', () => {
    const { container } = screenUnderTest();
    const hero = container.querySelector('.bl-hero')!;
    expect(hero.querySelector('textarea')).toBeTruthy();
    expect(hero.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    expect(container.querySelector('.bl-more')).toBeNull();
    expect(
      screen.queryByRole('tab', { name: new RegExp(t('en', 'bld.land.tab.projects')) }),
    ).toBeNull();
  });

  it('without the permission to run AI the screen says so', () => {
    screenUnderTest(false);
    expect(screen.getByText(t('en', 'bld.wiz.noRunPermission'), { exact: false })).toBeTruthy();
  });
});
