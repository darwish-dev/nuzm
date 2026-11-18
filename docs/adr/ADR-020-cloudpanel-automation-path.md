# ADR-020: CloudPanel automation path (decision D-20; named ADR-017 in the M06 prompt)

- Status: **Proposed** (not binding until the owner accepts it; the agent may not accept it)
- Related decision: D-20 (`docs/07-open-decisions-and-blockers.md`), HG-06-01
- Numbering note: the M06 prompt names this record ADR-017, but `ADR-017` is already taken by *billing scheduler runs in the API process* (SI-M06-5). It is filed as ADR-020 here; renumbering is a mechanical rename at merge (M05/M07/M08 sessions may also add ADRs).
- Evidence: `docs/reports/evidence/M06/cloudpanel-spike-findings.md` (26 capability rows, each cited with URL, read date 2026-11-18, changelog head CloudPanel 2.5.4)

## Context
Nuzm runs multi-customer shared hosting on platform-operated VPS nodes managed with CloudPanel (FR-HST-01..08). D-20 requires the automation path to be decided by evidence: documented API/CLI first, else an authenticated node agent, never UI scraping. This ADR rests on **documentation analysis only**; no node has been available (HG-06-01 PENDING), so nothing is `LIVE-VERIFIED`.

## Findings in brief (full table in the evidence file)
- Documented: a local CLI `clpctl` with `site:add:{php,nodejs,static,python,reverse-proxy}`, `site:delete`, `db:add|export|import`, `lets-encrypt:install:certificate`, `site:install:certificate`, panel `user:*`, vhost *templates*.
- **Not documented:** any remote API (a public feature request asks for one), site listing, idempotent re-run semantics, JSON output, adding a domain/alias to an existing vhost, suspend/resume, quotas, usage reporting, a backup CLI, backup encryption, certificate renewal behaviour.
- **Unclear:** per-site PHP-FPM pool/`open_basedir`, CLI command-name stability (a command is named differently in a blog and the current docs).
- Security history: repeated privilege escalations and command-injection fixes in 2.3.x–2.5.0 (changelog) → CloudPanel isolation cannot be the only boundary.
- Licence: the terms (dated July 2020) require the licensor's written consent to host the software for third parties or to resell/rent it; whether Nuzm's model is affected is a **legal question** that blocks HG-06-01 (not answered here).

## Decision (PROPOSED)
**Option (b): a Nuzm node agent** that executes a strict allow-list of commands, using documented `clpctl` commands only for the capabilities rated `documented` and Linux system primitives for the rest (each marked "verify live"). Option (a) (documented CLI/API alone) is rejected because rows 6-8, 13, 16-20 show it cannot meet FR-HST-01..08. **Option (c), UI scraping, is rejected.**

Design consequences (details in `docs/runbooks/node-agent-threat-model.md`):
1. Control plane code talks to nodes only through the `CloudPanelTransport` port; the production transport is the agent channel; tests use the mock agent. The HostingAdapter never builds a shell string.
2. Agent: outbound mTLS (no inbound exposure), short-lived per-node client certificates from the Nuzm internal CA, Ed25519-signed command envelopes (node id, operation id, idempotency token, nonce, expiry, command id, args), per-command JSON-schema args, argv-only execution, timeouts and output caps, local append-only audit log, signed self-update, replay protection.
3. Because the CLI has no listing or idempotency, the **agent keeps the authoritative site registry for its node** (site name = `s-<token>` derived from the idempotency token) and `findByToken`/`inventory` are answered from it plus filesystem facts. Re-running `site:add:*` is guarded by the registry (create-if-absent).
4. Offered runtimes and PHP versions are what the node's **probe** reports; the agent pins the `clpctl` version it has been validated against and the allow-list is gated by that version.
5. Backup, quota, usage, suspend and per-site hardening are agent commands on system primitives; none of them is claimed to exist in CloudPanel.

## Alternatives considered
(a) documented API/CLI only — insufficient as above. (c) UI scraping — rejected (no contract, privileged headless session, fix history of auth/file-manager flaws). (d) Do not use CloudPanel; Nuzm-built hosting stack — out of scope for M06, would revisit if the licence review forbids the model.

## Consequences
Agent code and its supply chain become part of the security perimeter (pen test scope, HG-12-01). Live validation on a real node is mandatory before any customer data (rows listed in the findings). If the licence review rejects the model, M06 stops at the adapter boundary and D-20 is reopened with option (d).

## Owner / date
OWNER-PLACEHOLDER / — (acceptance recorded by the owner only)
