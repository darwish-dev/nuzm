import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

const go = (path: string) => proxy(new NextRequest(`http://localhost:3000${path}`));

describe('proxy: the client dashboard lives at /<locale>/console', () => {
  it('sends /console to the default locale', () => {
    const r = go('/console');
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get('location')!).pathname).toBe('/ar/console');
  });
  it('sends the bare locale to its console and keeps the query', () => {
    const r = go('/en?next=%2Fen%2Fbilling');
    const u = new URL(r.headers.get('location')!);
    expect(u.pathname).toBe('/en/console');
    expect(u.search).toBe('?next=%2Fen%2Fbilling');
  });
  it('leaves every other path alone', () => {
    for (const p of ['/', '/en/console', '/en/hosting', '/designs'])
      expect(go(p).headers.get('location')).toBeNull();
  });
});
