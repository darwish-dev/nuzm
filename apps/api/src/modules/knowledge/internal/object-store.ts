import {
  FsObjectStore,
  KnowledgeObjectStore,
  resolveKnowledgeStore,
  type ComposedObject,
} from '@nuzm/adapter-knowledge-store';
import { ProblemException } from '../../../common/errors';

/**
 * Object-store port of the AI Intelligence Center (ADR-065, D-42). The port and its adapters live in `@nuzm/adapter-knowledge-store`: the development filesystem
 * adapter and the S3-compatible adapter (private bucket, verified server-side encryption, signed access, configurable provider). This module only chooses between
 * them for the API and answers "not available" when nothing production-grade is configured.
 *
 * Production uploads stay OFF until a verified store is configured: `resolveKnowledgeStore` returns an S3 store in production only with a complete configuration,
 * vault-resolved credentials, a TLS endpoint and a human attestation (`KNOWLEDGE_S3_ATTESTATION=HG-…`). The API has no vault credential resolver wired for this
 * yet, so in production it is `UnconfiguredObjectStore` — which refuses every call — and D-42 remains the production blocker.
 */
export { FsObjectStore, KnowledgeObjectStore, type ComposedObject };

/** What production gets until the provider adapter is configured and attested (D-42): every call answers "not available", so nothing is written to local disk. */
export class UnconfiguredObjectStore extends KnowledgeObjectStore {
  private fail<T>(): Promise<T> {
    return Promise.reject(
      new ProblemException(
        'not_found',
        'the AI knowledge library is not available: no object store is configured (D-42)',
      ),
    );
  }
  putPart(): Promise<void> {
    return this.fail();
  }
  compose(): Promise<never> {
    return this.fail();
  }
  discardUpload(): Promise<void> {
    return this.fail();
  }
  exists(): Promise<boolean> {
    return this.fail();
  }
  size(): Promise<number | null> {
    return this.fail();
  }
  read(): Promise<Buffer> {
    return this.fail();
  }
  open(): Promise<never> {
    return this.fail();
  }
  readRange(): Promise<Buffer> {
    return this.fail();
  }
  put(): Promise<{ existed: boolean }> {
    return this.fail();
  }
  delete(): Promise<void> {
    return this.fail();
  }
  signedUrl(): Promise<string> {
    return this.fail();
  }
}

export function createKnowledgeObjectStore(
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeObjectStore {
  // production credentials come from the vault, which the API does not resolve for this store yet: no credentials callback => unconfigured in production
  return resolveKnowledgeStore(env).store ?? new UnconfiguredObjectStore();
}
export const knowledgeObjectStoreStatus = (env: NodeJS.ProcessEnv = process.env) => {
  const { problems, ...status } = resolveKnowledgeStore(env).status;
  void problems;
  return status;
};
