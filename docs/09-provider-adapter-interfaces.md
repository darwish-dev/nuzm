# Nuzm — Provider Adapter Interfaces (draft)

TypeScript contracts live in `packages/adapters/contracts` (created in M05 S16; domain-specific contracts for registrars/data/email created in their milestones but **must conform to this document**). Interface details here are *our* contract; they do not assert what any vendor's API can do. Each adapter must prove its capability set with a **probe** against the real account (or sandbox) and publish it to `cloud.provider_capabilities`; unprobed capabilities are `unknown` and treated as unsupported.

## 1. Common contract (all adapters)
```ts
interface AdapterBase {
  readonly id: string;                      // e.g. "alibaba-ecs"
  readonly kind: 'compute'|'hosting'|'registrar'|'database'|'cache'|'object-storage'|'transactional-email'|'mailbox'|'psp'|'einvoice'|'model';
  readonly contractVersion: string;
  probe(ctx: AccountContext): Promise<CapabilityReport>;       // reads-only, side-effect free
  health(ctx: AccountContext): Promise<HealthReport>;
  catalog(ctx: AccountContext): Promise<CatalogSnapshot>;      // regions/plans/prices with verification evidence
}
interface AccountContext { providerAccountId: string; credentialRef: string /* vault://… */; traceId: string; deadlineMs: number; }
interface CapabilityReport { capabilities: Record<CapabilityId, 'supported'|'unsupported'|'unknown'>; evidence: RawEvidence[]; probedAt: string; }
interface OperationResult<T> { status: 'succeeded'|'accepted'|'failed'|'uncertain'; providerRef?: string; data?: T; error?: NormalizedError; raw: RawEvidence; }
```
Rules:
1. **No DB access, no secrets in logs.** Adapters get credentials by reference and resolve them via the vault client; they return `RawEvidence` (redacted request/response metadata) which the orchestrator stores.
2. **Deterministic idempotency:** every mutating call receives `idempotencyToken` (derived `sha256(orgId|operationId|stepId)`). If the vendor supports client tokens it is passed; else adapter implements `findByToken` via tags/names so the reconciler can look up before retry.
3. **Timeouts/`uncertain`:** a timeout or ambiguous failure returns `status:'uncertain'`; orchestrator moves the operation to `needs_reconcile`, calls `inspect`/`findByToken`, and only retries when provably absent.
4. **Errors normalized** to `{category: auth|quota|capacity|validation|not_found|conflict|rate_limit|provider_outage|unsupported|unknown, retryable, providerCode, message}`.
5. **Rate limiting and concurrency** configured per account; the framework applies token-bucket + circuit breaker.
6. **Conformance kit** (`packages/adapters/conformance`): shared test suite each adapter must pass against (a) recorded sandbox fixtures, (b) mock server in CI; live runs are separate, human-triggered, and results are tagged `LIVE-VERIFIED` or `NOT VERIFIED`.
7. Feature gating: capabilities map → UI/API hide or disable unsupported actions; API returns `422 unsupported_capability` (never a silent no-op).

## 2. ComputeAdapter (Alibaba Cloud ECS, Huawei Cloud ECS, Contabo VPS)
```ts
interface ComputeAdapter extends AdapterBase {
  kind:'compute';
  listRegions(ctx): Promise<ProviderRegion[]>;          // each with countryCode, verifiedAt, evidence
  listPlans(ctx, region): Promise<ProviderPlan[]>;      // vcpu, memory, disk, bandwidth, price{amount,currency,period}, availability
  listImages(ctx, region): Promise<ProviderImage[]>;
  quote(ctx, req: ProvisionRequest): Promise<ProviderQuote>;                // may be derived from catalog if no quote API
  provision(ctx, req: ProvisionRequest & {idempotencyToken}): Promise<OperationResult<InstanceRef>>;
  inspect(ctx, ref): Promise<OperationResult<InstanceState>>;
  findByToken(ctx, token): Promise<OperationResult<InstanceRef|null>>;
  act?(ctx, ref, action: 'start'|'stop'|'reboot'|'resize'|'snapshot', params): Promise<OperationResult<void>>;  // each action individually capability-gated
  delete(ctx, ref): Promise<OperationResult<void>>;
  metrics?(ctx, ref, window): Promise<OperationResult<Metrics>>;
  fetchBilling?(ctx, period): Promise<ProviderCostRecord[]>;                // for cost reconciliation (M02/M03 finrec)
}
```
Provider-specific notes (obligations, not claims): Alibaba/Huawei adapters must verify the Saudi region list from the live account and **never** serve an offer for a region absent from probe results; Contabo adapter must detect plan-specific API support and location availability per account and disable unsupported actions (resize/snapshot/etc.) per probe.

