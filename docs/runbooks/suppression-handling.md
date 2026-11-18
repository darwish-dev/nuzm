# Runbook — suppression list handling (M08)

- **Automatic:** a hard bounce or a complaint (signed provider webhook) suppresses the address in the same transaction as the event; three soft bounces within 72 h (proposal) suppress it too. A duplicate webhook can never create a second suppression (unique per org + address hash + reason).
- **Checked twice:** before the message is queued (422 `suppressed`) and again when the provider call is about to be made (the message fails with `errorCode=suppressed`).
- **Manual add/remove:** `POST /v1/email/suppressions` (`email:domain:manage`), audited (`email.suppression.added|removed`). Removing a hard bounce or complaint needs `override:true` — do it only when the recipient confirmed the address is valid; otherwise the provider's reputation suffers.
- **Privacy:** addresses are stored sealed (field encryption) with a SHA-256 lookup hash; audit events carry a short hash prefix, never the address. A data-subject erasure request must remove the sealed address but keep the hash only if a legal-obligation exception is documented (counsel: HG-04-01). The M08 DSR handler is NOT implemented yet.
