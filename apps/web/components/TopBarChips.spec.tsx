// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const patch = vi.fn();
const refresh = vi.fn();
vi.mock('../lib/client', () => ({ browserApi: () => ({ PATCH: patch }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
import { OrgSwitcher } from './ConsoleChrome';
import { NotificationsMenu } from './NotificationsMenu';

afterEach(cleanup);
beforeEach(() => {
  patch.mockReset();
  refresh.mockReset();
});

const labels = {
  menu: 'Notifications',
  title: 'Notifications',
  empty: 'Nothing here',
  read: 'Mark read',
  unread: 'Mark unread',
  viewAll: 'View all notifications',
  error: 'Something went wrong',
};
const items = [
  { id: 'n1', text: 'Domain renewed', when: 'today', read: false },
  { id: 'n2', text: 'Invoice issued', when: 'yesterday', read: true },
];

describe('notifications pop-up', () => {
  it('shows the unread count on the bell and opens the latest notifications only on click', () => {
    render(
      <NotificationsMenu
        items={items}
        unreadCount={1}
        viewAllHref="/notifications"
        labels={labels}
      />,
    );
    const bell = screen.getByRole('button', { name: 'Notifications 1' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(bell);
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(within(panel).getByText('Domain renewed')).toBeTruthy();
    expect(
      within(panel).getByRole('link', { name: 'View all notifications' }).getAttribute('href'),
    ).toBe('/notifications');
  });

  it('marks one read, lowers the count, and closes on Escape', async () => {
    patch.mockResolvedValue({ response: { ok: true } });
    render(
      <NotificationsMenu
        items={items}
        unreadCount={1}
        viewAllHref="/notifications"
        labels={labels}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Notifications 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy());
    expect(patch).toHaveBeenCalledWith('/v1/notifications/{id}', {
      params: { path: { id: 'n1' } },
      body: { read: true },
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the state and says so when the update fails; an empty list says it is empty', async () => {
    patch.mockResolvedValue({ response: { ok: false } });
    render(<NotificationsMenu items={items} unreadCount={1} viewAllHref="/x" labels={labels} />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong');
    expect(screen.getByRole('button', { name: 'Notifications 1' })).toBeTruthy();
    cleanup();
    render(<NotificationsMenu items={[]} unreadCount={0} viewAllHref="/x" labels={labels} />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });
});

describe('organization chip', () => {
  const props = {
    label: 'Switch organization',
    current: 'o1',
    orgs: [
      { orgId: 'o1', name: 'Acme' },
      { orgId: 'o2', name: 'Globex' },
    ],
    workspacesHref: '/settings/organization',
    workspacesLabel: 'Organization',
  };
  it('has an icon link to the organization page next to the switcher', () => {
    render(<OrgSwitcher {...props} />);
    expect(screen.getByRole('link', { name: 'Organization' }).getAttribute('href')).toBe(
      '/settings/organization',
    );
    expect((screen.getByLabelText('Switch organization') as HTMLSelectElement).value).toBe('o1');
  });
  it('switching sets the organization cookie and refreshes', () => {
    render(<OrgSwitcher {...props} />);
    fireEvent.change(screen.getByLabelText('Switch organization'), { target: { value: 'o2' } });
    expect(document.cookie).toContain('nuzm_org=o2');
    expect(refresh).toHaveBeenCalled();
  });
});
