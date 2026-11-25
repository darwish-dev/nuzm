/**
 * Static runbook index for the support handbook (UI-M12-17). Source: docs/reports/M12-handover/runbook-index.md (generated from `docs/runbooks/`
 * on this branch). Embedded as data: nothing is fetched, and the paths are plain text (the console does not serve repository files).
 * Each entry's purpose is the i18n key `m12.hb.e.<slug>`; the slug is the file name without `.md`.
 */
export const HANDBOOK_GROUPS = [
  {
    key: 'm12',
    slugs: [
      'incident-response',
      'provider-outage',
      'queue-recovery',
      'webhook-storm',
      'reconciliation-variance',
      'billing-close',
      'zatca-backlog',
      'psp-outage',
      'sandbox-escape-suspected',
      'data-breach-workflow',
      'dr-restore',
      'sso-lockout',
      'scim-failure',
      'abuse-takedown',
      'access-review-process',
    ],
  },
  {
    key: 'identity',
    slugs: ['break-glass-draft', 'customer-accounts', 'rotating-dev-secrets', 'field-encryption'],
  },
  {
    key: 'compliance',
    slugs: [
      'breach-handling',
      'dsr-handling',
      'legal-hold',
      'retention-archival',
      'compliance-evidence',
      'residency-hooks',
    ],
  },
  {
    key: 'billing',
    slugs: [
      'psp-incident',
      'reconciliation-break-handling',
      'ledger-inspection',
      'reversing-adjustment',
      'rebuild-projections',
      'metering-replay',
      'pricebook-release',
      'subscription-lifecycle',
      'dunning',
      'refund-procedure',
      'invoice-correction',
      'tax-and-invoice-numbering',
      'quotas-and-spend-approvals',
      'provider-cost-capture',
      'zatca-onboarding',
      'zatca-queue-stuck',
      'zatca-key-rotation',
    ],
  },
  {
    key: 'cloud',
    slugs: ['provider-onboarding', 'live-verification', 'reconciliation', 'orphan-handling'],
  },
  {
    key: 'hosting',
    slugs: [
      'node-onboarding',
      'drain-and-migrate',
      'site-recovery',
      'offboarding',
      'abuse-handling',
    ],
  },
  {
    key: 'domains',
    slugs: ['domains-reconcile', 'domains-registrar-outage', 'dns-degraded-zone'],
  },
  {
    key: 'data',
    slugs: [
      'db-restore',
      'db-failover',
      'storage-incident',
      'email-deliverability',
      'suppression-handling',
    ],
  },
  { key: 'platform', slugs: ['restore-db-from-dump', 'local-setup'] },
  {
    key: 'demos',
    slugs: ['demo-m02', 'demo-m03', 'demo-m04', 'demo-m06', 'demo-m08', 'domains-demo'],
  },
] as const;

export type HandbookGroupKey = (typeof HANDBOOK_GROUPS)[number]['key'];

/** Repository path of a runbook (plain text, relative to the repository root). */
export const runbookPath = (slug: string) => `docs/runbooks/${slug}.md`;

export const RUNBOOK_INDEX_PATH = 'docs/reports/M12-handover/runbook-index.md';
export const GA_CHECKLIST_PATH = 'docs/reports/ga-readiness-checklist.md';
