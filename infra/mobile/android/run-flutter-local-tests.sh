#!/usr/bin/env bash
# Reproducible run of the two Flutter local tests (apps/api/src/modules/mobile/flutter-local.int.spec.ts, MOBILE_FLUTTER_LOCAL=1):
#   1. the rendered template passes `flutter pub get`, `flutter analyze`, `flutter test`;
#   2. the Android runner builds an unsigned debug APK and the resolved pubspec.lock passes the pub policy.
# Cost: ~6 minutes on a quiet machine (M10B measured 345 s), 15-25 min under load; needs pub.dev/Maven network (or the mirror variables) and ~3 GB of disk. HEAVY: it takes the heavy lock
# through the shared scheduler (heavy-slot.sh, weight 2); run it only when the Master allows. NUZM_LOCAL_DEV_EXEC=1 is the template-origin host-exec opt-in of the P3-S02 guard (first-party template only, never generated code).
#
#   infra/mobile/android/run-flutter-local-tests.sh [evidence-dir]
#
# Inside a declared disposable environment (NUZM_BUILD_ENV=disposable) the build test uses DisposableAndroidRunner; otherwise it is the labelled LOCAL runner on the TEMPLATE project
# (first-party code, no AI-generated code) exactly as in M10B. Output: evidence JSON with toolchain versions, test results and the APK hash. Never signs, never uploads.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
EVID="${1:-$ROOT/docs/mobile/evidence}"; mkdir -p "$EVID"
# Heavy: goes through the machine-wide weighted scheduler (2 slots, FIFO, waits under memory pressure). Override the path with HEAVY_SLOT_SH; without it the run is refused.
HEAVY_SLOT_SH="${HEAVY_SLOT_SH:-/Users/elaf/Projects/nuzm/.claude/worktrees/ai-integration/scripts/heavy-slot.sh}"
[ -x "$HEAVY_SLOT_SH" ] || { echo "heavy-slot.sh not found at $HEAVY_SLOT_SH: not starting a heavy run without the scheduler" >&2; exit 4; }

# toolchain: take what flutter itself is configured with; fail early and by name when something is missing
command -v flutter >/dev/null || { echo "flutter not on PATH" >&2; exit 2; }
FV="$(flutter --version --machine | sed -n 's/.*"frameworkVersion": *"\([^"]*\)".*/\1/p' | head -1)"
PIN="$(sed -n 's/^FLUTTER_VERSION=//p' "$ROOT/infra/mobile/android/toolchain.env")"
[ "$FV" = "$PIN" ] || { echo "Flutter $FV is not the pinned $PIN: refusing" >&2; exit 2; }
if [ -z "${JAVA_HOME:-}" ]; then JD="$(flutter config --list 2>/dev/null | sed -n 's/^ *jdk-dir: *//p' | head -1)"; [ -n "$JD" ] && export JAVA_HOME="$JD"; fi
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -x "${JAVA_HOME:-/nonexistent}/bin/java" ] || { echo "no JDK: set JAVA_HOME (JDK 17) or flutter config --jdk-dir" >&2; exit 2; }
[ -d "$ANDROID_HOME/platforms" ] || { echo "Android SDK not found at $ANDROID_HOME" >&2; exit 2; }
# read-only licence probe (never answers a licence prompt): `flutter doctor` prints "Some Android licenses not accepted" when they are not
if flutter doctor 2>&1 | grep -qi "licenses not accepted"; then
  echo "NOTE: Android SDK licences are not all accepted in this environment. The build will fail with gradle_licence_not_accepted until the owner accepts them (B-Android)." >&2
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; LOG="$EVID/$STAMP-flutter-local.log"
cd "$ROOT"
set +e
MOBILE_FLUTTER_LOCAL=1 NUZM_LOCAL_DEV_EXEC=1 "$HEAVY_SLOT_SH" --weight 2 pnpm --filter @nuzm/api exec vitest run --config vitest.integration.config.mts src/modules/mobile/flutter-local.int.spec.ts --reporter=verbose 2>&1 | tee "$LOG"
RC=${PIPESTATUS[0]}
set -e
APKLINE="$(grep -E 'ANDROID-DEBUG apk=' "$LOG" | tail -1 || true)"
python3 - "$EVID/$STAMP-flutter-local.json" "$RC" "$FV" "${JAVA_HOME:-}" "$(sw_vers -productVersion 2>/dev/null || uname -r)" "${NUZM_BUILD_ENV:-not-declared}" "$APKLINE" <<'PY'
import json,sys,datetime,os
out,rc,fv,java,osv,env,apk=sys.argv[1:8]
d={"recordedAt":datetime.datetime.now(datetime.timezone.utc).isoformat()+"Z","command":"MOBILE_FLUTTER_LOCAL=1 vitest run flutter-local.int.spec.ts","exitCode":int(rc),
   "result":"PASS" if rc=="0" else "FAIL","flutter":fv,"javaHomeName":os.path.basename(os.path.dirname(os.path.dirname(java))) if java else "","host":osv,
   "buildEnvironment":env,"label":"LIVE-VERIFIED (template project, "+("disposable environment" if env=="disposable" else "owner's Mac, labelled local, NOT isolated")+")" if rc=="0" else "FAIL",
   "apkLine":apk}
json.dump(d,open(out,"w"),indent=2); open(out,"a").write("\n")
print("evidence:",out)
PY
exit $RC
