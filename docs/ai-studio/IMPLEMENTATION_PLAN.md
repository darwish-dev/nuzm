# AI Studio — Implementation Plan

The AI Builder exists (M09–M12, unsigned). The plan therefore adds only what is missing — GitHub, Skills, Instructions, a gated
Claude Code capability — and enhances the file manager, templates and quality checks. Public contracts (endpoints, tables) wait
for the owner's approval of proposed ADR-064 and decisions D-37..D-40 (`docs/07`), per `CLAUDE.md` §2 and §11.

## 1. Gates
| Gate | Blocks | State |
|---|---|---|
| D-37 AI Studio scope additions (ADR-064) | GitHub/Skills/Instructions endpoints and tables | **new, OPEN** |
| D-38 hosted Claude Code legal review | Mode A in any customer environment | **new, OPEN** |
| D-39 GitHub App registration & permissions | GitHub engine | **new, OPEN** |
| D-40 third-party Skills sources & licensing | publishing third-party skills | **new, OPEN** |
| D-21, HG-10-02 | isolating sandbox (production IDE, terminal, installs, dev previews, Mode A) | OPEN / PENDING |
| PA-M10-01 | exposing the terminal route | PENDING |
| HG-09-01, D-18 | real model use in Mode B | PENDING / OPEN |

## 2. Sequence
| Step | Content | Needs | Status |
|---|---|---|---|
| **S-00** | Audit (7 docs), ADR-064 proposal, decision rows D-37..D-40 | — | **done** |
| **S-A1** | Pure libraries in `packages/domain/src/ai-studio`: Skill manifest parser · Skill static scanner (reuses `scanForSecrets`, `looksLikeInjection`) · Skill compatibility/dependency resolver · Instruction composer (layer precedence, stricter-wins for security, conflict report, preserved customer blocks). Unit-tested, no I/O, no public contract. | — | **done** |
| S-A2 | Spec change: OpenAPI + ownership manifest for `builder.skills*`, `builder.project_skills`, `builder.project_instructions*`, `builder.github_*`; `spec:lint`/`spec:drift` clean | D-37 | waiting |
| S-A3 | Instructions API + project page (editor, generated preview, history, conflict warnings); template manifests gain instruction layers | S-A2 | waiting |
| S-A4 | Skills registry + admin (catalog, versions, reviews, approve/reject/disable); importer: pinned SHA → quarantine → scan → human approval (two-person for executable skills) | S-A2, D-40 | waiting |
| S-A5 | Skills installer: resolve per project, write `.claude/skills/` + `CLAUDE.md` into the project file store and Git; project Skills tab | S-A3, S-A4 | waiting |
| S-A6 | File manager enhancements (rename/move/copy/upload/search/history/diff/restore) on `builder.project_files` with the existing `checkPath` | spec change | waiting |
| S-A7 | GitHub App via `GitHostAdapter`: connect, import, branch, commit, push, PR, webhook dedupe; no force-push; no overwrite of uncommitted work | D-39, S-A2 | waiting |
| S-A8 | Claude Code in sandbox: unmodified binary in the sandbox image; customer signs in themselves; Nuzm shows observed state only; production flag off | D-38, D-21 | waiting |
| S-A9 | Quality additions (secret scan, SEO, a11y, dependency audit as `test_runs` kinds) | — | can follow S-A6 |

## 3. Sprint report — S-00 + S-A1
```
Sprint: S-00 (audit) + S-A1 (pure Skills/Instructions core)
Status: implemented and unit-tested; nothing exposed; no owner decision consumed
Implemented: docs/ai-studio/*.md; ADR-064 (Proposed); docs/07 D-37..D-40;
             packages/domain/src/ai-studio/{skill-manifest,skill-scan,skill-resolver,instructions}.ts (+ specs)
Database migrations: none
Tests: see the final report of this change (pnpm --filter @nuzm/domain test, typecheck, lint)
Known issues: scanner is a pattern scanner, not a sandboxed analysis; YAML front matter subset only
Security: libraries never execute content; findings never quote matched secrets
External dependencies: none
Next: owner decisions D-37..D-40 → S-A2 spec change
```
