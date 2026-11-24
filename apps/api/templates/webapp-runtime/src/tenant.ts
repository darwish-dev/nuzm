import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantContext } from './types.ts';

/**
 * Multi-tenant apps: the tenant of the authenticated request. The engine opens this context after authentication, from the tenant stored on the USER ROW (never from a header, a
 * query string or a body). The stores read it: the memory store filters by it, the PostgreSQL store sets `app.tenant_id` for the transaction and the row-level-security policies
 * do the rest. No context = no tenant data (fail closed).
 */
const storage = new AsyncLocalStorage<TenantContext>();
export function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ tenantId }, fn);
}
export function currentTenant(): string | null {
  return storage.getStore()?.tenantId ?? null;
}
