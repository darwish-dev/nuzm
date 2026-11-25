#!/usr/bin/env bash
# =====================================================================================================================================================================
# NUZM SANDBOX ROOTFS BUILD (P3-S02)                              STATUS: REVIEWED ARTIFACT. NEVER EXECUTED. NOT TESTED ON ANY MACHINE.
# Builds the read-only rootfs of the gVisor sandbox from the pinned recipe (recipe.json) on a Linux BUILD HOST (not the runtime node, never a developer Mac) and prints the image digest.
#   --plan (default)  prints every step and changes nothing
#   --apply           needs: Linux, root (mmdebstrap needs it or user namespaces), NUZM_ROOTFS_REVIEW_REF, NUZM_DEBIAN_SNAPSHOT, NUZM_DEBIAN_SUITE, NUZM_NODE_VERSION,
#                     NUZM_NODE_SHA256 (the reviewer's own verification of the release), NUZM_OUT_DIR (empty or absent), and infra/runtime/rootfs/toolchain/package-lock.json
# Every line marked (V) is verified by the reviewer against the real tools. Nothing here installs anything on a runtime node.
# =====================================================================================================================================================================
set -euo pipefail
IFS=$'\n\t'
MODE="plan"; case "${1:-}" in --plan | "") MODE="plan" ;; --apply) MODE="apply" ;; *) echo "usage: $0 [--plan|--apply]" >&2; exit 2 ;; esac
say() { printf '%s\n' "$*"; }
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }
step() { local d="$1"; shift; say "==> ${d}"; say "    \$ $(IFS=' '; echo "$*")"; if [ "${MODE}" = "apply" ]; then "$@"; fi; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${NUZM_OUT_DIR:-/var/tmp/nuzm-rootfs-out}"
ROOTFS="${OUT}/rootfs"
TOOL="${OUT}/toolchain"

preflight() {
  if [ "${MODE}" = "plan" ]; then
    say "== preflight (plan mode: described, not run)"
    say "   - uname -s = Linux; refuses on macOS or any non-Linux host; refuses a non-empty NUZM_OUT_DIR"
    say "   - NUZM_ROOTFS_REVIEW_REF, NUZM_DEBIAN_SNAPSHOT (YYYYMMDDTHHMMSSZ), NUZM_DEBIAN_SUITE, NUZM_NODE_VERSION, NUZM_NODE_SHA256 (64 hex) all set"
    say "   - ${HERE}/toolchain/package-lock.json exists (reviewed, committed)"
    return 0
  fi
  [ "$(uname -s)" = "Linux" ] || die "not Linux: the rootfs is built on a Linux build host only"
  local v; for v in NUZM_ROOTFS_REVIEW_REF NUZM_DEBIAN_SNAPSHOT NUZM_DEBIAN_SUITE NUZM_NODE_VERSION NUZM_NODE_SHA256; do [ -n "${!v:-}" ] || die "missing ${v}"; done
  [[ "${NUZM_NODE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || die "NUZM_NODE_SHA256 is not a sha256 hex digest"
  [[ "${NUZM_DEBIAN_SNAPSHOT}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "NUZM_DEBIAN_SNAPSHOT must look like 20260101T000000Z"
  [[ "${NUZM_NODE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "NUZM_NODE_VERSION must be x.y.z"
  [ -f "${HERE}/toolchain/package-lock.json" ] || die "toolchain/package-lock.json missing (generate on the build host, review, commit)"
  [ ! -e "${OUT}" ] || [ -z "$(ls -A "${OUT}" 2>/dev/null)" ] || die "NUZM_OUT_DIR is not empty: never reuse a build directory"
  command -v mmdebstrap >/dev/null || die "mmdebstrap not installed on this build host"
}

build_base() {
  local arch; arch="$(uname -m 2>/dev/null || echo x86_64)"
  step "base rootfs: minimal Debian from a pinned snapshot, only the recipe's packages (V: package names per suite)" \
    mmdebstrap --variant=minbase --include=libc6,libstdc++6,libgcc-s1,ca-certificates,dash,coreutils,tzdata \
      "${NUZM_DEBIAN_SUITE:-SUITE}" "${ROOTFS}" "deb http://snapshot.debian.org/archive/debian/${NUZM_DEBIAN_SNAPSHOT:-SNAPSHOT}/ ${NUZM_DEBIAN_SUITE:-SUITE} main"
  say "    (arch ${arch})"
  step "remove what a sandbox must not have: package manager state, docs, locales, setuid bits" \
    bash -c "rm -rf '${ROOTFS}'/var/lib/apt '${ROOTFS}'/var/cache '${ROOTFS}'/usr/share/doc '${ROOTFS}'/usr/share/man && find '${ROOTFS}' -xdev \\( -perm -4000 -o -perm -2000 \\) -exec chmod u-s,g-s {} +"
}
build_toolchain() {
  local arch tarball
  arch="$(uname -m 2>/dev/null || echo x86_64)"; case "${arch}" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
  tarball="node-v${NUZM_NODE_VERSION:-X}-linux-${arch}.tar.xz"
  step "download the pinned Node tarball and verify its sha256 BEFORE unpacking (a mismatch aborts: supply-chain incident)" \
    bash -c "mkdir -p '${TOOL}' && curl -fsSL --proto '=https' --tlsv1.2 -o '${TOOL}/${tarball}' 'https://nodejs.org/dist/v${NUZM_NODE_VERSION:-X}/${tarball}' && echo '${NUZM_NODE_SHA256:-0}  ${TOOL}/${tarball}' | sha256sum -c -"
  step "unpack Node into the toolchain directory (read-only at run time)" \
    bash -c "mkdir -p '${TOOL}/node' && tar -xJf '${TOOL}/${tarball}' -C '${TOOL}/node' --strip-components=1 && rm '${TOOL}/${tarball}'"
  step "install the pinned global packages from the reviewed lockfile only (no lifecycle scripts)" \
    bash -c "cd '${HERE}/toolchain' && '${TOOL}/node/bin/npm' ci --ignore-scripts --prefix '${TOOL}' --no-audit --no-fund"
}
wire() {
  step "links in /usr/local/bin, the sandbox user, the global npm config" \
    bash -c "install -d '${ROOTFS}/usr/local/bin' '${ROOTFS}/usr/local/etc' '${ROOTFS}/home/sandbox' \
      && ln -s /toolchain/node/bin/node '${ROOTFS}/usr/local/bin/node' && ln -s /toolchain/node/bin/npm '${ROOTFS}/usr/local/bin/npm' && ln -s /toolchain/node/bin/npx '${ROOTFS}/usr/local/bin/npx' \
      && ln -s /toolchain/node_modules/typescript/bin/tsc '${ROOTFS}/usr/local/bin/tsc' \
      && install -m 0644 '${HERE}/npmrc' '${ROOTFS}/usr/local/etc/npmrc' \
      && echo 'sandbox:x:10001:10001:sandbox:/home/sandbox:/usr/sbin/nologin' >> '${ROOTFS}/etc/passwd' && echo 'sandbox:x:10001:' >> '${ROOTFS}/etc/group'"
  step "mount points the OCI bundle binds over (work, scratch, toolchain)" bash -c "mkdir -p '${ROOTFS}/work' '${ROOTFS}/scratch' '${ROOTFS}/toolchain'"
}
digest() {
  step "the image digest (tree digest of the rootfs: what the attestation lists and the agent re-verifies at every start)" \
    node "${HERE}/../../../packages/runtime-agent/dist/tree-digest-cli.js" "${ROOTFS}"
  say "== next (manual): scan and SBOM the rootfs (V), record the digest and ${NUZM_ROOTFS_REVIEW_REF:-<review ref>} in the evidence, copy rootfs and toolchain to the node's image directory, list the digest in agent.json."
}
main() { say "NUZM sandbox rootfs build | mode=${MODE}"; preflight; build_base; build_toolchain; wire; digest; }
main
