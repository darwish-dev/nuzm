import { describe, expect, it } from 'vitest';
import { CHAT_DEFAULT, CHAT_MIN, chatMax, clampChat } from './PanelResizer';

describe('chat / preview divider', () => {
  it('keeps the chat between its narrowest width and 60% of the workspace (760px at most)', () => {
    expect(clampChat(100, 1400)).toBe(CHAT_MIN);
    expect(clampChat(CHAT_DEFAULT, 1400)).toBe(CHAT_DEFAULT);
    expect(clampChat(5000, 1400)).toBe(760);
    expect(chatMax(1000)).toBe(600);
    expect(clampChat(700, 1000)).toBe(600);
    // a very narrow workspace never pushes the limit below the narrowest chat
    expect(chatMax(300)).toBe(CHAT_MIN);
  });
});
