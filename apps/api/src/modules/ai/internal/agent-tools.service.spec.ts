import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redactArgs } from './agent-tools.service';

describe('redactArgs: what may be kept of a model-proposed argument object', () => {
  it('keeps a path, a range and a glob, and nothing else', () => {
    expect(
      redactArgs('read_file', { path: 'src/a.ts', startLine: 2, endLine: 9, extra: 'secret' }),
    ).toEqual({ path: 'src/a.ts', startLine: 2, endLine: 9 });
    expect(redactArgs('list_files', { dir: 'src', glob: '**/*.ts', limit: 5, other: 1 })).toEqual({
      dir: 'src',
      glob: '**/*.ts',
      limit: 5,
    });
  });
  it('never keeps a search query: its length and a short hash tell two searches apart', () => {
    const q = 'password=hunter2';
    expect(
      redactArgs('search_code', { query: q, limit: 3, caseSensitive: true, pathGlob: 'src/**' }),
    ).toEqual({
      queryLength: q.length,
      queryHash: createHash('sha256').update(q).digest('hex').slice(0, 12),
      limit: 3,
      caseSensitive: true,
      pathGlob: 'src/**',
    });
    expect(JSON.stringify(redactArgs('search_code', { query: q }))).not.toContain('hunter2');
  });
  it('keeps nothing of a tool it does not know, and survives any shape', () => {
    expect(redactArgs('run_command', { cmd: 'rm -rf /' })).toEqual({});
    expect(redactArgs('inspect_project', { anything: 1 })).toEqual({});
    for (const a of [
      null,
      undefined,
      5,
      'x',
      [],
      [1],
      { path: { a: 1 } },
      { path: 'a\u0000b' },
      { startLine: Number.NaN },
    ])
      expect(() => redactArgs('read_file', a)).not.toThrow();
    expect(redactArgs('read_file', { path: 'a\u0000b', startLine: Number.NaN })).toEqual({});
  });
  it('bounds what it keeps', () => {
    expect(
      (redactArgs('read_file', { path: 'x'.repeat(5_000) }).path as string).length,
    ).toBeLessThanOrEqual(300);
  });
});
