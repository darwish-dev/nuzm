import { describe, expect, it } from 'vitest';
import { FsObjectStore, S3ObjectStore, resolveKnowledgeStore } from './index';

const S3 = {
  KNOWLEDGE_STORE_DRIVER: 's3',
  KNOWLEDGE_S3_ENDPOINT: 'https://s3.example.test',
  KNOWLEDGE_S3_REGION: 'me-central-1',
  KNOWLEDGE_S3_BUCKET: 'nuzm-knowledge',
  KNOWLEDGE_S3_ENCRYPTION: 'AES256',
};
const KEYS = {
  KNOWLEDGE_S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  KNOWLEDGE_S3_SECRET_ACCESS_KEY: 'secret-for-tests',
};
const vault = () => Promise.resolve({ accessKeyId: 'AKIDVAULT', secretAccessKey: 'vault-secret' });
const ATT = { KNOWLEDGE_S3_ATTESTATION: 'HG-D42-2026-11' };

describe('resolveKnowledgeStore', () => {
  it('development defaults to the filesystem adapter and says production is blocked by D-42', () => {
    const r = resolveKnowledgeStore({});
    expect(r.store).toBeInstanceOf(FsObjectStore);
    expect(r.status).toMatchObject({
      adapter: 'filesystem',
      production: 'none',
      blockedBy: 'D-42',
    });
  });
  it('production NEVER selects the filesystem adapter', () => {
    for (const env of [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'production', KNOWLEDGE_STORE_DRIVER: 'fs' },
    ]) {
      const r = resolveKnowledgeStore(env);
      expect(r.store).toBeNull();
      expect(r.status.adapter).toBe('unconfigured');
    }
  });
  it('S3 in development takes keys from the environment (a local MinIO)', () => {
    const r = resolveKnowledgeStore({
      ...S3,
      ...KEYS,
      KNOWLEDGE_S3_ENDPOINT: 'http://127.0.0.1:9000',
    });
    expect(r.store).toBeInstanceOf(S3ObjectStore);
    expect(r.status).toMatchObject({ adapter: 's3', production: 'none' });
  });
  it('production S3 needs the full configuration, vault credentials, https and a human attestation', () => {
    const prod = { NODE_ENV: 'production', ...S3 };
    const ok = resolveKnowledgeStore({ ...prod, ...ATT }, { credentials: vault });
    expect(ok.store).toBeInstanceOf(S3ObjectStore);
    expect(ok.status).toMatchObject({ adapter: 's3', production: 'provider', blockedBy: null });
    // each missing piece alone is enough to refuse
    expect(
      resolveKnowledgeStore({ ...prod }, { credentials: vault }).status.problems.join(),
    ).toMatch(/ATTESTATION/);
    expect(resolveKnowledgeStore({ ...prod, ...ATT }).status.problems.join()).toMatch(/vault/);
    expect(resolveKnowledgeStore({ ...prod, ...ATT, ...KEYS }).store).toBeNull(); // environment keys are not accepted in production
    expect(
      resolveKnowledgeStore(
        { ...prod, ...ATT, KNOWLEDGE_S3_ENDPOINT: 'http://s3.example.test' },
        { credentials: vault },
      ).status.problems.join(),
    ).toMatch(/https/);
    expect(
      resolveKnowledgeStore(
        { ...prod, ...ATT, KNOWLEDGE_S3_ATTESTATION: 'yes' },
        { credentials: vault },
      ).store,
    ).toBeNull();
    for (const k of [
      'KNOWLEDGE_S3_ENDPOINT',
      'KNOWLEDGE_S3_REGION',
      'KNOWLEDGE_S3_BUCKET',
      'KNOWLEDGE_S3_ENCRYPTION',
    ]) {
      const env: Record<string, string | undefined> = { ...prod, ...ATT };
      delete env[k];
      expect(resolveKnowledgeStore(env, { credentials: vault }).store, k).toBeNull();
    }
  });
  it('encryption is mandatory and must be a known mode', () => {
    expect(
      resolveKnowledgeStore({ ...S3, ...KEYS, KNOWLEDGE_S3_ENCRYPTION: 'none' }).store,
    ).toBeNull();
    expect(
      resolveKnowledgeStore({
        ...S3,
        ...KEYS,
        KNOWLEDGE_S3_ENCRYPTION: 'aws:kms',
        KNOWLEDGE_S3_KMS_KEY_ID: 'alias/nuzm',
      }).store,
    ).toBeInstanceOf(S3ObjectStore);
  });
  it('an unknown or missing driver yields no store; problems never contain a secret', () => {
    expect(resolveKnowledgeStore({ KNOWLEDGE_STORE_DRIVER: 'gcs' }).store).toBeNull();
    const r = resolveKnowledgeStore({ NODE_ENV: 'production', ...S3, ...KEYS });
    expect(JSON.stringify(r.status)).not.toContain('secret-for-tests');
  });
});
