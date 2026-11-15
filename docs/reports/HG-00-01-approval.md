# HG-00-01 — Documentation Set Approval Record

- Date: 2026-11-15
- Source: owner's reply in the Claude Code session ("Approve, answer decisions"), followed by answers to D-01, D-02, D-30, D-32 via the question dialog. This file records that chat approval; it is not a signed document. If a signed record is required, replace it.
- Approved: documentation set v4.0-draft (`CLAUDE.md`, `docs/00`–`14`, `docs/milestones/M01`–`M12`) as the basis for starting S01 (bootstrap).
- **Not covered by this approval (still pending):** proposed endpoint additions PA-01..PA-16 (doc 04 §2.13); counsel/tax review of compliance and ZATCA content (HG-04-01, HG-04-02, HG-03-04); every other OPEN decision in doc 07, including all provider selections (D-05..D-09); brand identity assets (part of D-32).

## Decisions recorded
| ID | Answer | Consequence |
|---|---|---|
| D-01 | **Local only for now** (git init, no remote) | Bootstrap commits the CI definition (GitHub Actions format is the reversible default) but cannot run it: bootstrap criterion B8 is BLOCKED until a remote/CI exists (HG-01-01) |
| D-02 | **One team, sequential** | 58 sprints in order; parallel lanes (doc 03 §4) not used |
| D-30 | **Accept proposals**: 99.9% control-plane availability, RPO 15 min, RTO 4 h | M12 must evidence these targets; PRD §6 numbers are now the working targets |
| D-32 | **Arabic default, English supported** (RTL-first) | Brand identity (colors, logo, typography) still required from the owner before screens are finalized; until then `packages/ui` uses neutral placeholder tokens |
