# Node bootstrap artifacts (reviewed, NEVER executed)

| File | What it is |
|---|---|
| [node-bootstrap.sh](node-bootstrap.sh) | prepares one dedicated Ubuntu LTS staging node for **gVisor (runsc, systrap)**: guards, minimal packages, host baseline (swap off, sysctls, user, XFS-prjquota workspace check), pinned and checksummed runsc, containerd runtime handler, default-deny nftables ruleset, audit rules, node identity file. **Default mode is `--plan` (prints only).** |
| [node-inventory.sh](node-inventory.sh) | read-only facts about the node for the evidence directory |

Status: these are **reviewed artifacts, not tested**. They were written offline; they have been syntax-checked with `bash -n` only. No command in them was ever run on any machine. Every line marked `(V)` must be verified by the reviewer against the pinned release and the real distribution before the first run.

Rules of use (see RUNTIME-QUALIFICATION §Staging qualification plan):
1. Only on a **dedicated, disposable, non-production Linux node** provided by the owner (never a developer machine, never a shared host, never a node with data or credentials).
2. First read `bash node-bootstrap.sh --plan` output with the reviewer; sign off a specific version of the file (a git commit) as `NUZM_BOOTSTRAP_REVIEW_REF`.
3. `--apply` needs the pinned runsc version and both sha512 values from the reviewer's own verification of the release; the script refuses without them and refuses a node that is not clean and dedicated.
4. Revision 2 (P3-S02): the node agent now exists (`packages/runtime-agent`) and is installed by `infra/runtime/install-agent.sh` (plan-first, never executed, its own reviewer sign-off); this script still neither installs nor starts it, and no longer writes the firewall (the static ruleset is `infra/runtime/nftables/nuzm-node.nft`). A **Firecracker** variant is a separate reviewed file (KVM, `jailer`, signed guest kernel and rootfs) written only if the reviewer chooses that class after the gVisor results.
5. Keep the `--plan` text, the commit hash of these files and the inventory output as evidence.
