# Runbook: price book release (four-eyes)

Scope: `billing.price_books`, `price_book_versions`, `price_items`; rating of `usage_aggregates` into `rated_usage`.
Status: implemented in S06 and tested (publishing, immutability, re-rating, mid-period version change). **The seeded `default` book is a placeholder marked DRAFT-NOT-APPROVED; production activation is BLOCKED on HG-02-01 (owner-approved pricing/margin policy).**

## Rules
- A published version is immutable (API refuses with 409; DB triggers refuse even for the owner). Changes = a new version.
- Publishing needs `admin:billing:publish` (platform_admin) and a **different person** than the author (four-eyes). Self-approval is refused and audited.
- Numbers use exact decimals (up to 8 fractional digits, scaled integers). No floating point anywhere in rating.
- A book with `placeholder = true` (the seeded `default`) is refused for production rating.

## Procedure
1. Author creates a draft version (`POST /v1/admin/billing/price-books/{id}/versions`, body `{effectiveFrom, items[], note?}`, permission `admin:billing:manage`) with items per meter: flat, graduated, volume or allowance models. Currency is per book. Only one draft may exist per book at a time.
2. Review the draft items against the approved pricing sheet. Record the approval reference (HG-02-01 / D-23 decision id) in the version note.
3. A different admin publishes the draft (same path, body `{publishVersionId}`, permission `admin:billing:publish`). The effective date must be later than every already-published version of that book, otherwise the request is refused. Admin-realm session with MFA and step-up is required.
4. Verify: `GET /v1/admin/billing/price-books` shows the version `published`; the audit log has `billing.price_book_version.created` (author) and `billing.price_book_version.published` (publisher).
5. Rating picks the version by usage period. A mid-period version change rates each segment under its own version and pools allowances across the period (tested).

## Correcting a mistake after publish
Never edit. Publish a new version effective from the next month. If past periods were rated wrongly, re-rate: the engine writes **correction deltas** (new rows referencing the previous run), not overwrites. Ledger effects follow the reversing-entry rule.

## Rollback
There is no un-publish. Roll back by publishing a new version that restores the previous items.
