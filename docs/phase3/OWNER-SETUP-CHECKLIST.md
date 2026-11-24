# Owner setup checklist (Phase 3): software, accounts, servers, DNS, variables, costs, approvals, validation

Status: 2026-11-24 · Master. **Nothing in this list has been done by engineering, and nothing in it is an approval.** It is the one place that says what only you can do, with the exact commands, the cost, and a read-only command that proves each step. Decisions (agreements, thresholds, budgets, policies) are in `docs/parallel/OWNER-APPROVAL-PACK.md`; this file is the *setup* side. Every command below is either run by you on your own machine or server, or is a validation command that only reads. No key, password or token is ever pasted into chat, a file in the repository, a log or a report; where a secret is involved the step says where to type it (the admin console, or your own shell, never the repository). Prices are indicative and come from the cited planning documents; none was quoted by a vendor to us and nothing has been purchased.

Legend: **STAGING** = needed for the real staging qualification track listed; **PROD** = only for production. Items can be done in any order unless one says "after".

## 0. What exists on your Mac today (checked 2026-11-24, read-only)
| Item | Found | Consequence |
|---|---|---|
| macOS / CPU | 13.7.8, x86_64 (Intel) | Apple Silicon simulators/images are not applicable; use `x86_64` Android images |
| Flutter | 3.35.7 on an unnamed "user-branch" channel (doctor warns: unknown upstream) | works; to silence: install Flutter from the official `stable` channel (optional) |
| Android SDK | `~/Library/Android/sdk` with build-tools, platforms 28/30/31/33, emulator, NDK; **licenses not accepted**; **no emulator system image** | accept licenses; install one `x86_64` system image for emulator tests |
| Xcode | **Command Line Tools only (`xcodebuild` unavailable)** | iOS target T4 is blocked until full Xcode is installed (B-iOS) |
| Java | present (`/usr/bin/java`) | ok |

