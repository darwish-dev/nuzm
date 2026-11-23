import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsObjectStore } from './fs';
import type { KnowledgeObjectStore } from './port';
import { S3ObjectStore, type Encryption } from './s3';
import type { Credentials } from './sigv4';

export interface StoreStatus {
  adapter: 'filesystem' | 's3' | 'unconfigured';
  /** `provider` only when a production-grade adapter is active, attested by a human gate and verified. */
  production: 'none' | 'provider';
  blockedBy: 'D-42' | null;
  /** Why the store is unconfigured, in words (never a secret). */
  problems: string[];
}
export interface ResolvedStore {
  store: KnowledgeObjectStore | null;
  status: StoreStatus;
}
export interface ResolveOptions {
  /** Credentials resolved from the vault by the caller. In production this is the ONLY accepted source; environment keys are for development and tests. */
  credentials?: () => Promise<Credentials>;
  fetch?: typeof fetch;
}

/**
 * Which object store the platform uses (D-42, ADR-065). Production uploads stay OFF until a verified private, encrypted, S3-compatible store is configured:
 *  - development / test: the filesystem adapter, or S3 with keys from the environment (a local MinIO);
 *  - production: the S3 adapter ONLY with a complete configuration, credentials resolved from the vault by the caller, a TLS endpoint and a human attestation
 *    reference (`KNOWLEDGE_S3_ATTESTATION=HG-…`: evidence that the bucket is private and that `selfTest()` passed against it). Anything missing => no store at all
 *    (`store: null`), and every caller refuses to run. The filesystem adapter can never be selected in production.
 */
export function resolveKnowledgeStore(
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveOptions = {},
): ResolvedStore {
  const production = env.NODE_ENV === 'production';
  const driver = (env.KNOWLEDGE_STORE_DRIVER ?? (production ? '' : 'fs')).toLowerCase();
  const none = (problems: string[]): ResolvedStore => ({
    store: null,
    status: { adapter: 'unconfigured', production: 'none', blockedBy: 'D-42', problems },
  });
  if (driver === 'fs') {
    if (production) return none(['the filesystem object store is for development only']);
    return {
      store: new FsObjectStore(env.KNOWLEDGE_STORE_DIR ?? join(tmpdir(), 'nuzm-knowledge-store')),
      status: { adapter: 'filesystem', production: 'none', blockedBy: 'D-42', problems: [] },
    };
  }
  if (driver !== 's3')
    return none([
      driver ? `unknown KNOWLEDGE_STORE_DRIVER "${driver}"` : 'KNOWLEDGE_STORE_DRIVER is not set',
    ]);

  const problems: string[] = [];
  const need = (name: string) => {
    const v = env[name];
    if (!v) problems.push(`${name} is not set`);
    return v ?? '';
  };
  const endpoint = need('KNOWLEDGE_S3_ENDPOINT');
  const region = need('KNOWLEDGE_S3_REGION');
  const bucket = need('KNOWLEDGE_S3_BUCKET');
  const encType = (env.KNOWLEDGE_S3_ENCRYPTION ?? '').trim();
  if (encType !== 'AES256' && encType !== 'aws:kms')
    problems.push(
      'KNOWLEDGE_S3_ENCRYPTION must be AES256 or aws:kms (encryption at rest is required)',
    );
  const encryption: Encryption =
    encType === 'aws:kms'
      ? { type: 'aws:kms', keyId: env.KNOWLEDGE_S3_KMS_KEY_ID || undefined }
      : { type: 'AES256' };
  let credentials = opts.credentials;
  if (!credentials) {
    if (production)
      problems.push(
        'production credentials must be resolved from the vault by the caller (environment keys are not accepted in production)',
      );
    else if (env.KNOWLEDGE_S3_ACCESS_KEY_ID && env.KNOWLEDGE_S3_SECRET_ACCESS_KEY) {
      const c: Credentials = {
        accessKeyId: env.KNOWLEDGE_S3_ACCESS_KEY_ID,
        secretAccessKey: env.KNOWLEDGE_S3_SECRET_ACCESS_KEY,
      };
      credentials = () => Promise.resolve(c);
    } else
      problems.push('KNOWLEDGE_S3_ACCESS_KEY_ID and KNOWLEDGE_S3_SECRET_ACCESS_KEY are not set');
  }
  if (production) {
    if (!/^https:\/\//.test(endpoint)) problems.push('the production endpoint must use https');
    if (!/^HG-[A-Za-z0-9-]{2,60}$/.test(env.KNOWLEDGE_S3_ATTESTATION ?? ''))
      problems.push(
        'KNOWLEDGE_S3_ATTESTATION (a human-gate reference proving a private bucket and a passed self-test) is not set',
      );
  }
  if (problems.length > 0 || !credentials) return none(problems);
  try {
    const store = new S3ObjectStore({
      endpoint,
      region,
      bucket,
      credentials,
      encryption,
      forcePathStyle: env.KNOWLEDGE_S3_PATH_STYLE !== 'false',
      fetch: opts.fetch,
    });
    return {
      store,
      status: {
        adapter: 's3',
        production: production ? 'provider' : 'none',
        blockedBy: production ? null : 'D-42',
        problems: [],
      },
    };
  } catch (e) {
    return none([(e as Error).message]);
  }
}
