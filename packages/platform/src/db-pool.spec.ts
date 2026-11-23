import { describe, expect, it } from 'vitest';
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
});
