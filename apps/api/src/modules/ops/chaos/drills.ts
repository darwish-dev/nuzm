/**
 * Chaos / failure drills (M12 §11, FR-OPS-02) as DATA: each drill names its assertion, the automated test that already asserts it on this branch (a
 * file and a phrase that must appear in it), or the reason it cannot be asserted yet. `chaos-drills.spec.ts` fails when a referenced test disappears,
 * so the registry cannot rot into a claim. A drill is `COVERED` only when the test runs in `pnpm test:integration` against a real database; the
 * fault there is injected at the adapter / worker / lease boundary, NOT on real infrastructure: that part stays NOT VERIFIED (staging drill, HG-05-xx).
 */
export interface Drill {
  id: string;
  fault: string;
  assertion: string;
  status: 'COVERED_BY_INTEGRATION_TEST' | 'BLOCKED' | 'NOT_BUILT';
  tests: { file: string; phrase: string }[];
  blockedBy?: string;
  realInfra: 'NOT VERIFIED' | 'BLOCKED';
}

export const DRILLS: Drill[] = [
  {
    id: 'CH-01',
    fault: 'provider timeout / uncertain outcome on provision (adapter fault injection)',
    assertion: 'reconcile before retry; 0 duplicate billable resources',
    status: 'COVERED_BY_INTEGRATION_TEST',
    realInfra: 'NOT VERIFIED',
    tests: [
      {
        file: 'apps/api/src/modules/cloud/compute-reliability.int.spec.ts',
        phrase: 'reconciler finds it by token and completes the operation with ONE provider create',
      },
      {
        file: 'apps/api/src/modules/domains/domains-orders.int.spec.ts',
        phrase: '0 duplicate registrations, 0 duplicate charges',
      },
    ],
  },
  {
    id: 'CH-02',
    fault: 'provider outage',
    assertion: 'circuit breaker opens, offers hidden, operations waiting_provider',
    status: 'COVERED_BY_INTEGRATION_TEST',
    realInfra: 'NOT VERIFIED',
    tests: [
      { file: 'packages/platform/src/operations.int.spec.ts', phrase: 'waiting_provider' },
      { file: 'apps/api/src/modules/cloud/cloud.int.spec.ts', phrase: 'circuit' },
    ],
  },
  {
    id: 'CH-03',
    fault: 'database primary failover',
    assertion: 'API recovers in <= 5 min, 0 acknowledged writes lost, 0 ledger imbalance',
    status: 'BLOCKED',
    realInfra: 'BLOCKED',
    blockedBy:
      'needs a replicated Postgres on staging (HG-01-xx / D-03); the local single-node cluster cannot fail over. The ledger append-only and balanced-posting guards are asserted by billing/ledger.int.spec.ts (a DB-level guarantee, not a failover test)',
    tests: [
      {
        file: 'apps/api/src/modules/billing/ledger.int.spec.ts',
        phrase: 'runtime roles cannot insert, update or delete ledger tables directly',
      },
    ],
  },
  {
    id: 'CH-04',
    fault: 'Redis / queue loss (the queue is PostgreSQL on this branch: platform.outbox)',
    assertion: 'outbox replay: 0 lost events, duplicates deduped',
    status: 'COVERED_BY_INTEGRATION_TEST',
    realInfra: 'NOT VERIFIED',
    tests: [
      {
        file: 'packages/platform/src/outbox.int.spec.ts',
        phrase: 'a failing handler loses nothing: the event is redelivered after the lock expires',
      },
    ],
  },
  {
    id: 'CH-05',
    fault: 'duplicate and out-of-order PSP webhooks',
    assertion: '0 duplicate effects',
    status: 'COVERED_BY_INTEGRATION_TEST',
    realInfra: 'NOT VERIFIED',
    tests: [
      {
        file: 'apps/api/src/modules/payments/refunds-topups.int.spec.ts',
        phrase: 'a duplicate webhook delivered 5 times credits once',
      },
      {
        file: 'apps/api/src/modules/payments/payments.int.spec.ts',
        phrase: 'webhook_out_of_order',
      },
      {
        file: 'apps/api/src/common/idempotency.int.spec.ts',
        phrase: '50 duplicate parallel POSTs',
      },
    ],
  },
  {
    id: 'CH-06',
    fault: 'duplicate / forged registrar, email and cloud webhooks',
    assertion: '0 duplicate effects, forged signatures refused',
    status: 'COVERED_BY_INTEGRATION_TEST',
    realInfra: 'NOT VERIFIED',
    tests: [
      {
        file: 'apps/api/src/modules/domains/domains-webhooks.int.spec.ts',
        phrase: 'forged signatures are 401',
      },
    ],
  },
  {
    id: 'CH-07',
    fault: 'worker crash mid-operation',
    assertion: 'lease expiry, operation resumed by another worker',
    status: 'COVERED_BY_INTEGRATION_TEST',
    realInfra: 'NOT VERIFIED',
    tests: [
      {
        file: 'packages/platform/src/operations.int.spec.ts',
        phrase: "a dead worker's operation is reclaimed",
      },
    ],
  },
  {
    id: 'CH-08',
    fault: 'clock skew on ZATCA submission',
    assertion: 'the submission is rejected or deferred, never signed with a wrong time',
    status: 'NOT_BUILT',
    realInfra: 'BLOCKED',
    blockedBy:
      'a skew-injection test for the ZATCA signer does not exist; production onboarding is HG-03-03',
    tests: [{ file: 'apps/api/src/modules/invoicing/zatca.int.spec.ts', phrase: 'zatca' }],
  },
  {
    id: 'CH-09',
    fault: 'secrets vault unavailable',
    assertion: 'fails closed: no operation proceeds without its secret',
    status: 'NOT_BUILT',
    realInfra: 'BLOCKED',
    blockedBy: 'D-12 (production vault) is open; only the dev file store exists',
    tests: [{ file: 'apps/api/src/common/secrets.ts', phrase: 'refuse' }],
  },
  {
    id: 'CH-10',
    fault: 'SSO identity provider unreachable / SAML response replay storm',
    assertion:
      'sign-in fails closed; replays refused; password path stays closed for enforced domains',
    status: 'COVERED_BY_INTEGRATION_TEST',
    realInfra: 'NOT VERIFIED',
    tests: [
      { file: 'apps/api/src/modules/enterprise/saml/saml.spec.ts', phrase: 'replayed assertion' },
      {
        file: 'apps/api/src/modules/enterprise/enterprise.int.spec.ts',
        phrase: 'blocks password sign-in and registration for that domain',
      },
    ],
  },
];
