/**
 * DEV ONLY (M07): when `DOMAINS_DEV_MOCKS=true` the dev stack starts local MOCK registrar servers (Openprovider and ResellerClub shaped from their
 * documentation: NOT VERIFIED vendor behaviour), points the adapter factories at them, replaces the unavailable vault by an in-memory one and creates
 * and enables one account per registrar through the admin service. Nothing here can run in production (the stack refuses) and no mock result is ever
 * labelled LIVE-VERIFIED: the adapters tag their evidence `mock`.
 */
import type { INestApplication } from '@nestjs/common';
import { OpenproviderAdapter, startOpenproviderMock } from '@nuzm/adapter-openprovider';
import { ResellerClubAdapter, startResellerClubMock } from '@nuzm/adapter-resellerclub';
import { MemoryVault } from '@nuzm/registrar-conformance';
import { FetchHttpClient } from '@nuzm/registrar-contracts';
import { ADAPTER_FACTORIES, DOMAINS_VAULT, RegistrarAdminService } from '../modules/domains';

export async function startDomainsDevMocks(
  app: INestApplication,
): Promise<{ openprovider: string; resellerclub: string }> {
  const op = await startOpenproviderMock();
  const rc = await startResellerClubMock();
  const vault = new MemoryVault()
    .set('vault://dev/openprovider', op.credentials)
    .set('vault://dev/resellerclub', rc.credentials)
    .set('vault://dev/openprovider-webhook', { secret: op.webhookSecret });
  const http = (id: string) =>
    new FetchHttpClient({ adapterId: id, hosts: ['127.0.0.1'], allowLoopback: true });
  // the module's own objects are updated in place: the registry and the services keep their references
  const factories = app.get(ADAPTER_FACTORIES) as Record<string, unknown>;
  factories.openprovider = (_a: unknown, d: { vault: MemoryVault }) =>
    new OpenproviderAdapter({
      baseUrl: op.url,
      http: http('openprovider'),
      vault: d.vault,
      evidenceKind: 'mock',
    });
  factories.resellerclub = (a: { currency: string }, d: { vault: MemoryVault }) =>
    new ResellerClubAdapter({
      baseUrl: rc.url,
      domainCheckUrl: rc.url,
      http: http('resellerclub'),
      vault: d.vault,
      evidenceKind: 'mock',
      currency: a.currency,
      defaultNameservers: ['ns1.example.net', 'ns2.example.net'],
    });
  const v = app.get(DOMAINS_VAULT) as { resolve: unknown; put: unknown };
  v.resolve = vault.resolve.bind(vault);
  v.put = vault.put.bind(vault);
  const admin = app.get(RegistrarAdminService);
  const actor = '00000000-0000-4000-8000-0000000000d0';
  for (const [providerCode, vaultRef, dataRegion, currency, priority] of [
    ['openprovider', 'vault://dev/openprovider', 'NL', 'EUR', 10],
    ['resellerclub', 'vault://dev/resellerclub', 'IN', 'USD', 20],
  ] as const) {
    const existing = (await admin.list()).accounts.find(
      (a) => a.providerCode === providerCode && a.vaultRef === vaultRef,
    );
    const a =
      existing ??
      (await admin.createAccount(actor, {
        providerCode,
        label: `${providerCode} (dev mock)`,
        environment: 'sandbox',
        vaultRef,
        dataRegion,
        currency,
        priority,
        ...(providerCode === 'openprovider'
          ? { webhookSecretRef: 'vault://dev/openprovider-webhook' }
          : {}),
      }));
    await admin.verify(actor, a.id, { enable: true }, 'dev-stack');
  }
  return { openprovider: op.url, resellerclub: rc.url };
}
