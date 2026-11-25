#!/usr/bin/env bash
# TEST-signing procedure (owner policy B-SIGN): sign an APK with a THROWAWAY keystore created for this one run, inside a disposable build environment.
#   infra/mobile/android/test-sign.sh in.apk out.apk
# - The keystore and its password exist only in a private temp directory and in a variable of this process; both are destroyed when the script ends. The password is never printed or logged.
# - There is deliberately NO option to supply an existing keystore, key alias or password: a production or store key cannot be passed in.
# - The output is a TEST signature (certificate subject "NUZM TEST ONLY - NOT FOR RELEASE"): it is not a release signature and it is never uploaded or submitted anywhere.
# Refuses outside a declared disposable environment (same rule as the build guard).
set -euo pipefail
[ "${NUZM_BUILD_ENV:-}" = "disposable" ] && [ -n "${NUZM_BUILD_USER:-}" ] && [ "$(id -un)" = "$NUZM_BUILD_USER" ] || { echo "refused: not a declared disposable build environment (NUZM_BUILD_ENV/NUZM_BUILD_USER)" >&2; exit 3; }
[ $# -eq 2 ] || { echo "usage: test-sign.sh <in.apk> <out.apk> (no other arguments exist)" >&2; exit 2; }
IN="$1"; OUT="$2"; [ -f "$IN" ] || { echo "no such file: $IN" >&2; exit 2; }
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"; [ -n "$SDK" ] || { echo "ANDROID_HOME is not set" >&2; exit 2; }
BT="$(ls -1 "$SDK/build-tools" | sort -V | tail -1)"; APKSIGNER="$SDK/build-tools/$BT/apksigner"; ZIPALIGN="$SDK/build-tools/$BT/zipalign"
WORK="$(mktemp -d)"; chmod 700 "$WORK"
cleanup() { [ -d "$WORK" ] && { rm -P "$WORK"/* 2>/dev/null || rm -f "$WORK"/*; rmdir "$WORK" 2>/dev/null || true; }; unset NUZM_TEST_KS_PASS; }
trap cleanup EXIT
NUZM_TEST_KS_PASS="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"; export NUZM_TEST_KS_PASS
keytool -genkeypair -keystore "$WORK/test.jks" -storetype PKCS12 -alias nuzmtest -keyalg RSA -keysize 3072 -validity 30 \
  -dname "CN=NUZM TEST ONLY - NOT FOR RELEASE, O=Nuzm test" -storepass:env NUZM_TEST_KS_PASS -keypass:env NUZM_TEST_KS_PASS >/dev/null 2>&1
"$ZIPALIGN" -f -p 4 "$IN" "$WORK/aligned.apk"
"$APKSIGNER" sign --ks "$WORK/test.jks" --ks-key-alias nuzmtest --ks-pass env:NUZM_TEST_KS_PASS --key-pass env:NUZM_TEST_KS_PASS --out "$OUT" "$WORK/aligned.apk"
"$APKSIGNER" verify --print-certs "$OUT" | sed -n 's/.*certificate SHA-256 digest: /test-signer-sha256: /p' | head -1
echo "signed with a throwaway TEST key (destroyed now): not a release signature"
