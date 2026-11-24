import { describe, expect, it } from 'vitest';
import {
  MAX_PATCHES_PER_CHANGE,
  batchPatches,
  gitignoreMatcher,
  guessProjectType,
  looksBinary,
  skipReason,
  sourceLabel,
  stripCommonRoot,
} from './start-sources';

describe('start sources', () => {
  it('drops the picked folder name from every path', () => {
    expect(stripCommonRoot(['my-app/src/a.ts', 'my-app/package.json'])).toEqual([
      'src/a.ts',
      'package.json',
    ]);
    expect(stripCommonRoot(['a.ts', 'src/b.ts'])).toEqual(['a.ts', 'src/b.ts']);
    expect(stripCommonRoot(['.\\src\\a.ts', 'b.ts'])).toEqual(['src/a.ts', 'b.ts']);
  });

  it('keeps dependencies, build output, secrets and binaries out', () => {
    expect(skipReason('node_modules/react/index.js', 10)).toBe('ignored');
    expect(skipReason('apps/web/.next/x.js', 10)).toBe('ignored');
    expect(skipReason('.git/config', 10)).toBe('ignored');
    expect(skipReason('.env', 10)).toBe('secret');
    expect(skipReason('.env.production', 10)).toBe('secret');
    expect(skipReason('certs/server.pem', 10)).toBe('secret');
    expect(skipReason('.env.example', 10)).toBeNull();
    expect(skipReason('public/logo.png', 10)).toBe('binary');
    expect(skipReason('src/data.json', 2_000_000)).toBe('large');
    expect(skipReason('src/app.tsx', 1000)).toBeNull();
    expect(looksBinary('abc\u0000def')).toBe(true);
    expect(looksBinary('export const a = 1;')).toBe(false);
  });

  it('starts a Flutter project as a mobile app', () => {
    expect(guessProjectType(['pubspec.yaml', 'lib/main.dart'])).toBe('mobile');
    expect(guessProjectType(['package.json'])).toBe('webapp');
  });

  it('names the source after the folder or the single file', () => {
    expect(sourceLabel(['shop/src/a.ts', 'shop/b.ts'])).toBe('shop');
    expect(sourceLabel(['notes.md'])).toBe('notes.md');
    expect(sourceLabel(['a.ts', 'b.ts'])).toBe('2');
  });

  it('splits files into change sets the API accepts', () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 450; i++) files.set(`f${String(i).padStart(3, '0')}.ts`, 'x');
    const b = batchPatches(files);
    expect(b.map((x) => x.length)).toEqual([MAX_PATCHES_PER_CHANGE, MAX_PATCHES_PER_CHANGE, 50]);
    expect(b.flat().every((p) => p.op === 'add')).toBe(true);
    const big = new Map([
      ['a.txt', 'a'.repeat(900_000)],
      ['b.txt', 'b'.repeat(900_000)],
      ['c.txt', 'c'.repeat(900_000)],
      ['d.txt', 'd'.repeat(900_000)],
      ['e.txt', 'e'.repeat(900_000)],
      ['f.txt', 'f'.repeat(900_000)],
    ]);
    expect(batchPatches(big).map((x) => x.length)).toEqual([5, 1]);
  });

  it("leaves out what the project's .gitignore excludes", () => {
    const ig = gitignoreMatcher(
      [
        '# comment',
        '*.log',
        '/secrets/',
        'cache/',
        'docs/**/*.pdf',
        '!keep.log',
        'apps/*/tmp',
      ].join('\n'),
    );
    expect(ig('debug.log')).toBe(true);
    expect(ig('src/server/error.log')).toBe(true);
    expect(ig('secrets/a.txt')).toBe(true);
    expect(ig('lib/secrets/a.txt')).toBe(false);
    expect(ig('packages/x/cache/y.js')).toBe(true);
    expect(ig('cache')).toBe(false);
    expect(ig('docs/a/b/c.pdf')).toBe(true);
    expect(ig('apps/web/tmp/x')).toBe(true);
    expect(ig('src/app.ts')).toBe(false);
  });
});
