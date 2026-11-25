import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Db } from './db';

describe('Db connection pool', () => {
  it('handles errors of idle clients instead of letting them crash the process', async () => {
    const db = new Db('postgres://nuzm_app@127.0.0.1:1/none');
    expect(db.pool.listenerCount('error')).toBeGreaterThan(0);
    const writes: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      // what pg-pool does when the server ends an idle connection: it emits 'error' on the pool
      expect(() =>
        db.pool.emit('error', new Error('terminating connection due to administrator command')),
      ).not.toThrow();
    } finally {
      process.stderr.write = real;
      await db.pool.end();
    }
    expect(writes.join('')).toContain('db_pool_idle_client_error');
    expect(writes.join('')).toContain('terminating connection');
  });

  it('handles an error of a CHECKED-OUT client, and discards that client instead of pooling it', async () => {
    const db = new Db('postgres://nuzm_app@127.0.0.1:1/none');
    const release = vi.fn();
    const client = Object.assign(new EventEmitter(), {
      query: async () => ({ rows: [] }),
      release,
    });
    vi.spyOn(db.pool, 'connect').mockImplementation((async () => client) as never);
    const err = new Error('read ECONNRESET');
    const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await db.withoutScope(async () => {
        // an EventEmitter with no 'error' listener throws here, which is how the API process died
        expect(() => client.emit('error', err)).not.toThrow();
      });
    } finally {
      quiet.mockRestore();
    }
    expect(release).toHaveBeenCalledWith(err);
    // a healthy client goes back clean: no listener accumulates across reuse
    const healthy = Object.assign(new EventEmitter(), {
      query: async () => ({ rows: [] }),
      release,
    });
    vi.spyOn(db.pool, 'connect').mockImplementation((async () => healthy) as never);
    await db.withoutScope(async () => undefined);
    await db.withoutScope(async () => undefined);
    expect(healthy.listenerCount('error')).toBe(0);
    expect(release).toHaveBeenLastCalledWith(undefined);
    await db.pool.end();
  });
});
