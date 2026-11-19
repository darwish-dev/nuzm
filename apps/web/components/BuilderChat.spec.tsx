// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
