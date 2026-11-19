import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../../../common/secrets';
import { ModelProviderService } from './provider.service';

/** A recording stand-in for the database: one provider row, updated in place by the two credential statements. */
function setup(env = 'test') {
  const row: Record<string, unknown> = {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'acme-ai',
    adapter: 'acme',
    display_name: 'Acme',
    region: 'sa-central',
    data_terms: { attested: false, retainsPrompts: 'unknown', trainsOnData: 'unknown' },
    attestation_ref: null,
    vault_ref: null,
    rate_card_version: '1',
    rate_card: { models: {} },
    enabled: true,
    enable_requested_by: null,
    enabled_by: 'someone',
    version: 1,
  };
  const events: unknown[] = [];
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = {
    withPlatformScope: async (
      fn: (c: { query: (sql: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }) => unknown,
    ) =>
      fn({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (/^\s*UPDATE/i.test(sql)) {
            row.vault_ref = /vault_ref=NULL/.test(sql) ? null : params[1];
            row.enabled = false;
          }
          return { rows: [row] };
        },
      }),
  };
  const audit = { record: (e: unknown) => void events.push(e) };
  const secrets = new MemorySecretStore();
  const svc = new ModelProviderService(
    db as never,
    audit as never,
    { get: () => undefined } as never,
    {} as never,
    env === 'none' ? undefined : secrets,
  );
  return { svc, row, events, queries, secrets };
}

describe('API key of a model provider', () => {
  const KEY = `test-only-${'q8Zr'.repeat(8)}`;
  it('is sealed in the secret store; the database, the audit event and the result carry only the vault reference', async () => {
    const { svc, events, queries, secrets } = setup();
    const out = await svc.setCredential('admin-1', '11111111-1111-4111-8111-111111111111', KEY);
    expect(out.vaultRef).toBe('vault://mem/ai-acme-ai');
    expect(await secrets.get(out.vaultRef!)).toBe(KEY); // the store holds it
    expect(JSON.stringify([out, events, queries])).not.toContain(KEY); // nothing else does
    expect(out.enabled).toBe(false); // a new credential means it must be enabled again
    expect(events).toMatchObject([
      {
        action: 'ai.provider.credential_set',
        detail: { code: 'acme-ai', vaultRef: 'vault://mem/ai-acme-ai' },
      },
    ]);
  });
  it('refuses a malformed key without echoing it, and a missing key', async () => {
    const { svc } = setup();
    for (const bad of [
      'short',
      'has a space in it that is long enough to pass length',
      'tab\there-and-long-enough-xxxxxxxx',
      '',
      null,
      42,
      undefined,
    ]) {
      const e = await svc
        .setCredential('a', '11111111-1111-4111-8111-111111111111', bad)
        .catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      expect(String((e as Error).message)).not.toContain(
        String(bad ?? '@@none@@') === '' ? '@@none@@' : String(bad ?? '@@none@@'),
      );
    }
  });
  it('is not available in production (the production vault is not decided) or without a secret store', async () => {
    const prod = setup();
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        prod.svc.setCredential('a', '11111111-1111-4111-8111-111111111111', KEY),
      ).rejects.toMatchObject({ code: 'unsupported_capability' });
    } finally {
      process.env.NODE_ENV = was;
    }
    await expect(
      setup('none').svc.setCredential('a', '11111111-1111-4111-8111-111111111111', KEY),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
  });
  it('removing it deletes the stored key, clears the reference and records who did it', async () => {
    const { svc, events, secrets } = setup();
    const set = await svc.setCredential('admin-1', '11111111-1111-4111-8111-111111111111', KEY);
    const out = await svc.clearCredential('admin-2', '11111111-1111-4111-8111-111111111111');
    expect(out.vaultRef).toBeNull();
    await expect(secrets.get(set.vaultRef!)).rejects.toThrow();
    expect(events.at(-1)).toMatchObject({
      action: 'ai.provider.credential_cleared',
      actorUserId: 'admin-2',
    });
  });
});
