#!/usr/bin/env bash
# =====================================================================================================================================================================
# NUZM ANDROID BUILD ENVIRONMENT (toolchain layer)                 STATUS: REVIEWED ARTIFACT. NEVER EXECUTED. NOT TESTED ON ANY MACHINE.
# Builds the read-only toolchain directory (JDK, Android SDK, Flutter, Gradle distribution) and the offline caches for the Android profile on a Linux BUILD HOST that has network
# access and holds no secrets (not the runtime node, never a developer Mac). The result is mounted read-only into sandboxes; the sandbox itself has no direct network.
#   --plan (default) prints; --apply needs Linux and:
#   NUZM_ANDROID_REVIEW_REF, NUZM_OUT_DIR (empty/absent), and the four pins from android-build-env.json (NUZM_JDK_URL/SHA256, NUZM_CMDLINE_TOOLS_URL/SHA256, NUZM_FLUTTER_URL/SHA256,
#   NUZM_GRADLE_URL/SHA256), plus NUZM_ANDROID_LICENSE_ACCEPTED_BY="<full name of the human who read and accepted the Android SDK licences>".
# The licence acceptance is a LEGAL act: this script refuses to run `sdkmanager --licenses` without it and never answers the prompts itself on anyone's behalf by default.
# =====================================================================================================================================================================
set -euo pipefail
IFS=$'\n\t'
MODE="plan"; case "${1:-}" in --plan | "") MODE="plan" ;; --apply) MODE="apply" ;; *) echo "usage: $0 [--plan|--apply]" >&2; exit 2 ;; esac
say() { printf '%s\n' "$*"; }
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }
step() { local d="$1"; shift; say "==> ${d}"; say "    \$ $(IFS=' '; echo "$*")"; if [ "${MODE}" = "apply" ]; then "$@"; fi; }
OUT="${NUZM_OUT_DIR:-/var/tmp/nuzm-android-out}"
fetch() { # <url> <sha256> <dest>: download, verify BEFORE use; a mismatch is a supply-chain incident
  step "download $(basename "$3") and verify its sha256" bash -c "curl -fsSL --proto '=https' --tlsv1.2 -o '$3' '$1' && echo '$2  $3' | sha256sum -c -"
}
preflight() {
  if [ "${MODE}" = "plan" ]; then say "== preflight (plan): Linux build host; all pins and the licence acceptor named; empty output directory"; return 0; fi
  [ "$(uname -s)" = "Linux" ] || die "not Linux: never build the environment on a developer Mac"
  local v; for v in NUZM_ANDROID_REVIEW_REF NUZM_JDK_URL NUZM_JDK_SHA256 NUZM_CMDLINE_TOOLS_URL NUZM_CMDLINE_TOOLS_SHA256 NUZM_FLUTTER_URL NUZM_FLUTTER_SHA256 NUZM_GRADLE_URL NUZM_GRADLE_SHA256 NUZM_ANDROID_LICENSE_ACCEPTED_BY; do [ -n "${!v:-}" ] || die "missing ${v}"; done
  for v in NUZM_JDK_SHA256 NUZM_CMDLINE_TOOLS_SHA256 NUZM_FLUTTER_SHA256 NUZM_GRADLE_SHA256; do [[ "${!v}" =~ ^[0-9a-f]{64}$ ]] || die "${v} is not a sha256 hex digest"; done
  [ ${#NUZM_ANDROID_LICENSE_ACCEPTED_BY} -ge 3 ] || die "the Android SDK licence must be accepted by a named human"
  [ ! -e "${OUT}" ] || [ -z "$(ls -A "${OUT}" 2>/dev/null)" ] || die "NUZM_OUT_DIR is not empty"
}
build() {
  fetch "${NUZM_JDK_URL:-JDK_URL}" "${NUZM_JDK_SHA256:-0}" "${OUT}/jdk.tar.gz"
  fetch "${NUZM_CMDLINE_TOOLS_URL:-TOOLS_URL}" "${NUZM_CMDLINE_TOOLS_SHA256:-0}" "${OUT}/cmdline-tools.zip"
  fetch "${NUZM_FLUTTER_URL:-FLUTTER_URL}" "${NUZM_FLUTTER_SHA256:-0}" "${OUT}/flutter.tar.xz"
  fetch "${NUZM_GRADLE_URL:-GRADLE_URL}" "${NUZM_GRADLE_SHA256:-0}" "${OUT}/gradle.zip"
  step "unpack into the toolchain tree" bash -c "cd '${OUT}' && mkdir -p tc/jdk tc/sdk/cmdline-tools tc/flutter tc/gradle && tar -xzf jdk.tar.gz -C tc/jdk --strip-components=1 && unzip -q cmdline-tools.zip -d tc/sdk/cmdline-tools && mv tc/sdk/cmdline-tools/cmdline-tools tc/sdk/cmdline-tools/latest && tar -xJf flutter.tar.xz -C tc/flutter --strip-components=1 && unzip -q gradle.zip -d tc/gradle"
  step "the Android SDK licences, accepted by the named human (this line records, it does not decide)" \
    bash -c "echo 'licences accepted by: ${NUZM_ANDROID_LICENSE_ACCEPTED_BY:-?} (review ${NUZM_ANDROID_REVIEW_REF:-?})' > '${OUT}/tc/LICENSE-ACCEPTANCE.txt' && yes | JAVA_HOME='${OUT}/tc/jdk' '${OUT}/tc/sdk/cmdline-tools/latest/bin/sdkmanager' --sdk_root='${OUT}/tc/sdk' --licenses >/dev/null"
  step "install the pinned SDK components (V: the exact package ids come from android-build-env.json)" \
    bash -c "JAVA_HOME='${OUT}/tc/jdk' '${OUT}/tc/sdk/cmdline-tools/latest/bin/sdkmanager' --sdk_root='${OUT}/tc/sdk' 'platform-tools' \"platforms;\${NUZM_ANDROID_PLATFORM:-android-34}\" \"build-tools;\${NUZM_ANDROID_BUILD_TOOLS:-34.0.0}\""
  say "==> offline caches (V): run the synthetic Flutter template once ON THIS BUILD HOST with network to fill ${OUT}/gradle-cache and ${OUT}/pub-cache, then freeze them (read-only, digest recorded). Nothing from a customer project is ever used to fill a cache."
  say "== next (manual): tree-digest of tc/ and the caches into the evidence; copy to the node's image directory; list in agent.json (mounts for the android profile come with CONTRACT-P3-S02-1)."
}
main() { say "NUZM Android build environment | mode=${MODE}"; preflight; build; }
main