## 3. HostingAdapter (CloudPanel nodes and node agent)
```ts
interface HostingAdapter extends AdapterBase {
  kind:'hosting';
  inventory(ctx, node): Promise<NodeState>;                 // capacity, versions, health
  createSite(ctx, node, spec: SiteSpec & {idempotencyToken}): Promise<OperationResult<SiteRef>>;
  updateSite / deleteSite / suspendSite / resumeSite
  issueCertificate(ctx, site, domains): Promise<OperationResult<CertRef>>;
  createDatabaseBinding?(…)  backup(ctx, site): Promise<OperationResult<BackupRef>>; restore(ctx, site, backupRef)
  usage(ctx, site): Promise<SiteUsage>;                     // disk, bandwidth, inode, cpu — feeds metering
}
```
Implementation path (documented API/CLI vs authenticated **node agent** with mTLS, signed commands, allow-listed operations; never UI scraping) is decided by D-20 after the M06 validation spike. Isolation contract: every site gets its own Linux user, chroot/jail-equivalent boundary, per-site PHP-FPM pool, per-site DB user; the adapter's conformance tests must include cross-site read attempts.

## 4. RegistrarAdapter (Openprovider, ResellerClub; optional OpenSRS/CentralNic/eNom/Namecheap/GoDaddy)
```ts
interface RegistrarAdapter extends AdapterBase {
  kind:'registrar';
  supportedTlds(ctx): Promise<TldSupport[]>;               // per-TLD: register/transfer/renew/dns/privacy/eligibility rules
  search(ctx, names, tlds): Promise<AvailabilityResult[]>; // price, premium flag, cache TTL
  register(ctx, req: RegisterRequest & {idempotencyToken}): Promise<OperationResult<DomainRef>>;
  transferIn / renew / setContacts / setNameservers / lock / unlock / authCode
  dns?: { listZone, applyChangeSet(zone, changes) }
  findByToken(ctx, token): Promise<OperationResult<DomainRef|null>>;
  eligibility?(ctx, tld, registrant): Promise<EligibilityResult>;        // Saudi/other restricted TLDs
  fetchBilling?(ctx, period): Promise<ProviderCostRecord[]>;
  parseWebhook?(headers, body): VerifiedEvent;             // signature verified
}
```

## 5. Data adapters (contracts defined in M08; selection per D-05..D-09)
- `DatabaseAdapter` (`postgresql|mysql`): create/inspect/delete, resize, backup, restore-to-new, credential rotation, `fetchBilling?`.
- `CacheAdapter` (`redis`): create/inspect/delete, TLS/ACL, failover info.
- `ObjectStorageAdapter`: create bucket, policy, lifecycle, signed URL, usage (`bytesStored`, `egressBytes`, `requests`), tenant-isolated credentials (per-bucket or per-org scoped keys).
- `TransactionalEmailAdapter`: verifyDomain, send(message, idempotencyKey), parseWebhook, suppression sync, usage.
- `MailboxAdapter`: provisionMailbox, alias, quota, delete, DNS requirements (MX/SPF/DKIM/DMARC) returned declaratively for M07 DNS.
Each has **two implementation families** where D-05..D-09 proposes it: `provider-*` (vendor-managed, enabled only when probed) and `self-operated-*` (Nuzm-run on verified compute).

## 6. Commercial/financial adapters (M03)
`PspAdapter` (createCustomer, tokenizeSetup, createIntent, capture, refund, parseWebhook, listSettlements for reconciliation) and `EInvoiceAdapter` (`zatca-native` or `zatca-vendor`): `onboard`, `generateDocument`, `stamp`, `submit(clearance|reporting)`, `status`, `retry`. Both include sandbox and production modes; production use requires HG-03-02/03.

## 7. Model adapter (M09)
`ModelAdapter`: `complete`, `stream`, `embed?`, `tokenCount`, `region`, `dataTerms` (retention/training flags as declared by contract, human-verified), `pricing`. Gateway enforces D-18/residency before dispatch.

## 8. Registry and capability matrix
`cloud.providers` → `cloud.provider_accounts` → `cloud.provider_capabilities(account_id, capability_id, state, probed_at, evidence_ref)` and `cloud.provider_regions(…, verified_at, evidence_ref)`. **Offer eligibility = account healthy ∧ region verified ∧ plan available ∧ capability supported ∧ residency policy allows ∧ org entitlement/quota allows ∧ price present.** Any false → offer not shown.
