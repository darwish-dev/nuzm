# AI Studio — Integration Risks and Provider Compliance

## 1. Hosted Claude Code (Mode A) — provider policy (read 2026-11-20)
Pages read (no publication date shown on any of them):
- `https://code.claude.com/docs/en/legal-and-compliance` — Consumer Terms govern Free/Pro/Max/Ultra; Commercial Terms govern
  Team/Enterprise/API. "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or
  to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users." Developers building products
  "should use API key authentication through Claude Console or a supported cloud provider". Customers "may not pay for, resell,
  or intermediate Claude usage on their end users' behalf"; each end user uses their own key or plan credentials. Exception: an
  end user may sign in "to the unmodified Claude Code binary with their own Claude subscription". A "mutually agreed otherwise"
  clause exists.
- `https://code.claude.com/docs/en/agent-sdk/overview` — "Unless previously approved, Anthropic does not allow third party
  developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- `https://code.claude.com/docs/en/iam` — supported auth: claude.ai subscriptions, Team/Enterprise, Console credentials, Bedrock,
  Google Cloud, Microsoft Foundry, a self-hosted gateway; no statement about shared or hosted environments.

**Consequences for the design (until counsel confirms, D-38):**
1. Allowed shape at most: the customer opens a terminal in *their own* sandbox, runs the unmodified `claude` binary and signs in
   themselves. Nuzm installs the binary, prepares files (`CLAUDE.md`, `.claude/skills/`), and observes only process/sandbox state.
2. Not allowed: a "Sign in with Claude" button in Nuzm, Nuzm storing or relaying Claude tokens, Nuzm submitting prompts through
   a customer's subscription session, Nuzm billing for Claude usage, or presenting subscription limits as Nuzm features.
3. Mode B with Anthropic models must use API keys (Console or a supported cloud provider) under the Commercial Terms, governed by
   D-18 and HG-09-01 like any other model provider.
4. Production flag `ai.claude_code_sandbox` stays off; no customer environment until D-38 is closed with a recorded opinion.

## 2. Other risks
| Risk | Impact | Mitigation | Owner item |
|---|---|---|---|
| AI modules (M09–M12) merged but no gate signed | building on unaccepted foundations | extend, do not fork; new contracts only after D-37 | owner sign-offs |
| Sandbox technology undecided | only `mock` and `local-dev` (non-isolated) runtimes exist; production IDE, terminal, installs, dev previews, Mode A blocked | existing `SandboxRuntime` boundary | D-21, HG-10-02, PA-M10-01 |
| GitHub App ownership (which account/org registers the App, data residency of webhooks) | cannot register App | ADR-064 proposal | D-39 |
| Third-party Skills licensing | redistribution of copyrighted/licensed content | license field required; unknown license ⇒ cannot publish | D-40 |
| Skills supply-chain attacks | malicious instructions reach customer sandboxes | static scan + human approval + pinned SHA + no auto-update | S-A4 |
| CloudPanel cannot run long-lived Node apps / builds | deployment target mismatch | capability matrix (ADR-011); compute targets for app runtimes | M06/M10 |
| iOS builds need macOS capacity | mobile scope gap | BLOCKED | D-22 |
| "Workspace" naming clash | confused UX and data model | use "sandbox" in code | — |
| Capacity claims (e.g. 10,000 workspaces) | unverified marketing | no claim without M12 load tests | M12 |
