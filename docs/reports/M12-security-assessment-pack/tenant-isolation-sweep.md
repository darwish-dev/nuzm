# Tenant-isolation sweep

> INTERNAL, 2026-11-18. NOT independent (HG-12-01 / D-28 BLOCKED). Gate row: AC-M12-09 "0 unexplained cross-tenant 2xx across 100 % of endpoints".
>
> This document describes the sweep being implemented as `apps/api/src/modules/tenancy/tenant-sweep.int.spec.ts` by the implementing session. If the final spec file differs from this description, **the spec file's header comment and `M12-report.md` prevail**; update this file to match.
>
> **Run result: see M12-report (filled by the parent).** Nothing in this document is a result.

## 1. Why a second suite

`apps/api/src/modules/tenancy/cross-tenant.int.spec.ts` (M01 S03) already generates tests from `spec/openapi/openapi.yaml` for org-scoped operations that carry an id and have a fixture; org B's owner (session and API key) must get 404 against org A's ids. It deliberately limits itself to routes it has fixtures for and to routes with a declared org permission. The sweep closes the remaining gap: **every** operation in the spec, with no way to skip one silently.

At the time of writing the spec declares 284 operations (`spec/openapi/openapi.yaml`): 160 with an org permission (`x-nuzm-permission`), 96 with a platform permission (`x-nuzm-platform-permission`, admin console), 5 `x-nuzm-access: any-authenticated`, 1 `service-key` (`POST /v1/internal/metering/events`), 1 `public` (`POST /v1/webhooks/email/{provider}`), and 21 with no marker (auth entry points, `/healthz`, other webhooks, session/MFA routes). Counts change as milestones land; the sweep recomputes them.

## 2. What the sweep does

1. **Enumerate.** Parse `spec/openapi/openapi.yaml`; for every path x method (`get`, `post`, `put`, `patch`, `delete`) create one case. No hand-maintained list of operations.
2. **Set up two tenants.** Org A (the victim, with real resources created through the API so that ids are valid) and org B (the attacker). Both have an owner; B also has an API key.
3. **Cross-tenant tokens.** The caller is always a principal of org B: B's owner session (with CSRF token for unsafe methods) and B's API key. Requests address org A's resources: A's `orgId` in the path, A's real resource ids for every other path parameter (fixtures, as in `cross-tenant.int.spec.ts`), and A's id in `X-Nuzm-Org` where the route takes the header.
4. **Platform operations.** Operations with a platform permission are called with B's web-realm session and with B's API key; they must be refused (401/403/404), never 2xx. (Admin-realm sessions are out of this sweep's token set; they are covered by `admin.int.spec.ts`.)
5. **Bodies.** Unsafe methods send a minimal valid body when a fixture exists, else an empty or schema-derived body. A 4xx for validation is acceptable; the point is that no request reaches a 2xx.
6. **Classify each response** (see rule below) and write one result row per operation x token.

## 3. The rule

> **Any unexplained 2xx fails the build.**

| Response | Meaning |
|---|---|
| 404 (existence hiding), 401, 403, 422 before any effect | Expected for cross-tenant calls. Pass |
| 2xx, operation is on the allow-list with a reason and the reason holds | Explained. Pass |
| 2xx, operation not on the allow-list | **Unexplained: FAIL** |
| Allow-list entry that no longer matches any operation in the spec | FAIL (stale explanation) |
| Allow-list entry with an empty reason or no category | FAIL |
| Operation with no fixture for a path parameter and not on the allow-list | FAIL (coverage gap: a new route must bring a fixture or an explanation) |
| 5xx | Recommended additional FAIL (a crash on a cross-tenant call is a defect and can hide a bypass); confirm against the final spec file |

## 4. How explanations are recorded

A single allow-list constant at the top of the spec file, keyed by `METHOD /path` (the OpenAPI path template), each entry `{ category, reason }`. Categories:

| Category | Used for | Example |
|---|---|---|
| `public` | No authentication by design | `GET /healthz`, `GET /v1/auth/oidc/login`, `POST /v1/auth/password/login`, provider webhooks (`/v1/webhooks/*`: authenticated by signature, not by tenant) |
| `service-key` | Authenticated by a producer key, not a user | `POST /v1/internal/metering/events` |
| `global-reference` | Same data for every organization (`x-nuzm-global-reference: true` in the spec) | `GET /v1/billing/plans`, `GET /v1/billing/plans/{id}` |
| `own-resource` | Acts only on the caller's own identity/org, with no id of another tenant in play | `GET /v1/me`, `GET /v1/auth/sessions`, `POST /v1/organizations` (creates the caller's own org), `GET /v1/roles`, `GET /v1/permissions` |
| `token-bearer` | Possession of an unguessable token is the authorisation | invitation acceptance, email verification, password reset, SCIM and SSO callbacks (S55; SCIM uses its own bearer token and must be tested with org A's token against org B ids separately) |

Rules for entries:

- The reason is one sentence saying **why a 2xx for a tenant-B caller cannot expose tenant-A data**.
- The sweep cross-checks spec markers: `x-nuzm-access: public|service-key|any-authenticated` and `x-nuzm-global-reference: true` are read from the spec and must agree with the category; an allow-list entry that contradicts the spec fails.
- Adding an entry is a reviewed change (CODEOWNERS applies to the spec file); a reason such as "not applicable" or "internal" is rejected in review.
- New operations from M09-M12 (AI, builder, delegation, enterprise, ops) are picked up automatically; a missing fixture fails the build until one is added.

## 5. Reading the output

The spec prints, per run:

- A summary: number of operations discovered, number exercised x tokens, number explained by category, number failing.
- A table of any failures: `METHOD path | token (session|api-key) | status | reason for failure` (unexplained 2xx, stale entry, missing fixture, 5xx).
- The allow-list with each entry's category and reason, so reviewers can read what was waved through.

Interpretation:

| Output | Action |
|---|---|
| `unexplained 2xx` | Treat as a potential critical finding: reproduce by hand, fix the route (add the missing org check/RLS), add a regression test; record in the tracker (source `internal scan`) |
| `stale allow-list entry` | Remove the entry or fix the path |
| `missing fixture` | Add the fixture for the path parameter in the harness |
| Everything green | Means "no unexplained 2xx for these fixtures and tokens", not "tenant isolation is proven": see limits |

## 6. Limits (be honest in reports)

- Only tokens of one other tenant and two credential types are used; role variations (viewer vs owner of B) are covered only where the existing suite does so.
- A 404 can hide a leak through a different channel (timing, error text, side effects). The sweep checks status class; it does not diff bodies for tenant-A data, and does not assert that no write happened except where the existing tests do.
- Fixtures must exist for the interesting ids; routes whose A-side resource cannot be created locally (e.g. real provider resources) use mocked inventory rows.
- Agency delegation (`X-Nuzm-Acting-Org`, M11) needs its own matrix (`threat-model-delegation.md`); until M11 lands the header is refused by `access.guard.ts`.
- Internal self-test only; the independent vendor will repeat this class of test (`pen-test-scope.md`).

## 7. Result

Run result: **see M12-report (filled by the parent)**. Do not copy numbers here unless they come from a recorded run (command, date, commit).
