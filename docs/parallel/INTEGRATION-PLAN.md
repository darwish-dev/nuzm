# Integration plan (Session 01 owns it)

Branch `integration/ai-engine`, worktree `.claude/worktrees/ai-integration`. Never merge into `main` or `claude/run-it-dc3d6a` without the owner's authorization.

## Per batch
1. `git log integration/ai-engine..<worker branch>` and the diff; verify only owned paths changed (`FILE-OWNERSHIP.md`); revert out-of-scope edits on the merge.
2. Contract check against `SHARED-CONTRACTS.md`; apply spec/SDK/ownership patches the worker supplied (Master-owned files).
3. Migration ordering check (`MIGRATION-REGISTRY.md`).
4. Security review of the diff (gates, flags, secrets, tenant scoping, audit).
5. Targeted tests of the touched packages.
6. Merge with `git merge --no-ff` (non-destructive). On conflict: resolve in the integration worktree, never rewrite a worker's branch.
7. Heavy slot (one at a time): affected integration tests; at milestones the full set (`pnpm lint`, `typecheck`, unit, `test:integration`, isolated E2E `ar` and `en`, `spec:*`, `sdk:check`, `scan:secrets`, `zatca:guard`, `claims-guard`).
8. Update `STATUS.md` and the baseline commit; tell dependent workers (file `docs/parallel/sessions/NOTICE-<n>.md` or a message to the session).

## Heavy-slot schedule
One heavy run at a time on this 4-CPU/8 GB machine; order of requests in `STATUS.md`. Typical cost: integration ≈ 12 min, one-language E2E ≈ 15–25 min, stack rebuild ≈ 6 min.

## Final acceptance (before declaring the phase complete)
All authorized unblocked tasks implemented; worker changes reviewed; contracts consistent; migrations compatible (up/down/up); unit, integration, `ar` and `en` E2E, lint, typecheck, secret scan, spec, SDK and compliance checks pass; security regression tests pass; skipped tests documented; no live capability enabled; owner decisions consolidated in `OWNER-DECISIONS.md`; offline verification kept distinct from live; delivery completion kept distinct from production readiness.
