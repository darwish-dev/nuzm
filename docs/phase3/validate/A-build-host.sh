#!/usr/bin/env bash
# Checklist section A: software on the macOS build host (B-iOS, B-Android, B-SIGN). READ-ONLY (see lib.sh).
#   A-build-host.sh [--build-user nuzmbuild] [--strict]
# Run it on the Mac, as the user that will build (or as yourself; --build-user also checks that dedicated user exists and is not an administrator).
. "$(dirname "$0")/lib.sh"
has_flag --strict "$@" && STRICT=1
BUILD_USER="$(opt_value --build-user "$@")"

if [ "$(uname -s)" != "Darwin" ]; then
  fail A0 "this is not macOS" "run on the macOS build host"
  summary "A build host"; exit $?
fi
pass A0 "macOS $(sw_vers -productVersion), $(uname -m)"

# A1 build user (dedicated, non-admin)
if [ -z "$BUILD_USER" ]; then
  skip A1 "dedicated build user" "pass --build-user <name> (checklist A.1: a standard, non-admin user)"
elif id "$BUILD_USER" >/dev/null 2>&1; then
  if dseditgroup -o checkmember -m "$BUILD_USER" admin 2>/dev/null | grep -q '^yes'; then
    fail A1 "build user $BUILD_USER exists but IS an administrator" "make it a standard user (System Settings > Users & Groups)"
  else
    pass A1 "build user $BUILD_USER exists and is not an administrator"
  fi
else
  fail A1 "build user $BUILD_USER does not exist" "create it as a standard (non-admin) user"
fi

# A2 full Xcode (not only Command Line Tools)
DEV_DIR="$(xcode-select -p 2>/dev/null || true)"
if have xcodebuild && XB="$(xcodebuild -version 2>&1)" && printf '%s' "$XB" | grep -q '^Xcode '; then
  pass A2 "xcodebuild: $(printf '%s' "$XB" | head -1) (developer dir ${DEV_DIR:-unset})"
else
  fail A2 "full Xcode is not usable (xcodebuild -version fails; developer dir is ${DEV_DIR:-unset})" "install full Xcode (B-iOS), then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer; sudo xcodebuild -license accept; xcodebuild -runFirstLaunch"
fi
# A3 simulator runtime
if have xcrun && xcrun simctl list runtimes 2>/dev/null | grep -qi 'iOS'; then
  pass A3 "an iOS simulator runtime is installed ($(xcrun simctl list runtimes 2>/dev/null | grep -i 'iOS' | head -1 | sed 's/ - .*//'))"
else
  fail A3 "no iOS simulator runtime listed" "Xcode > Settings > Components, or: xcodebuild -downloadPlatform iOS"
fi
# A4 CocoaPods
if have pod && PV="$(pod --version 2>/dev/null)"; then pass A4 "CocoaPods $PV"; else fail A4 "CocoaPods is not installed" "brew install cocoapods  (or: sudo gem install cocoapods)"; fi
# A5 Flutter
LIC_BAD=0
if have flutter; then
  FV="$(flutter --no-version-check --version 2>/dev/null | head -1)"
  [ -n "$FV" ] && pass A5 "$FV" || fail A5 "flutter does not run" "reinstall Flutter"
  DOC="$(bounded 180 flutter --no-version-check doctor 2>&1 || true)"
  printf '%s' "$DOC" | grep -qi 'licenses not accepted' && LIC_BAD=1
  if ! printf '%s' "$DOC" | grep -Eq '^\[(✓|!|✗)\]'; then
    # no report at all (timeout, startup lock held by another flutter command): an empty answer is never a PASS
    fail A6 "flutter doctor produced no report (timed out, or another flutter command holds its lock)" "run: flutter doctor -v   and re-run this script when nothing else uses flutter"
  elif printf '%s' "$DOC" | grep -Eq '^\[(✗|!)\].*(Xcode|Android toolchain)'; then
    printf '%s\n' "$DOC" | grep -E '^\[(✗|!)\].*(Xcode|Android toolchain)' | while IFS= read -r l; do printf 'FAIL   %-8s %s  -> %s\n' A6 "flutter doctor: $l" "fix with: flutter doctor -v"; done
    P3_FAIL=$((P3_FAIL+1))
  else
    pass A6 "flutter doctor shows no red or warning mark for Xcode or the Android toolchain"
  fi
else
  fail A5 "flutter is not on PATH" "install Flutter (stable channel) and add it to PATH"
fi
# A7 Java
if have java && JV="$(java -version 2>&1 | head -1)" && ! printf '%s' "$JV" | grep -qi 'unable to locate'; then pass A7 "java: $JV"; else fail A7 "no working Java" "install a JDK (17+ for current Android Gradle plugins)"; fi
# A8 Android SDK location, licences, an emulator system image
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [ -d "$SDK" ]; then pass A8 "Android SDK at $SDK"; else fail A8 "Android SDK not found at $SDK" "install the Android SDK or set ANDROID_HOME"; fi
if [ "$LIC_BAD" -eq 1 ]; then fail A9 "flutter doctor reports that some Android SDK licences are not accepted" "you accept them yourself: flutter doctor --android-licenses"
elif [ -s "$SDK/licenses/android-sdk-license" ]; then pass A9 "no 'licences not accepted' in flutter doctor and the licence file is present"
else fail A9 "Android SDK licences are not accepted" "you accept them yourself: flutter doctor --android-licenses"; fi
if ls "$SDK"/system-images/*/*/x86_64 >/dev/null 2>&1; then pass A10 "an x86_64 emulator system image is installed ($(ls -d "$SDK"/system-images/* | head -1 | xargs basename))"; else fail A10 "no x86_64 emulator system image under $SDK/system-images" "sdkmanager \"system-images;android-34;google_apis;x86_64\" (check the name with sdkmanager --list)"; fi
# A11 no production signing material in the repository checkout (tracked or untracked, not ignored)
if have git && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 && git -C "$REPO_ROOT" ls-files -co --exclude-standard | grep -Eqi '\.(keystore|jks|p12|mobileprovision)$'; then
  fail A11 "a signing file (keystore, jks, p12, mobileprovision) exists inside the repository checkout" "move it outside the repository; engineering never receives production keys (B-SIGN)"
else
  pass A11 "no keystore, p12 or provisioning profile inside the repository checkout"
fi
summary "A build host"; exit $?
