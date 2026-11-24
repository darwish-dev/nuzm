# iOS build host: Xcode installation, validation and build recipe (T4, B-iOS)

Status: **PLAN + PREREQUISITE CHECKER. T4 is `NOT VERIFIED (B-iOS)`.** The owner's Mac (checked 2026-11-24) is macOS 13.7.8, x86_64, Flutter 3.35.7, **Command Line Tools only: no `xcodebuild`, no CocoaPods**. The read-only checker `infra/mobile/ios/check-prerequisites.sh` reports exactly what is missing; its real output for this Mac is in `docs/mobile/evidence/2026-11-24-ios-prereq-check.json` (LIVE-VERIFIED as a statement about this machine on that date).

Nothing here needs an Apple Developer account. T4 is `flutter build ios --no-codesign` plus an `xcodebuild` simulator build; no signing identity, provisioning profile, App Store Connect or TestFlight step is part of it (that is B-APPLE and is never needed for T4).

## Policy for the macOS host
1. **AI-generated project code never builds as the owner's normal user.** Gradle/Xcode build phases, Podfile hooks and plugin code run during a build. The host is either another Mac, or a **dedicated standard (non-admin) macOS user named `nuzm-build`** on the owner's Mac, with: no iCloud sign-in, no keychain items, no `.ssh`/`.aws`/`.npmrc`/`.netrc`, no browser profile, nothing from the owner's home.
2. The build user is created and the Xcode install is done **by the owner** (admin password, App Store/Apple ID for the download). Agents never create accounts, enter an Apple ID, or accept a licence.
3. Declare the environment in the build user's shell profile: `export NUZM_BUILD_ENV=disposable NUZM_BUILD_ISOLATION=dedicated-user NUZM_BUILD_USER=nuzm-build`. The build engine refuses to run anywhere else (`build-env-guard.ts`; the checker reports `build-host-policy`).
4. A dedicated user is **not** sandbox-class isolation: it shares the kernel, disk and network with the owner's session. Its builds are recorded `isolation: none` and are never presented as isolation evidence. Network egress is not enforced on a Mac (NOT VERIFIED); restrict it with the macOS firewall/pf or run the builds on a separate Mac when the owner wants more.
5. Wipe: delete the build user's `Library/Developer/Xcode/DerivedData`, `~/.pub-cache` and the project working directory after each build (`rm -rf` of those only; the engine's working directories are already temp and removed in `finally`).

## Owner steps (human gates; each is a download or an admin action)
1. **Create the user:** System Settings → Users & Groups → Add User, Standard, name `nuzm-build`, no Apple ID. Log in once.
2. **Install Xcode:** a full Xcode release that runs on macOS 13.x. Apple's published requirement: Xcode 15.x is the last major line for macOS 13 (Xcode 16 needs macOS 14); **confirm against the release notes of the exact version you download** before installing (multi-GB; free; the Mac App Store or developer.apple.com/download/all). Disk: budget ~60 GB (this Mac had 64 GB free at the check: tight; free space first).
3. **Select it and accept the licence (admin):**
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` · `sudo xcodebuild -license accept` · `sudo xcodebuild -runFirstLaunch`
4. **Simulator runtime (optional; only for the launch screenshot):** `xcodebuild -downloadPlatform iOS` (multi-GB).
5. **CocoaPods** (Flutter iOS plugins need it): `brew install cocoapods` (or `sudo gem install cocoapods` if Homebrew is not used) in the build user's session; `pod --version`.
6. **Flutter 3.35.7** for the build user (the project pins it; the build refuses another version): same install as the owner's, under `nuzm-build`'s home.
7. Run `infra/mobile/ios/check-prerequisites.sh`: every REQUIRED row must be `OK`. Tell the build session (P3-S06) the user name.

## Build recipe (to run only after the checker says READY; not run yet)
Run as `nuzm-build`, in a fresh temp directory, on the **template project or a project that passed `analyzeProject`**, never on files that failed the analysis gate.
```bash
flutter --version --machine        # must be 3.35.7 (the build refuses otherwise)
flutter create --platforms=ios --org <org> --project-name <name> .
# apply tool/nuzm-mobile.json: Info.plist usage strings (applyIosPermissions) and the deployment target (applyIosDeploymentTarget), then checkPlatformFiles
flutter pub get
flutter analyze && flutter test
flutter build ios --no-codesign --simulator   # produces build/ios/iphonesimulator/Runner.app
xcodebuild -workspace ios/Runner.xcworkspace -scheme Runner -sdk iphonesimulator -configuration Debug \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build   # second, independent build log
xcodebuild -version; xcrun --sdk iphonesimulator --show-sdk-version             # toolchain versions for the evidence record
# only if a simulator runtime is installed:
xcrun simctl boot "iPhone 15" && xcrun simctl install booted build/ios/iphonesimulator/Runner.app \
  && xcrun simctl launch booted <bundle id> && sleep 5 && xcrun simctl io booted screenshot ios-launch.png
```
Evidence for T4 (all required): `xcodebuild -version` and Flutter version, both build logs (redacted), the `.app` bundle hash (`shasum -a 256` of a tar of the bundle), and, if a runtime exists, the launch screenshot. If Xcode is not installed, **the prerequisite checker's output is the deliverable and T4 stays NOT VERIFIED (B-iOS)**.

## What is already done without Xcode (independent engineering)
- Xcode/Swift/CocoaPods/signing error parser with fixtures (`internal/builds/errors/xcode.ts`; fixtures are SIMULATED: the first real run must add captured logs).
- Declarative iOS settings: `ios.deploymentTarget` and Info.plist usage strings for declared permissions; ATS cleartext exception refused (`internal/flutter/platform-config.ts`, unit-tested on the file shapes `flutter create` writes).
- The analysis gate rejects `ios/` files, Podfiles, `.xcodeproj`/`.pbxproj` and signing material in any generated project.
- Not done and not claimable: `flutter create --platforms=ios` + `flutter build ios` need nothing beyond Xcode, but were **not run** (no Xcode); the `MacosIosRunner` is only written when a host exists to test it against.
