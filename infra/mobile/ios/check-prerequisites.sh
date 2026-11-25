#!/usr/bin/env bash
# Nuzm P3-S06 — iOS build prerequisite checker (T4 / B-iOS). READ-ONLY: it inspects the machine and prints what is missing.
# It installs nothing, accepts no licence, changes no setting, makes no network call, reads no credential, and never runs project code.
#
#   infra/mobile/ios/check-prerequisites.sh            # human report; exit 0 = ready for T4, 1 = something missing, 2 = not macOS
#   infra/mobile/ios/check-prerequisites.sh --json     # same facts as one JSON object (for evidence files)
#
# Status words follow CLAUDE.md §6: a check is OK / MISSING / WARN / UNKNOWN. T4 stays "NOT VERIFIED (B-iOS)" unless every REQUIRED check is OK.
set -u
JSON=0
[ "${1:-}" = "--json" ] && JSON=1
PINNED_FLUTTER="3.35.7"

if [ "$(uname -s)" != "Darwin" ]; then
  if [ "$JSON" = 1 ]; then echo '{"ready":false,"reason":"not macOS","checks":[]}'; else echo "not macOS: iOS builds need macOS with full Xcode"; fi
  exit 2
fi

NAMES=(); STATES=(); DETAILS=(); REQ=(); FIXES=()
add() { # name state required(1|0) detail fix
  NAMES+=("$1"); STATES+=("$2"); REQ+=("$3"); DETAILS+=("$4"); FIXES+=("${5:-}")
}
have() { command -v "$1" >/dev/null 2>&1; }
vergte() { # $1 >= $2 (dotted numeric)
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]
}

# 1. macOS version and architecture
MACOS="$(sw_vers -productVersion 2>/dev/null || echo unknown)"
ARCH="$(uname -m)"
add "macos" "OK" 1 "macOS $MACOS ($ARCH)" ""

# 2. active developer directory: must be a full Xcode.app, not the Command Line Tools
DEVDIR="$(xcode-select -p 2>/dev/null || echo none)"
case "$DEVDIR" in
  /Applications/Xcode*.app/*|*/Xcode*.app/*)
    add "xcode-select" "OK" 1 "active developer directory: $DEVDIR" "" ;;
  /Library/Developer/CommandLineTools)
    add "xcode-select" "MISSING" 1 "active developer directory is the Command Line Tools ($DEVDIR); there is no full Xcode" \
      "install Xcode (docs/mobile/ios-build-host.md step 2), then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" ;;
  *)
    add "xcode-select" "MISSING" 1 "no active developer directory ($DEVDIR)" "install Xcode, then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" ;;
esac

# 3. full Xcode present on disk (even if not selected)
XCODE_APP=""
for c in /Applications/Xcode.app /Applications/Xcode-*.app; do [ -d "$c" ] && XCODE_APP="$c" && break; done
if [ -n "$XCODE_APP" ]; then
  XV="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$XCODE_APP/Contents/Info.plist" 2>/dev/null || echo unknown)"
  add "xcode-app" "OK" 1 "$XCODE_APP (version $XV)" ""
  # Xcode 15.x is the last line that runs on macOS 13; 16+ needs macOS 14 (Apple's published requirement; confirm against the release notes of the version you install)
  MAJOR="${XV%%.*}"
  if [ "$MAJOR" -ge 16 ] 2>/dev/null && ! vergte "$MACOS" "14.0"; then
    add "xcode-vs-macos" "WARN" 0 "Xcode $XV may not run on macOS $MACOS (Xcode 16+ requires macOS 14 or later)" "install Xcode 15.x (the last major that supports macOS 13) from developer.apple.com/download/all"
  fi
else
  add "xcode-app" "MISSING" 1 "no /Applications/Xcode*.app" "install Xcode 15.x (macOS 13.x compatible); see docs/mobile/ios-build-host.md"
fi

# 4. xcodebuild really works (the /usr/bin stub exists even with Command Line Tools only, and then fails)
if have xcodebuild; then
  if XB="$(xcodebuild -version 2>&1)" && echo "$XB" | grep -q '^Xcode '; then
    add "xcodebuild" "OK" 1 "$(echo "$XB" | tr '\n' ' ')" ""
  else
    add "xcodebuild" "MISSING" 1 "xcodebuild is not usable: $(echo "$XB" | head -1)" "select a full Xcode with xcode-select -s"
  fi
else
  add "xcodebuild" "MISSING" 1 "xcodebuild not found" "install Xcode"
fi

# 5. licence accepted. `xcodebuild -checkFirstLaunchStatus` is read-only (exit 0 = first-launch tasks done)
if [ -n "$XCODE_APP" ] && have xcodebuild; then
  if xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
    add "xcode-license-first-launch" "OK" 1 "Xcode licence accepted and first-launch components installed" ""
  else
    add "xcode-license-first-launch" "MISSING" 1 "licence not accepted or first-launch components not installed" "sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch"
  fi
else
  add "xcode-license-first-launch" "UNKNOWN" 1 "cannot be checked without a working Xcode" "after installing Xcode: sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch"
fi

# 6. iOS simulator runtime and simctl
if have xcrun && xcrun --find simctl >/dev/null 2>&1; then
  RT="$(xcrun simctl list runtimes 2>/dev/null | grep -i '^iOS' | head -3 | tr '\n' ';')"
  if [ -n "$RT" ]; then add "simulator-runtime" "OK" 0 "iOS runtime(s): $RT" ""; else
    add "simulator-runtime" "MISSING" 0 "simctl works but no iOS simulator runtime is installed (only needed for the launch screenshot, not for the build)" "xcodebuild -downloadPlatform iOS (multi-GB download; owner action)"; fi
else
  add "simulator-runtime" "UNKNOWN" 0 "simctl not available (needs full Xcode)" "after installing Xcode: xcodebuild -downloadPlatform iOS"
fi

# 5b. CocoaPods (Flutter iOS plugins resolve through it)
if have pod; then
  add "cocoapods" "OK" 1 "CocoaPods $(pod --version 2>/dev/null)" ""
else
  add "cocoapods" "MISSING" 1 "CocoaPods (pod) not found" "install with Homebrew (brew install cocoapods) inside the dedicated build user; see docs/mobile/ios-build-host.md step 5"
fi

# 7. Flutter, the pinned version
if have flutter; then
  FV="$(flutter --version --machine 2>/dev/null | sed -n 's/.*"frameworkVersion": *"\([^"]*\)".*/\1/p' | head -1)"
  if [ "$FV" = "$PINNED_FLUTTER" ]; then add "flutter" "OK" 1 "Flutter $FV (the pinned version)" ""
  else add "flutter" "WARN" 1 "Flutter ${FV:-unknown}; the pinned toolchain is $PINNED_FLUTTER and the build refuses any other" "install Flutter $PINNED_FLUTTER in the build user's home"; fi
