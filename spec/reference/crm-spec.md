# Reference CRM specification — STATUS: DRAFT, NOT FROZEN

The owner freezes this file before S44 ends and records its hash in `spec/reference/crm-spec.sha256` (neither exists yet: **AC-M10-01 is BLOCKED**). This draft only restates the scope paragraph of the M10 prompt with clause ids so a test author can build a coverage matrix. It is NOT the independent suite and the generator never read it: `crm-appspec.ts` (a development fixture) was hand-written from the same paragraph.

- CRM-01 Entities: Account, Contact, Lead, Opportunity, Task, Note, Attachment (≤ 10 MB).
- CRM-02 Opportunity stages: New → Qualified → Proposal → Won/Lost.
- CRM-03 Roles: Admin, Sales Manager, Sales Rep, Read-only.
- CRM-04 Row visibility: Reps own records only; Managers their team; Admin all.
- CRM-05 CRUD with validation; CRM-06 search/filter/sort/pagination; CRM-07 pipeline board; CRM-08 CSV import/export; CRM-09 audit trail per record; CRM-10 three dashboard widgets; CRM-11 Arabic RTL + English; CRM-12 REST API with OpenAPI; CRM-13 e-mail on assignment (M08 transactional e-mail; mock allowed in test).
Targets (proposals): ≥ 150 cases, every clause ≥ 1 case, P0 (auth, RBAC, isolation, CRUD, pipeline) ≥ 60.
