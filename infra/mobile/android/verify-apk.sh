#!/usr/bin/env bash
# Verify a built APK (T3 evidence): hash, structure, manifest, permissions, signature, and - only when an emulator image exists - install and launch.
# Read-only on the APK. Never signs, never uploads, never needs a credential. Output: a human report on stdout and, with --json <file>, an evidence record.
#
#   infra/mobile/android/verify-apk.sh app-debug.apk [--json evidence.json] [--emulator <avd-name>] [--package <applicationId>]
#
# Without --emulator (or without an installed system image) the verification is STRUCTURAL ONLY and says so: the APK is never reported as "installable" on structure alone.
set -euo pipefail
APK="${1:?usage: verify-apk.sh <apk> [--json file] [--emulator avd] [--package id]}"; shift || true
JSON_OUT=""; AVD=""; PKG=""
while [ $# -gt 0 ]; do case "$1" in --json) JSON_OUT="$2"; shift 2;; --emulator) AVD="$2"; shift 2;; --package) PKG="$2"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
[ -f "$APK" ] || { echo "no such file: $APK" >&2; exit 2; }

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$SDK/emulator:$PATH"
BT="$(ls -1 "$SDK/build-tools" 2>/dev/null | sort -V | tail -1 || true)"
APKSIGNER="$SDK/build-tools/$BT/apksigner"
say() { printf '%s\n' "$*"; }
res() { RESULTS+=("$1=$2"); say "$1: $2"; }
RESULTS=()

SHA="$(shasum -a 256 "$APK" | awk '{print $1}')"; SIZE="$(wc -c < "$APK" | tr -d ' ')"
res sha256 "$SHA"; res bytes "$SIZE"
unzip -tq "$APK" >/dev/null 2>&1 && res zip_integrity OK || res zip_integrity FAIL

if command -v apkanalyzer >/dev/null 2>&1; then
  PKGID="$(apkanalyzer manifest application-id "$APK" 2>/dev/null || echo unknown)"; res application_id "$PKGID"
  res version_name "$(apkanalyzer manifest version-name "$APK" 2>/dev/null || echo unknown)"
  res min_sdk "$(apkanalyzer manifest min-sdk "$APK" 2>/dev/null || echo unknown)"
  res target_sdk "$(apkanalyzer manifest target-sdk "$APK" 2>/dev/null || echo unknown)"
  res permissions "$(apkanalyzer manifest permissions "$APK" 2>/dev/null | tr '\n' ' ' || echo unknown)"
  res debuggable "$(apkanalyzer manifest debuggable "$APK" 2>/dev/null || echo unknown)"
  [ -z "$PKG" ] && PKG="$PKGID"
else res apkanalyzer "MISSING (cmdline-tools not installed): manifest checks NOT RUN"; fi

if [ -x "$APKSIGNER" ]; then
  if OUT="$("$APKSIGNER" verify --print-certs "$APK" 2>&1)"; then res signature VERIFIED; res signer_sha256 "$(echo "$OUT" | sed -n 's/.*certificate SHA-256 digest: //p' | head -1)"
    echo "$OUT" | grep -qi "Android Debug" && res signer_kind "debug key (NOT a release signature)" || res signer_kind "non-debug signer (verify it is the throwaway test key, never a production key)"
  else res signature "NOT VERIFIED ($(echo "$OUT" | head -1))"; fi
else res apksigner "MISSING: signature NOT CHECKED"; fi

INSTALL="NOT RUN"
if [ -n "$AVD" ]; then
  if ! command -v adb >/dev/null 2>&1 || ! command -v emulator >/dev/null 2>&1; then INSTALL="NOT RUN (adb/emulator not installed)"
  elif ! emulator -list-avds 2>/dev/null | grep -qx "$AVD"; then INSTALL="NOT RUN (no AVD named $AVD; an emulator system image is not installed: sdkmanager --install '$(grep ANDROID_EMULATOR_IMAGE "$(dirname "$0")/toolchain.env" | cut -d'"' -f2)' needs licence acceptance and a download, owner action)"
  else
    LOG="$(mktemp -d)/emulator.log"
    emulator -avd "$AVD" -no-window -no-audio -no-snapshot -no-boot-anim -read-only >"$LOG" 2>&1 &
    EMU=$!; trap 'adb emu kill >/dev/null 2>&1 || true; kill $EMU >/dev/null 2>&1 || true' EXIT
    adb wait-for-device; for _ in $(seq 1 120); do [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break; sleep 2; done
    if adb install -r "$APK" 2>&1 | tail -1 | grep -q Success; then
      adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 6
      if adb shell pidof "$PKG" >/dev/null 2>&1; then INSTALL="OK: installed and launched (process alive after 6 s) on $AVD"; adb exec-out screencap -p > "${JSON_OUT:+${JSON_OUT%.json}}.launch.png" 2>/dev/null || true
      else INSTALL="FAIL: installed but the process is not running after launch"; fi
    else INSTALL="FAIL: adb install did not report Success"; fi
  fi
fi
res install_launch "$INSTALL"
case "$INSTALL" in OK*) CLAIM="installable (emulator evidence)";; *) CLAIM="structural check only: NOT claimed installable";; esac
say "RESULT: $CLAIM"
if [ -n "$JSON_OUT" ]; then
  python3 - "$JSON_OUT" "$CLAIM" "${RESULTS[@]}" <<'PY'
import json,sys
out,claim=sys.argv[1],sys.argv[2]
d={"claim":claim,"checkedAt":__import__("datetime").datetime.utcnow().isoformat()+"Z"}
for kv in sys.argv[3:]:
    k,_,v=kv.partition("="); d[k]=v
json.dump(d,open(out,"w"),indent=2); open(out,"a").write("\n")
PY
fi