## A. Software installations on a macOS build host (B-iOS, B-Android, B-SIGN) — STAGING (targets T3 and T4)
Use a **dedicated standard (non-admin) macOS user** for builds of AI-generated projects, with no access to your documents, SSH keys, cloud credentials or browser profiles. Generated project code is built there only.
1. Create the build user (System Settings > Users & Groups, or `sudo sysadminctl -addUser nuzmbuild -fullName "Nuzm Build" -password -` which prompts for the password; do not make it an administrator).
2. **Xcode (full).** Install from the Mac App Store or developer.apple.com/xcode, choosing a release that supports macOS 13 (Apple's system-requirements page lists the newest compatible one; **verify there**: engineering has not verified which release is the last for 13.7.8). Then, as an administrator:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   xcodebuild -runFirstLaunch
   xcodebuild -version
   xcrun simctl list runtimes
   ```
   If no simulator runtime is listed: Xcode > Settings > Components (or `xcodebuild -downloadPlatform iOS`) and install one. CocoaPods: `brew install cocoapods` (or `sudo gem install cocoapods`), then `pod --version`.
3. **Flutter doctor** (as the build user): `flutter doctor -v` and fix what it names for iOS.
4. **Android:** accept the SDK licenses `flutter doctor --android-licenses` (answer `y`; this is your acceptance of Google's SDK licenses, done by you), then install one emulator image (Intel): `~/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager "system-images;android-34;google_apis;x86_64"` (check available names with `sdkmanager --list`; engineering has not verified the exact package name for your SDK).
5. **Test signing key (B-SIGN):** nothing to do now. The build environment generates a throwaway debug keystore itself; **never** supply a production or store key. If a keystore is ever created by you: `keytool -genkeypair -v -keystore ~/nuzm-test.keystore -alias nuzmtest -keyalg RSA -keysize 2048 -validity 3650` and keep it outside the repository.
6. **No Apple Developer account is needed** for the iOS target T4 (`flutter build ios --no-codesign` and simulator builds). Do not create one for this phase.
**Validate (read-only):** `sw_vers -productVersion; uname -m; xcodebuild -version; xcrun simctl list runtimes | head; pod --version; flutter doctor -v | head -40; ls ~/Library/Android/sdk/system-images; ~/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager --list_installed | head`. PASS when `xcodebuild -version` prints a version and `flutter doctor` shows no red mark for Xcode and Android licenses. **Cost:** Xcode and SDKs are free; download size is several GB. **Security/legal:** you accept Apple's and Google's licenses yourself; the build user must stay isolated (B-Android).

## B. Accounts and credentials
| # | What | Where / exact action | Secret handling | Validate (read-only) | Cost | Needed for |
|---|---|---|---|---|---|---|
| B1 | Anthropic workspace, key, spend cap (D4) | Vendor Console: create a **dedicated non-production workspace**; set its **monthly limit USD 5**; create **one key inside it** | Type the key **only** into the Nuzm admin console (AI > Model providers > Claude > key field > Save). Never paste it elsewhere | Admin console shows `vault://dev/ai-claude`, provider disabled; the Vendor Console shows the limit | cap = worst case; verification at most **USD 0.314960** | provider tracks A–C |
| B2 | Agreement and data terms (D2), region/ROPA (D5), rate card (D6) | Review and accept the agreement yourself (legal first); then admin console `Attest terms`, region statement, rate card (`pnpm --filter @nuzm/api rate-card:preview` computes the card from your inputs) | references only | admin console shows terms attested + reference | none | provider |
| B3 | Hosting staging node account (HG-05) | Create the account at the provider you choose (D-52 on `main` names Alibaba Riyadh `me-central-1` and Contabo EU as candidates) with a **billing alert / hard cap** | provider console only | provider invoice/cap visible | Contabo planning figure about **EUR 4.40–4.50 per month** (12-month term; two pages disagree on the plan name); Alibaba Riyadh price **not found**: you fill in `per month × days` | staging deployment (T1, T6) |
| B4 | Hosting panel access key (HG-06) | Install HestiaCP on that node, create an access key limited to the allow-listed command profile | Type it once into the admin console (write-only, sealed in the vault) | admin console shows a vault reference; `curl -sk https://<node>:<panel-port>/ -o /dev/null -w '%{http_code}'` returns an HTTP code | panel is free | staging deployment |
| B5 | Domain and DNS API (B-DOMAIN) | A preview domain that is **not** under the console or API domain; a DNS API token for the ACME client **given to the node, not to platform code** | node only | `dig +short NS <preview-domain>` | domain registration (owner-priced) | preview URLs with SSL |
| B6 | Runtime node account (D-21) | A provider account that can rent a **dedicated bare-metal Linux server** | provider console only | provider console | see C1 | real isolated execution |

## C. Servers
| # | Server | Specification (from `docs/parallel/sessions/PHASE2-04-approval-inputs.md` §6.1, engineering estimates) | Indicative cost | Needed for |
|---|---|---|---|---|
| C1 | **Runtime node** (dedicated, one workload only) | bare metal preferred (gives `/dev/kvm`); 4+ physical cores / 8+ threads; 32 GB RAM; 2 × 500 GB NVMe; a current LTS Linux with a pinned recent LTS kernel (6.1+), cgroup v2, no swap, SSH keys only from one operator IP, host firewall default-deny; ability to reinstall between qualifications | month-to-month dedicated server **about EUR 45–100 per month plus about EUR 39 setup** (third-party-sourced, indicative); a short hourly bare-metal run about **USD 300–500**; **do not buy before D-21 and the budget are approved** | targets D, E, T2, T3 in the isolated runtime |
| C2 | Egress proxy + npm/pub registry mirror (small) | one small VM (or a separate namespace on C1, reviewer's call) | a few EUR/USD per month, not sourced | dependency installs under `registry-only` |
| C3 | Hosting staging node | the smallest node the provider sells that runs HestiaCP; **non-production, throw-away, synthetic content only**, region per residency (D-52) | per B3 | T1, T6 |
**Validate (read-only, run from your machine after the server exists):** `ssh -o BatchMode=yes <user>@<node> 'uname -r; nproc; free -g; lsblk; stat -fc %T /sys/fs/cgroup/; ls -l /dev/kvm'` (PASS: kernel ≥ 6.1, `cgroup2fs`, `/dev/kvm` present if Firecracker is wanted). The bootstrap script `docs/security/sandbox/bootstrap/` is **reviewed by a human before any use** and its `--apply` refuses without sign-off.

## D. DNS records (placeholders in angle brackets; use your real names)
| Record | Purpose | When |
|---|---|---|
| `A <node-ip>` for `<preview-domain>` and `*.<preview-domain>` (wildcard) | temporary preview subdomains on the isolated origin (ADR-060) | before real preview |
| `A <staging-host>` → hosting node IP | the node's panel/host name | before HestiaCP |
| `CAA 0 issue "letsencrypt.org"` on `<preview-domain>` (optional) | restricts issuance | optional |
| `_acme-challenge.<preview-domain>` handled by the node's ACME client via your DNS API token | wildcard certificate (DNS-01) | when issuing |
**Validate:** `dig +short A <preview-domain>; dig +short A test.<preview-domain>; dig +short CAA <preview-domain>` and, after issuance, `echo | openssl s_client -connect test.<preview-domain>:443 -servername test.<preview-domain> 2>/dev/null | openssl x509 -noout -subject -dates`.

## E. Environment variables (set in the API process of **one named non-production environment only**; never production; never committed)
| Variable | Value | Set when |
|---|---|---|
| `AI_LIVE_PROVIDERS` | `claude` | last step of the provider path (D3), after D2, D4, D5, D6 |
| `AI_PROBE_APPROVALS` | one JSON line `[{"ref":"<D9 ref>","approvedBy":"<your name>","environment":"non-production","maxRequests":13,"maxTotalTokens":14716}]` | with D9 |
| `SESSION_SEAL_KEY` | a random key you generate yourself (`openssl rand -base64 32`), kept in your own shell/secret store | to read the sealed non-production vault |
| `NUZM_QUALIFICATION_APPROVED` | your approval reference, only when a runtime qualification run is authorized | with D-21/HG-10-02 |
| `MOBILE_FLUTTER_LOCAL` | `1`, only for the Flutter local tests in the isolated build environment | when B-Android is approved |
Files kept **outside the repository** (e.g. `~/nuzm-live/`): `approval.json`, `evidence.json` (formats in `docs/parallel/LIVE-PROVIDER-PLAN.md` §9.1), mode 0600.

## F. Expected external costs (all upper bounds or indicative; nothing is purchased by engineering)
| Item | Cost | Source / caveat |
|---|---|---|
| First real provider verification, all live steps | **at most USD 0.314960** (0.234240 without the redundant probe) | `LIVE-PROVIDER-PLAN.md` §9, list price read 2026-11-24 |
| Benchmark Stage A / B / C (Opus 5.5, one model) | **max $4.40 / $23.60 / $83.60** | `PHASE2-03-approval-inputs.md`; programme max **$872.40** |
| Runtime node (qualification) | **EUR 50–150 first month** or **USD 300–500** short hourly | `PHASE2-04-approval-inputs.md` §6.2, indicative, third-party |
| Hosting staging node | Contabo about **EUR 4.40–4.50/month** (12-month term); Alibaba Riyadh not found | `STAGING-DEPLOYMENT-PLAN.md` |
| Domain, DNS | owner-priced | — |
| Xcode, Flutter, Android SDK, CocoaPods | free | — |
| Reviewer time (isolation review, benchmark reviewers) | owner's | — |

## G. Security and legal approvals (recorded in `OWNER-APPROVAL-PACK.md` §6 with a reference; engineering never records them for you)
Agreement and data terms (D2); region/ROPA statement (D5); residency for customer data (D1, only for customer content); rate card/VAT (D6); live gate (D3); probe (D9); isolation technology (D-21); isolation review by a named independent reviewer (HG-10-02); Execution Gateway ADR acceptance (ADR-067 on this line, ADR-069 after the join); LEGAL-EXEC for customer-visible execution; hosting join authorization (HOST-JOIN); HOST-TRANSPORT owner; benchmark thresholds, budget, reviewers (AC-AG-10, BUD, REV, SEC-AG); policies O-1, O-2, O-9, BILL-SEP; production rollout (D-AG-ROLLOUT). Paid API calls, real infrastructure provisioning, customer-data processing and untrusted-code execution stay refused until the matching row is recorded.

## H. One validation pass (read-only; nothing is changed or billed)
Run from the repository root of any Phase 3 worktree once available: P3-S08 maintains `docs/phase3/validate/` (one script per prerequisite above, each prints PASS/FAIL and the exact missing item). Until it exists, use the per-section commands above.
