# CONTRACT-S05-P2-4 — `qualification:builder` package script

- Requester: Session 05 · Contract: `apps/api/package.json` (Master-owned, Phase 2 rule) · Status: PROPOSED · Additive, one line.
- The script exists and works: `apps/api/scripts/qualification-builder.ts` (runner and tables in `src/modules/appbuilder/internal/lifecycle/qualification.ts`). Run today with `cd apps/api && npx tsx scripts/qualification-builder.ts [--write]`. Offline: no network, no database, no provider, no process started. Prints the per-component evidence table and the five projects; every row SIMULATED; exit 1 if a project does not reach the deployment-approval request; `--write` regenerates `docs/parallel/sessions/PHASE2-05-qualification-evidence.md`.
- To apply, add to `scripts` in `apps/api/package.json`:

```json
"qualification:builder": "tsx scripts/qualification-builder.ts"
```

then `pnpm --filter @nuzm/api qualification:builder` (and `-- --write`). `tsx` is already a repo dev dependency (used by `packages/db`); if `apps/api` does not list it, add it there or use `pnpm exec tsx`.
