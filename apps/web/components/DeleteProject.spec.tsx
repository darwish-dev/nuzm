// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const del = vi.fn();
const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ DELETE: del }) }));
import { DeleteProject } from './DeleteProject';
import { ProjectCards } from './BuilderProjects';

beforeEach(() => {
  del.mockReset();
  push.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

const project = { id: 'p1', name: 'Salon booking app' };
const open = (variant: 'button' | 'menu' = 'button') => {
  const r = render(<DeleteProject locale="en" project={project} variant={variant} />);
  fireEvent.click(
    screen.getByRole('button', {
      name: variant === 'menu' ? t('en', 'pdel.menu') : t('en', 'pdel.aria', project),
    }),
  );
  return r;
};
const confirmBtn = () => screen.getByRole('button', { name: t('en', 'pdel.confirm') });
const typeName = (v: string) =>
  fireEvent.change(screen.getByLabelText(t('en', 'pdel.type')), { target: { value: v } });

describe('delete a project', () => {
  it('asks for the exact name: the confirm button stays disabled until it matches', () => {
    open();
    expect(screen.getByText(t('en', 'pdel.title', project))).toBeTruthy();
    expect((confirmBtn() as HTMLButtonElement).disabled).toBe(true);
    typeName('salon booking');
    expect((confirmBtn() as HTMLButtonElement).disabled).toBe(true);
    typeName(project.name);
    expect((confirmBtn() as HTMLButtonElement).disabled).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  it('sends DELETE with confirmName, then refreshes the list (card) or leaves for the list (workspace)', async () => {
    del.mockResolvedValue({ response: { ok: true, status: 200 }, data: { id: 'p1' } });
    open();
    typeName(project.name);
    fireEvent.click(confirmBtn());
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del).toHaveBeenCalledWith('/v1/builder/projects/{id}', {
      params: { path: { id: 'p1' }, query: { confirmName: project.name } },
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
    cleanup();

    del.mockResolvedValue({ response: { ok: true, status: 200 }, data: { id: 'p1' } });
    render(
      <DeleteProject locale="en" project={project} variant="menu" redirectTo="/builder/projects" />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pdel.menu') }));
    typeName(project.name);
    fireEvent.click(confirmBtn());
    await waitFor(() => expect(push).toHaveBeenCalledWith('/builder/projects'));
  });

  it('says plainly when a deployment is in progress (409) and when the project is already gone (404), and stays open', async () => {
    del.mockResolvedValueOnce({ response: { ok: false, status: 409 }, error: { code: 'in_use' } });
    open();
    typeName(project.name);
    fireEvent.click(confirmBtn());
    expect(await screen.findByText(t('en', 'pdel.err.inUse'))).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    del.mockResolvedValueOnce({
      response: { ok: false, status: 404 },
      error: { code: 'not_found' },
    });
    fireEvent.click(confirmBtn());
    expect(await screen.findByText(t('en', 'pdel.err.notFound'))).toBeTruthy();
  });

  it('cancel closes the dialog without calling the API and forgets what was typed', () => {
    open();
    typeName(project.name);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.cancel') }));
    expect(screen.queryByText(t('en', 'pdel.title', project))).toBeNull();
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pdel.aria', project) }));
    expect((screen.getByLabelText(t('en', 'pdel.type')) as HTMLInputElement).value).toBe('');
  });

  it('the project cards offer Delete only to a member who can write', () => {
    const item = {
      id: 'p1',
      name: 'Salon booking app',
      type: 'mobile',
      locales: ['ar', 'en'],
      updatedAt: '2026-11-20T00:00:00Z',
      lastDeployment: null,
    } as unknown as Parameters<typeof ProjectCards>[0]['items'][number];
    const { rerender } = render(
      <ProjectCards locale="en" items={[item]} nextCursor={null} canCreate canDelete />,
    );
    expect(screen.getByRole('button', { name: t('en', 'pdel.aria', project) })).toBeTruthy();
    rerender(<ProjectCards locale="en" items={[item]} nextCursor={null} canCreate />);
    expect(screen.queryByRole('button', { name: t('en', 'pdel.aria', project) })).toBeNull();
  });
});
