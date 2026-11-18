# docs/adapters — vendor adapter notes

A `provider-*` adapter (vendor-managed database, cache, object storage, transactional email, mailbox) may be implemented **only against official vendor documentation**,
cited here in `docs/adapters/<provider>.md` with the URL, the date read and the exact operations relied on. Anything that is not documented is capability
`unsupported` (docs/09 §1 rule 7). The agent never invents API methods, regions, plans, prices, rights or results (CLAUDE.md §4).

**Status at M08:** no vendor has been selected (D-05..D-09 OPEN) and no vendor documentation has been cited, so there is no `<provider>.md` yet. The skeletons in
`packages/adapters/data/src/provider-skeleton.ts` declare every capability `unknown` and make no network call. The Nuzm-run `self-operated-*` families do not depend on a vendor.

Template for a vendor note:

| Section | Content |
|---|---|
| Source | official documentation URL, version, date read |
| Operations used | each adapter method → the documented API operation (name, idempotency support, error codes) |
| Capabilities | each capability id → supported/unsupported, with the documentation reference |
| Regions | how the region list is obtained from the live account (never from this note) |
| Webhooks | signature scheme, replay window, event schema (email) |
| Not documented | what stays `unsupported` |
