// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../lib/builder';
import { t } from '@nuzm/i18n';
import { Chat } from './BuilderChat';

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 500 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const chat = (activeRun: boolean) =>
  render(
    <Chat
      locale="en"
      projectId="p1"
      projectName="Site"
      session={null}
      initialMessages={[]}
      canWrite
      refreshKey={0}
      activeRun={activeRun}
      onRun={vi.fn()}
    />,
  );

describe('chat while a run is going', () => {
  it('shows no warning banner: the box just rests with a calm placeholder until the run ends', () => {
    chat(true);
    expect(screen.queryByText(t('en', 'bld.chat.runActive'))).toBeNull();
    const box = screen.getByLabelText(t('en', 'bld.chat.input')) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe(t('en', 'bld.chat.placeholderBusy'));
  });
  it('is a normal box when nothing is running', () => {
    chat(false);
    const box = screen.getByLabelText(t('en', 'bld.chat.input')) as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(box.placeholder).toBe(t('en', 'bld.chat.placeholder'));
  });
});

const msg = (id: string, role: Message['role'], content: string): Message =>
  ({ id, role, content, createdAt: '2026-11-19T20:00:00Z' }) as Message;
const withMessages = (initialMessages: Message[]) =>
  render(
    <Chat
      locale="en"
      projectId="p1"
      projectName="Site"
      session={null}
      initialMessages={initialMessages}
      canWrite
      refreshKey={0}
      activeRun={false}
      onRun={vi.fn()}
    />,
  );

describe('chat messages', () => {
  it('your words are a plain bubble (no header line); the time is kept for screen readers and as a tooltip', () => {
    const { container } = withMessages([msg('1', 'user', 'improve design and layouts')]);
    const li = container.querySelector('.bld-msg[data-role="user"]')!;
    expect(li.textContent).toContain('improve design and layouts');
    expect(li.querySelector('.bld-msg-head')).toBeNull();
    expect(li.querySelector('.bld-msg-actions')).toBeNull();
    expect(li.querySelector('time.nz-sr')).toBeTruthy();
    expect(li.getAttribute('title')).toBeTruthy();
  });
  it('the assistant answers as plain text under the brand mark, with a copy button that copies it', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = withMessages([msg('2', 'assistant', 'Your site was updated')]);
    const li = container.querySelector('.bld-msg[data-role="assistant"]')!;
    expect(li.querySelector('.bld-msg-head img.nzc-logo')).toBeTruthy();
    expect(li.querySelector('.bld-msg-head strong')?.textContent).toBe('Nuzm');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.chat.copy') }));
    expect(writeText).toHaveBeenCalledWith('Your site was updated');
    expect(await screen.findByRole('button', { name: t('en', 'bld.chat.copied') })).toBeTruthy();
  });
  it('a system message is labelled as the system, not as the brand', () => {
    const { container } = withMessages([msg('3', 'system', 'The run was stopped')]);
    expect(
      container.querySelector('.bld-msg[data-role="system"] .bld-msg-head strong')?.textContent,
    ).toBe(t('en', 'bld.chat.role.system'));
  });
  it('the composer shows what the chat edits (website, web app or mobile) and a round send button', () => {
    const { container } = chat(false);
    expect(container.querySelector('.bld-chip')?.textContent).toContain(
      t('en', 'bld.start.type.website'),
    );
    expect(screen.getByRole('button', { name: t('en', 'bld.chat.send') })).toBeTruthy();
  });
});
