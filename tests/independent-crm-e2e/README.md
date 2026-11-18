# Independent CRM E2E suite — NOT AUTHORED (PROPOSED-HG-10-03)

This directory must contain a suite written by a party other than the generating agent and its prompts (human QA, or a separate agent session given only the frozen `spec/reference/crm-spec.md`). Protocol: spec frozen (hash) → suite authored with a clause→test coverage matrix → committed under CODEOWNERS owned by the test author, agent write access removed, suite hash pinned in CI → generator runs → suite executed unchanged against the deployed CRM → results archived. A suite change needs the author's approval and a re-hash with changelog.
Nothing here was written by the M10A agent, deliberately. The generator's own tests (`generated-app.int.spec.ts`, `builder-s47.int.spec.ts`) are development evidence only.
