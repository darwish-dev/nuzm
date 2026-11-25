import { describe, expect, it, vi } from 'vitest';
import type { RunContext } from '../../ai';
import { attachmentBlocks } from './edit.handler';

const ctxWith = (
  msgs: { role: string; content: string; attachments: unknown[] }[],
  fetchText = vi.fn(),
) => {
  const emit = vi.fn(async () => 1);
  const ctx = {
    sessionMessages: async () => msgs.map((m, i) => ({ id: `m${i}`, ...m })),
    fetchText,
    emit,
  } as unknown as RunContext;
  return { ctx, emit, fetchText };
};

describe('website edit: attachments of the latest message', () => {
  it('turns the latest user message attachments into data blocks (files as text, links fetched)', async () => {
    const fetchText = vi.fn(async (url: string) => ({ url, text: 'PAGE TEXT' }));
    const { ctx } = ctxWith(
      [
        {
          role: 'user',
          content: 'old',
          attachments: [{ kind: 'text', name: 'old.md', text: 'OLD' }],
        },
        { role: 'assistant', content: 'ok', attachments: [] },
        {
          role: 'user',
          content: 'use these',
          attachments: [
            { kind: 'text', name: 'brand-guide.md', text: 'Colours: mint' },
            { kind: 'url', url: 'https://example.com/about' },
          ],
        },
      ],
      fetchText,
    );
    const blocks = await attachmentBlocks(ctx);
    expect(blocks).toEqual([
      { label: 'upload_1_brand-guide.md', text: 'Colours: mint' },
      { label: 'web_2', text: 'PAGE TEXT' },
    ]);
    expect(fetchText).toHaveBeenCalledWith('https://example.com/about');
  });

  it('skips a link that cannot be read and reports it without the address', async () => {
    const fetchText = vi.fn(async () => {
      throw Object.assign(new Error('blocked'), { code: 'egress_denied' });
    });
    const { ctx, emit } = ctxWith(
      [{ role: 'user', content: 'x', attachments: [{ kind: 'url', url: 'http://10.0.0.1/' }] }],
      fetchText,
    );
    expect(await attachmentBlocks(ctx)).toEqual([]);
    expect(emit).toHaveBeenCalledWith('fetch_failed', { index: 1, code: 'egress_denied' });
  });

  it('returns nothing when the message has no attachments', async () => {
    const { ctx } = ctxWith([{ role: 'user', content: 'x', attachments: [] }]);
    expect(await attachmentBlocks(ctx)).toEqual([]);
  });
});
