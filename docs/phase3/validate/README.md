# Owner setup validation (P3-S08)

One read-only script per section of [`../OWNER-SETUP-CHECKLIST.md`](../OWNER-SETUP-CHECKLIST.md). Run them from anywhere inside the repository; none of them changes anything, installs anything, accepts a licence, creates an account or key, calls a paid or metered API, or contacts a model provider. Nothing is ever printed that could be a secret (variables are reported as "set" with a length, never their value). Anything that reaches another machine (ssh, one HTTPS HEAD request, DNS, one TLS handshake) happens **only against a host you pass as an argument**; there are no defaults.

Every check prints one line: `PASS` (proven by the command's own output), `FAIL` (checked; the line names the exact missing item and the fix), `MANUAL` (cannot be proven read-only from here, for example a vendor console; the line says exactly where to look; never counted as PASS) or `SKIP` (not checked because you did not pass the host or option it needs; the line names the option). Exit status 0 when nothing FAILED; with `--strict` also 1 when anything was MANUAL or SKIP (i.e. not proven).

| Checklist section | Script | Options | What it proves |
|---|---|---|---|
| 0 / A Software on the macOS build host (B-iOS, B-Android, B-SIGN) | [`A-build-host.sh`](A-build-host.sh) | `--build-user <name>` | macOS/CPU, dedicated non-admin build user, full Xcode (`xcodebuild -version`), an iOS simulator runtime, CocoaPods, `flutter doctor` without Xcode/Android marks, Java, Android SDK, accepted licences (file present), an x86_64 emulator image, no keystore/p12/provisioning profile inside the repository |
| B Accounts and credentials (B1–B6) | [`B-accounts.sh`](B-accounts.sh) | `--panel https://<node>:<port>` | B4 panel answers (one HEAD request to your node, status code only); repository secret scan clean; B1, B2, B3, B5, B6 are vendor-console facts: `MANUAL` with the exact place to look |
| C Servers (C1 runtime node, C3 hosting node) | [`C-servers.sh`](C-servers.sh) | `--runtime-node user@host`, `--hosting-node user@host` | one fixed read-only command set over `ssh -o BatchMode=yes`: kernel ≥ 6.1, ≥ 8 threads, ≥ 32 GB, cgroup v2, `/dev/kvm`, no swap; HestiaCP present |
| D DNS records and TLS | [`D-dns.sh`](D-dns.sh) | `--preview-domain D`, `--expect-ip IP`, `--console-domain D`, `--tls HOST` | A and wildcard records, optional CAA, the preview domain is not the console domain or a subdomain of it (ADR-060), a verifying certificate after issuance |
| E Environment variables | [`E-environment.sh`](E-environment.sh) | `--expect live-provider,runtime,mobile`, `--files-dir DIR` | variables of the current shell: set / shape / caps (D9 plan), never the value; not production; no provider key exported; `approval.json`/`evidence.json` outside the repository with mode 600. An unset variable is `SKIP` unless you say that step is due (`--expect`), then `FAIL` |
| F Costs | none | | informational; nothing to validate |
| G Security and legal approvals | [`G-approvals.sh`](G-approvals.sh) | `--target T1..T6\|X` | each approval id has a row with a reference in `docs/parallel/OWNER-APPROVAL-PACK.md` section 6 (a blank reference is undecided); only reads that file |
| H Evidence state | [`H-evidence.sh`](H-evidence.sh) | | every committed evidence record verifies; the acceptance target rows (T1..T6) PASS or the exact blocker |
| all | [`run-all.sh`](run-all.sh) | all of the above | runs every section with the options you give |

```bash
docs/phase3/validate/run-all.sh --build-user nuzmbuild --preview-domain preview.example.test --console-domain console.example.test
docs/phase3/validate/E-environment.sh --expect live-provider      # before the provider verification
docs/phase3/validate/G-approvals.sh --target T3                   # what T3 still needs from you
```

Safety net: `apps/api/src/qa/validate-scripts.spec.ts` (runs in `pnpm test`) lints these scripts for mutating commands and runs the environment, server, DNS and approvals scripts with controlled inputs to prove the PASS/FAIL logic and that no secret value is printed.