else
  add "flutter" "MISSING" 1 "flutter not on PATH" "install Flutter $PINNED_FLUTTER"
fi

# 8. build-host policy: a dedicated build user, not the owner's normal account. We only report the user NAME and whether it looks dedicated.
ME="$(id -un)"
if [ "${NUZM_BUILD_ENV:-}" = "disposable" ] && [ -n "${NUZM_BUILD_USER:-}" ] && [ "$ME" = "$NUZM_BUILD_USER" ]; then
  add "build-host-policy" "OK" 1 "running as the declared dedicated build user ($ME), NUZM_BUILD_ENV=disposable" ""
else
  add "build-host-policy" "WARN" 1 "not declared as a dedicated build user (user '$ME'; NUZM_BUILD_ENV and NUZM_BUILD_USER are not set to match). AI-generated code must never build as the owner's normal user" \
    "create a dedicated standard macOS user, log in as it, export NUZM_BUILD_ENV=disposable NUZM_BUILD_USER=<that user> (docs/mobile/ios-build-host.md step 1)"
fi

# 9. disk space (Xcode 15 + simulator runtime + Flutter caches)
FREE_GB="$(df -g / 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "$FREE_GB" ] && [ "$FREE_GB" -ge 60 ] 2>/dev/null; then add "disk" "OK" 0 "${FREE_GB} GB free on /" ""
else add "disk" "WARN" 0 "${FREE_GB:-unknown} GB free on /; budget about 60 GB for Xcode, one simulator runtime and caches" "free disk space"; fi

# ---- report
ready=1; missing_required=()
for i in "${!NAMES[@]}"; do
  if [ "${REQ[$i]}" = "1" ] && [ "${STATES[$i]}" != "OK" ]; then ready=0; missing_required+=("${NAMES[$i]}"); fi
done

esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
if [ "$JSON" = 1 ]; then
  printf '{"checkedAt":"%s","macos":"%s","arch":"%s","ready":%s,"t4Status":"%s","checks":[' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MACOS" "$ARCH" \
    "$([ $ready = 1 ] && echo true || echo false)" "$([ $ready = 1 ] && echo 'READY (run the build recipe)' || echo 'NOT VERIFIED (B-iOS)')"
  for i in "${!NAMES[@]}"; do
    [ "$i" -gt 0 ] && printf ','
    printf '{"name":"%s","state":"%s","required":%s,"detail":"%s","fix":"%s"}' "${NAMES[$i]}" "${STATES[$i]}" \
      "$([ "${REQ[$i]}" = 1 ] && echo true || echo false)" "$(esc "${DETAILS[$i]}")" "$(esc "${FIXES[$i]}")"
  done
  printf ']}\n'
else
  echo "Nuzm iOS build prerequisites (read-only check, $(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "----------------------------------------------------------------"
  for i in "${!NAMES[@]}"; do
    printf '%-9s %-27s %s%s\n' "${STATES[$i]}" "${NAMES[$i]}" "${DETAILS[$i]}" "$([ "${REQ[$i]}" = 1 ] && echo '' || echo '  (optional)')"
    [ -n "${FIXES[$i]}" ] && [ "${STATES[$i]}" != "OK" ] && printf '          fix: %s\n' "${FIXES[$i]}"
  done
  echo "----------------------------------------------------------------"
  if [ $ready = 1 ]; then echo "READY: every required prerequisite is present. Run the recipe in docs/mobile/ios-build-host.md (section Build recipe)."
  else echo "NOT READY: T4 stays NOT VERIFIED (B-iOS). Missing/failing required checks: ${missing_required[*]}"; fi
fi
[ $ready = 1 ] && exit 0 || exit 1
