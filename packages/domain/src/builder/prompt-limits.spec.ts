import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROMPT_LIMITS } from './prompt-limits';
import { MAX_BLOCK_CHARS, shortOrPointer, wrapUntrusted } from '../ai/untrusted';
import { assembleContext } from '../knowledge/orchestration/context';

describe('customer prompt limits (owner request 2026-11-26)', () => {
  it('a project description may be 30,000 characters and a follow-up message 20,000', () => {
    expect(PROMPT_LIMITS).toEqual({ projectPromptChars: 30_000, chatMessageChars: 20_000 });
  });
  it('the console states the same numbers as the API (apps/web/lib/appbuilder.ts)', () => {
    const web = readFileSync(join(__dirname, '../../../../apps/web/lib/appbuilder.ts'), 'utf8');
    const num = (name: string) =>
      Number(new RegExp(`export const ${name} = ([0-9_]+);`).exec(web)?.[1]?.replaceAll('_', ''));
    expect(num('PROJECT_PROMPT_MAX')).toBe(PROMPT_LIMITS.projectPromptChars);
    expect(num('CHAT_MESSAGE_MAX')).toBe(PROMPT_LIMITS.chatMessageChars);
  });
});

describe('the AI engine never silently shortens a customer text', () => {
  const longest = 'ب'.repeat(PROMPT_LIMITS.projectPromptChars - 1) + 'Z';
  it('a data block carries the longest allowed description whole (its last character included)', () => {
    expect(MAX_BLOCK_CHARS).toBeGreaterThan(PROMPT_LIMITS.projectPromptChars);
    const out = wrapUntrusted([{ label: 'description', text: longest }], 'DATA-0123456789abcdef01');
    expect(out).toContain(longest);
    expect(out).not.toContain('were not included');
  });
  it('a block over the safety bound says how much was left out instead of cutting silently', () => {
    const out = wrapUntrusted(
      [{ label: 'x', text: 'a'.repeat(MAX_BLOCK_CHARS + 25) }],
      'DATA-0123456789abcdef01',
    );
    expect(out).toContain('[25 more characters were not included');
  });
  it('a param copy of a long text is a pointer to its data block, never a cut copy', () => {
    expect(shortOrPointer('short', 'description')).toBe('short');
    const p = shortOrPointer(longest, 'description');
    expect(p).toContain('the whole text is in the data block "description"');
    expect(p.length).toBeLessThan(100);
  });
  it('a template context pack keeps the whole requirement and grows its budget so the files still fit', () => {
    const files = [
      { path: 'app/page.tsx', bytes: 400, origin: 'template' as const },
      { path: 'package.json', bytes: 100, origin: 'template' as const },
    ];
    const ctx = assembleContext({
      requirement: { text: longest, platform: 'WEB', frameworks: [] },
      mode: 'ADAPTIVE',
      template: null,
      files,
      contents: new Map([
        ['app/page.tsx', 'export default function P() { return null; }'],
        ['package.json', '{}'],
      ]),
      aiProcessing: true,
    } as never);
    const req = ctx.blocks.find((b) => b.kind === 'requirement')!;
    expect(req.text).toContain(longest);
    expect(ctx.included).toEqual(expect.arrayContaining(['app/page.tsx', 'package.json']));
    expect(ctx.tokens.budget).toBeGreaterThan(12_000);
  });
});
