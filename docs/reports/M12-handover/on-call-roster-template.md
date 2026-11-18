# On-call roster template (M12 S58)

Status: TEMPLATE 2026-11-18. The roster itself is a human deliverable (HG-12-03, PENDING; support model D-29 OPEN). This file contains **placeholders only**: no names, phone numbers or personal data. Keep the filled roster in the team's own system and reference it here by id, not by content.

## Rules (proposals for the owner to confirm)
1. One primary and one secondary per rotation for each of L2 and L3; one named IC-capable person per shift.
2. Rotation length, hand-over time (UTC) and holiday handling: `<to be filled>`.
3. Hand-over note at every change: open incidents, running drills, flags changed, anything parked in `needs_reconcile`, pending approvals.
4. Every on-call person has, before their first shift: admin-realm account with MFA, runbook access, break-glass procedure briefing (`break-glass-draft.md`: BLOCKED until D-12), the escalation matrix, and has attended the training (`training-agenda.md`).
5. No shared accounts and no personal secrets in the roster.
6. The roster is reviewed monthly (proposal) and after every SEV1/SEV2.

## Rotation table
| Week starting (UTC) | L1 support lead | L2 primary | L2 secondary | L3 primary | L3 secondary | IC-capable | SEC on call | FIN on call |
|---|---|---|---|---|---|---|---|---|
| `<date>` | `<role-holder id>` | `<id>` | `<id>` | `<id>` | `<id>` | `<id>` | `<id>` | `<id>` |
| `<date>` | | | | | | | | |
| `<date>` | | | | | | | | |

## Reachability test (before go-live and after any change)
| Check | Done by | Date | Result |
|---|---|---|---|
| Alert reaches primary within the acknowledge target | `<role>` | `<date>` | `<PASS / FAIL / NOT VERIFIED>` |
| Secondary reached when primary does not acknowledge | `<role>` | `<date>` | |
| Escalation to L3 and IC works out of hours | `<role>` | `<date>` | |
| Owner informed path works | `<role>` | `<date>` | |

## Alert routing (to be filled when alert rules exist: `ops.alerts` carries owner, severity, runbook link)
| Alert or class | Severity | Routed to | Runbook |
|---|---|---|---|
| `<alert key>` | `<SEV>` | `<role>` | `<link>` |

## Sign-off
Roster accepted by: `<owner>` Date: `<to be filled>` Status: NOT VERIFIED (HG-12-03 PENDING).
